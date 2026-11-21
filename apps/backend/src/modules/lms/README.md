# LMS module — lab-job pipeline

The **Lab Management System** turns a placed Medusa order into a durable
`lab_job` row and (once a lab partner is wired) submits it to the lab
provider. It is the **only** path through which decrypted prescription data
leaves Supabase.

## The wire contract — metadata is the single source of truth

The storefront stamps everything the lab needs onto Medusa **metadata** at
checkout (Website repo `src/lib/cart/to-medusa.ts`). `buildLabJobPacket`
reads that metadata and nothing else — it never reconstructs the order from
product joins or heuristics.

### Line-item metadata (per Medusa line)

| key | meaning |
| --- | --- |
| `klear_kind` | `"frame"` \| `"lens"` — the **frame** line is authoritative for the lab. Each cart line materialises as a frame line plus (optionally) a separate lens line so the lens upcharge reaches the order total. |
| `klear_line_id` | correlates the frame + lens halves of one configurator pass |
| `klear_sku` | frame SKU (frame line) |
| `klear_lens_config` | `{ lens_type, index, coating_addons }` or `null` (frame-only) |
| `klear_prescription_id` | Supabase prescription id, or `null` |
| `klear_prescription_sig` | base64url HMAC-SHA256 of the id, computed server-side with `KLEAR_RX_METADATA_SECRET`. `null` exactly when the id is `null`. |
| `klear_prescription_status` | `"active"` \| `"pending"` (per line) |

### Order-level metadata (send-later flow, Website PR #126)

| key | meaning |
| --- | --- |
| `klear_prescription_status` | `"active"` \| `"pending"` — stamped on the cart → order at checkout |
| `klear_prescription_id` | written by `POST /api/order/[id]/prescription` when the customer submits their Rx **after** paying |
| `klear_prescription_sig` | HMAC of the order-level id, stamped by the same route |

### Prescription signature — the PDPA gate

Line/order metadata is **client-controllable** (the Store API accepts
metadata with just a publishable key), so a raw `klear_prescription_id` can
be forged to point at someone else's Rx. The **real** guard is a
server-side ownership check on the storefront: `syncCheckoutCart` (and the
send-later route) prove the caller owns each prescription id — via an
owner-scoped Supabase lookup keyed on the session user (anonymous guest
sessions included) — BEFORE signing it. An attacker's session can't pass
that check for a victim's Rx, so a victim's id is never signed.

The signature (`HMAC-SHA256(prescription_id)` with `KLEAR_RX_METADATA_SECRET`
— shared, server-only, both runtimes; see `.env.template`) is the backend's
proof that an id passed that gate: only the server holds the secret.
`buildLabJobPacket` verifies it (timing-safe, `prescription/rx-signature.ts`)
**before any decrypt**:

- valid signature → proceed to decrypt
- signature **missing** with a present id → `failed` row, reason
  "prescription signature missing — order predates metadata signing or
  storefront stamping failed; manual ops relink required" (legacy orders
  are an ops task, not a security incident)
- signature present but **mismatched** (tamper or secret mismatch) →
  `failed` row, reason "prescription signature invalid — possible
  tampering" (never `pending_rx`)
- `KLEAR_RX_METADATA_SECRET` unset on this server → `failed` row (fail
  closed; config fix + retry heals)

The signature is always checked against the SAME metadata source (line vs
order) that supplied the id. The HMAC is over the id ALONE — deliberately
NOT bound to the customer, because the signing session user (e.g. a guest's
anonymous id) and the order's Medusa customer legitimately diverge across
the guest → account → claim flow; the ownership gate already closes the
oracle, so customer-binding would only break legitimate send-later/claim
orders.

### Prescription resolution order

1. line-item `klear_prescription_id`, else
2. order-level `klear_prescription_id` (send-later Rx submitted post-order), else
3. any `klear_prescription_status === "pending"` → **pending_rx** (waiting, not broken), else
4. an Rx-requiring lens with no id → **failed**.

## Lens vocabulary

`LensType` mirrors the frontend `LensTypeKey` exactly
(`non_prescription`, `single_vision`, `progressive_standard`,
`progressive_premium`, `progressive_elite`, `readers`, `polarised_sport`).
An unknown/missing lens type is **never** silently defaulted — it produces a
`failed` row. `non_prescription` (plano) is the only type that needs no
prescription; its packet carries `prescription: null`.

## PD is always monocular

`DecryptedPrescription` exposes `pd_right` / `pd_left` (per-eye). Monocular
source values are kept as-is; a binocular-only Rx is split 50/50 into both
eyes at decrypt time (`supabase-vault.ts`). The lab/edger never receives a
summed binocular PD. KLEAR.md §10.

## Durable failure visibility

`buildLabJobPacket` returns a discriminated `BuildPacketResult`
(`ok` / `skip` / `pending_rx` / `failed`) instead of throwing. The
`order.placed` subscriber persists a row for every outcome except `skip`, so
ops always sees the state in `/admin/lab-jobs`:

| outcome | row status | notes |
| --- | --- | --- |
| `ok` | `queued` → `submitting` → `submitted` | submitted immediately if a provider is wired |
| `pending_rx` | `pending_rx` | awaiting the send-later Rx; reason in `last_error` |
| `failed` | `failed` | reason in `last_error`; heals via `/retry` |
| `skip` | *(no row)* | frame-only order — `console.info` only |

Multi-pair orders (more than one `klear_kind: "frame"` line, **or** a single
frame line with `quantity > 1`) are a durable `failed` row at MVP — never a
silent single-pair job for a customer who paid for two.

## Idempotency

`order.placed` can be redelivered. Two layers:

1. **Row**: read-before-create existence check + a **partial unique index**
   on `lab_job (order_id) WHERE deleted_at IS NULL` — a concurrent duplicate
   insert hits a unique violation which the service catches and resolves to
   the existing row. The index is declared on the DML model (do not remove —
   see the comment in `models/lab-job.ts`), in the migration, and in the
   module snapshot.
2. **Submission**: before calling the provider, `submitJob` CLAIMS the job
   with a status-guarded update (`queued` → `submitting`, matched on the
   current status). A racing caller whose claim affects zero rows gets
   outcome `already_submitting` and never touches the provider.

## Retry heals

`POST /admin/lab-jobs/[id]/retry` **re-runs** `buildLabJobPacket` against the
current order metadata before submitting. A `submitted` job is an idempotent
no-op; a `submitting` job (claim in flight) returns 409. This is the heal path: a
`pending_rx` job whose Rx has since landed (now on the order metadata), or a
`failed` job whose metadata/prescription was fixed, is rebuilt and — only if
the rebuild yields a full packet — submitted.

The same rebuild runs automatically for every `pending_rx` job every 30
minutes (`src/jobs/heal-pending-rx.ts`). The sweep pages through **all**
`pending_rx` jobs (`listAllJobIdsByStatus`, ids only, never the snapshot), not
a capped page: a capped oldest-first page would return the same never-answered
jobs every run and never reach newer ones. A job whose Medusa order no longer
exists becomes `failed` ("order … not found") instead of erroring on every
pass.

`GET /admin/lab-jobs` lists newest first; with `?status=` it lists that
status oldest first (the work queue). Both cap at `?limit=` (default 100, max
500).

## PDPA boundary

`packet_snapshot` holds plaintext Rx because the lab needs it. Never log it,
never put it in audit payloads, never expose it from the Store API. Decrypt
is fenced inside the `prescription` module's `decryptForLabHandoff()`.

## How long the readable prescription is kept

`lab_job.packet_snapshot` holds the prescription in plain form because the
lab needs it. The canonical record (Supabase `prescriptions`) is encrypted
and deleted after two years; the snapshot had no end of life.

The scheduled job `src/jobs/redact-lab-job-rx.ts` runs once a day and sets
`packet_snapshot.prescription` to `null` (stamping `rx_redacted_at`) when the
job no longer needs it. The rules are one pure function,
`rx-retention.ts`:

| When | Why |
| --- | --- |
| the Medusa order is cancelled (`order.canceled_at`), or the lab job is `cancelled` | it will not be made |
| the order was delivered 60 days ago (`RX_REDACT_AFTER_DELIVERY_DAYS`) | past the 30-day fit guarantee, with margin |
| the job is 180 days old (`RX_REDACT_MAX_AGE_DAYS`) | backstop for an order with no delivery on record |

Delivery is read from the order's Medusa fulfillments: every live fulfillment
must have `delivered_at`, and the latest one starts the clock. A job in
`submitting` is left alone for 24 hours (`RX_SUBMITTING_GRACE_HOURS`); after
that it is treated as orphaned by a crash and follows the same rules.

Only the prescription is blanked. The rest of the snapshot, including the
customer's name, phone and delivery address, stays. A blanked job cannot be
sent to the lab (`submitJob` refuses). For a `queued`, `failed` or
`pending_rx` job the retry route rebuilds the packet from the encrypted
record, which writes the prescription back and clears `rx_redacted_at`; once
the encrypted record itself has been deleted, that rebuild fails. A
`submitted` job cannot be rebuilt, so blanking it is final.

Migration `Migration20261006000100` adds the `rx_redacted_at` column and
blanks, once, the soft-deleted duplicate rows left by
`Migration20260717000100`. The job cannot see soft-deleted rows (no
MedusaService list or update does), and nothing else soft-deletes a lab job.

### What this does not cover

- **A customer cancel is invisible here.** The storefront records it in its
  own `order_state_events`; it does not cancel the Medusa order. So the
  "order is cancelled" rule fires only for an order cancelled in Medusa
  itself, and a customer-cancelled order's snapshot waits for the 180-day
  limit. Closing this needs the storefront cancel to reach the backend.
- **The 180 days run from job creation and never reset.** A send-later order
  delivered late is blanked at day 180 even if that is inside its
  fit-guarantee window. A job still `queued` after 180 days (every job, while
  no lab provider is wired) is blanked again the night after each retry.
- **A `submitted` job blanked by the 180-day limit cannot be restored** (for
  example when the carrier's delivered webhook was missed).
- **A rebuild merges, it does not replace.** A retry whose result is `failed`
  or `pending_rx` leaves any prescription the row already held (it stays
  eligible for blanking). Existing behaviour, not changed here.
- **The snapshot can outlive the encrypted record.** The clocks run from the
  job and the order, not from the prescription. A prescription saved long
  before the order was placed, or erased at the customer's request, can be
  gone from Supabase while an undelivered job's snapshot still has up to 180
  days to run. Closing this needs the prescription's expiry stored on the
  job, or the erasure path calling into this module.
- **Name, phone and address in the snapshot have no end of life.** The same
  details live on the Medusa order.
- **Orders shipped in parts.** Delivery is judged from the fulfillments that
  exist. An order is one pair in one parcel today.

## Production: where the physical job is

`status` describes the packet (built, waiting for a prescription, failed).
`stage` describes the glasses. A job gets its first stage, `ready`, when its
packet builds, and moves from there only through
`LmsModuleService.applyProductionAction`.

1. **Rules** live in `production.ts`: every action, the stages it is allowed
   from, where it leads, and what it records. Pure functions; the full table
   is asserted in `__tests__/production.unit.spec.ts`.
2. **History** is `production_event`, one numbered row per action per job.
   `lab_job.stage`, `stage_since` and `stage_version` are a cache of the
   latest stage-changing row, written in the same transaction.
3. **One writer.** `applyProductionAction` locks the job row, returns the
   first result if the idempotency key was already used, refuses a caller
   whose `expected_version` is stale, then writes the job, the event and any
   usage or cost rows together. `MedusaService` also generates
   `createProductionEvents`, `createLabUsages`, `createLabCosts` and their
   update and delete twins. Do not call them. Triggers refuse update and
   delete on `production_event` and `lab_usage`, and an insert of a row
   that is already soft-deleted (it would sit outside the unique indexes).
   TRUNCATE is not blocked, because Medusa's HTTP integration test runner
   truncates every table between tests.
4. **Errors say little on purpose.** A database failure inside the writer
   comes out as `ProductionWriteError`, built from the error code and
   constraint name only. The driver's own message contains the SQL with its
   values (a lens SKU beside a job id), so it is never passed on.
5. **Lens and frame usage** is `lab_usage`, one row per piece, with the
   reason operations books it under (`order`, `spoilage_replacement`,
   `remake`, `spoilage`, `return_unused`).
6. **An outside lab's quote** is `lab_cost`, one row per send.
7. **Cancelling** sets `stage` and `status` to cancelled in one write.
   `cancelJob` goes through the writer.
8. **A job the lab has started on is not rebuilt.** `updateJobFromBuild`
   (the Retry button and the heal sweep) refuses once the stage is past
   `ready`, because the lab's printed sheet came from the stored packet. A
   changed prescription on such a job will be an `RX_CHANGED` event.
9. **A built job with no stage** (a stage write that failed, or a job made
   by the previous deployment during a deploy) is given one by
   `markStagelessJobsReady`, run by the `heal-pending-rx` job, for jobs up
   to 30 days old. Older jobs predate production and keep no stage.

`lab_usage` and `lab_cost` tie a lens power or a cost to a job. They stay in
this module. What crosses to Klear Operations is totals per release window,
with no job, order, day or time (next section).

Not built yet: the screens. Until they exist, the lab's steps can only be
recorded by calling the routes below directly.

## Following the order

`subscribers/lab-job-order-events.ts` and `order-events.ts` keep a job in
step with its Medusa order. Each is recorded once per fulfillment (or per
order, for a cancel), however often the event arrives, and an order with no
lab job is ignored.

| Medusa event | Action | From | To |
|---|---|---|---|
| `order.fulfillment_created` (a label was booked) | `LABELLED` | `packed` | `labelled` |
| `order.fulfillment_canceled` | `LABEL_CANCELLED` | `labelled` | `packed` |
| `delivery.created` | `DELIVERED` | `labelled` | `delivered` |
| `order.canceled` | `CANCELLED` | any stage before `labelled` | `cancelled` |

`LABEL_CANCELLED` is not in the design's table; without a way back from
`labelled`, a label booked again after a cancel could never be recorded.

An order can have several fulfillments (an accessory, a split parcel, a
claim's replacement). Only the fulfillment whose label moved the job to
`labelled` can cancel that label or deliver the job; events for the others
are refused. If a new label arrives while the job is still marked as
labelled by an earlier fulfillment that is cancelled in Medusa, the lost
cancel is recorded first and the label moves to the new fulfillment.

Limit: the first fulfillment booked for an order whose job is `packed` is
taken to be the glasses. If an accessory on the same order is shipped first,
it labels (and later delivers) the job. This holds while an order is one
parcel; checking the fulfillment's items against the frame comes with the
screens.

A job at `ready` with status `pending_rx` is one whose prescription changed
and whose new packet is not stored yet; its stored packet is the OLD one.
Any screen that shows or prints a packet must check `status`, not only that
a packet exists. The event bus delivers once, so a write that fails for a
passing reason is retried up to three times in the handler; what still
fails is reported and the job is left where it was.

**A label cannot be booked before the job is packed**, when
`LMS_REQUIRE_PACKED_BEFORE_LABEL=true`. A middleware on
`POST /admin/orders/:id/fulfillments` (`api/admin/orders/require-packed.ts`)
answers 409 before Medusa's workflow runs, so nothing is booked with the
carrier. (The workflow's own hook runs after the label exists.) It refuses
a job at any stage before `packed`, and a lens order whose packet was never
built. It lets through a job at `labelled` or `delivered` (another parcel on
the same order), an order with no lab job, and a job from before production.
`POST /admin/fulfillments` (no order route, not used by the order page) is
not covered and emits no order event. The setting
is off by default and must stay off until the lab works in the lab system:
with it on and no way to reach `packed`, no lens order could ship. While it
is off, an event that does not fit the job's stage is logged and nothing
else; while it is on, it is reported as a fault.

**A changed prescription** on a job in production goes through
`applyChangedPrescription` (`rebuild.ts`): build the new packet first, then
record `RX_CHANGED` (back to `ready`, and the cut-or-uncut question if a
lens was issued), then store the new packet. Between the last two the job's
status is `pending_rx`, so the old packet cannot be printed; if storing the
new packet fails, the Retry button or the half-hourly heal sweep finishes
it. Nothing calls it yet; Medusa has no event for a changed prescription,
so it will be a button.

## Routes for the lab

| Route | What it does | Permission |
|---|---|---|
| `GET /admin/lab-queue` | Jobs the lab still has work on, each with its board column and whether it is overdue, and a count per column | `lab_job:read` |
| `GET /admin/lab-reports?weeks=N` | Lenses used per week with spoilage and remake rates, and lenses per job against its remake count. Counts only, no SKU | `lab_job:read` |
| `GET /admin/lab-jobs`, `GET /admin/lab-jobs/:id` | Jobs, as before, now WITHOUT the packet | `lab_job:read` |
| `GET /admin/lab-jobs/:id/production` | A job's state, history and outside-lab quotes, the steps it offers now, and the outside labs already used | `lab_job:read` |
| `POST /admin/lab-jobs/:id/packet` | Shows the packet (the prescription) and records who looked, before it is returned | `lab_job:read` |
| `POST /admin/lab-jobs/:id/actions` | Records one step the lab took | `lab_job:update` |
| `POST /admin/lab-jobs/:id/ops-actions` | Hold and release | `lab_job_ops:update` |
| `POST /admin/lab-jobs/:id/rx-changed` | A changed prescription on a job in production | `lab_job_ops:update` |
| `POST /admin/lab-jobs/:id/retry` | Rebuild a packet, as before | `lab_job_ops:update` |

1. **The packet leaves through one route.** The list and the job routes used
   to return `packet_snapshot`, prescription included, to any admin user
   with nothing recorded. They no longer do.
2. **Who did it** is the signed-in admin user (`auth_context.actor_id`),
   never a field of the request.
3. **Errors.** A rule's refusal is answered with its own plain sentence. Any
   other failure is answered with a fixed sentence and reported with ids
   only: a database error's text can hold a lens SKU beside a job id.
4. **Permissions.** Medusa 2.14.2 ships a role module (`@medusajs/rbac`),
   off by default behind the `MEDUSA_FF_RBAC` feature flag. The permissions
   above are declared on the routes in `api/middlewares.ts`, where Medusa
   reads them. **Medusa enforces them only when that flag is on.** While it
   is off, any signed-in admin user can call these routes, exactly as they
   could call the lab-job routes before. With it on, a user needs a role
   that grants the permission, and a user with no role is refused on every
   route that declares one, which includes Medusa's own order and customer
   routes. Turning it on is a decision for the owner. What it does, read
   from Medusa's code:
   1. It is a feature flag, off by default.
   2. Roles are written into the sign-in token. A role given or taken away
      takes effect at that person's next sign-in.
   3. A Medusa migration script gives every existing admin user the
      built-in super-admin role when migrations run with the flag on.
      Without that, they are refused almost everywhere.
   4. A secret API key carries no role, so with the flag on it is refused
      on every route that declares a permission.
   5. A lab role can only be given `lab_job:read` and the others once those
      policies are registered with `definePolicies`; Medusa removes any
      policy it does not find registered at each start. They are not
      registered yet; that comes with the decision, as does the lab
      permission test, which must pass before any lab account exists.
5. **People only.** A secret API key also signs in on `/admin`. The routes
   that record who did something, or show the packet, refuse it (403).
   The read-only routes (queue, list, job, history) do answer an API key:
   they show order ids, a job's last error and its history, never the
   packet.
6. **A failed save never carries the packet.** Every insert and update of a
   lab job goes through two overridden methods of the service that replace
   the driver's error (the SQL with the packet written in) by one built
   from its error code. The half-hourly sweep, the order-placed subscriber
   and the Retry route used to log and report that text.
7. **A job's last error is plain words.** It is shown on the queue. Reasons
   written by the packet builder are fixed sentences. When a real lab
   provider is wired, store its error code, not its message: a provider
   that echoes the request would put a prescription there.
8. **Every look at a packet is its own record.** A key that was already
   used shows nothing. A job's history does not show anyone's keys.

## Screens

Three pages in Medusa Admin (`src/admin/routes/lab`), reached from "Lab" in
the side menu: the queue board, a job, and reports. What is not drawing is
in `src/admin/lib/lab.ts` and is tested against the production rules.

1. **The screens hold no rules.** The queue route says which column a job
   is in and whether it is overdue (`board.ts`). The job route says which
   steps a job offers, asked of `decide` and of `packetForbids`, the same
   two checks the writer makes. A database test walks every stage and
   packet state and fails if a step is offered that the writer refuses, or
   the other way round. It proves the two agree, not that a rule is
   right, and it leaves out the three steps of item 2.
2. **Two things the offer cannot know from the job alone:** whether a lab
   quote exists or is waiting for an invoice (the job route checks the
   quotes for the invoice) and which lenses were issued (the writer
   refuses a lens that was not).
   1. **A delivered job whose prescription was removed offers no remake**
      and nothing on the screen can rebuild its packet (known gap 2 below).
      A warranty remake after the retention period is not possible yet.
3. **Overdue thresholds are placeholders** (`OVERDUE_AFTER_HOURS`,
   `OVERDUE_WAITING_HOURS` in `board.ts`): one working day per bench step,
   a week at an outside lab, three days for a labelled parcel or a missing
   prescription. The design says they are agreed with the lab before
   go-live. Nobody has agreed these.
4. **The board also lists jobs stuck before production**: a packet that
   failed, or a prescription that has not arrived. Nothing else showed
   them. There is no age limit, so on the first deploy every such job in
   the table appears at once, and one stays until its order is cancelled.
5. **One request, one key.** A key belongs to a step, the job exactly as
   the screen showed it, and what was typed. A second press or a retry
   after a lost connection sends the same key; anything else is a new
   request. After a request that got no answer the screen reloads and says
   the step may have been recorded.
6. **The packet on a screen.** It is kept in the page's memory only. The
   packet route stamps it with the job row's `updated_at`; recording a step
   does not change that, storing or blanking a packet does, and the screen
   drops a packet whose stamp is no longer the job's. The check runs when
   the job is re-read: once a minute while the page is visible, when its
   tab comes back to the front, and after every action on it. Any other write to the job row (a hand-off attempt
   to a lab provider, a changed last error) also drops it, though the
   packet is the same; the person shows it again.
7. **Printing.** "Print packet" records the print before the dialog opens,
   so a cancelled dialog still leaves a print on record. The browser's own
   print leaves the packet off the page, so paper cannot exist with only a
   view on record. A screenshot or a phone photo is outside what software
   can record.
8. **Not built: lens stock on the job screen.** It needs the stock
   snapshot from Klear Operations (the stock feed).
9. **Not built: a person's name in the history.** It shows the admin user
   id. Looking a name up needs Medusa's user route, which a lab role is
   not meant to reach.
10. **A lens SKU box accepts anything shaped like a SKU**, which includes
    `1.25`. The warning beside free-text boxes is the only guard against a
    lens power typed there.

## Release to Klear Operations

1. **Windows** (`release.ts`). A window ends on a fixed weekday
   (`LMS_RELEASE_WEEKDAY`, 0 to 6, Sunday if unset) and on the last day of
   every month. A weekly end within three days before or after a month end
   is skipped, and a weekly end never closes a window under four days old,
   so no window is shorter than four days. The one exception: a month end
   always closes, so the very first window can be short if production
   starts just before one. The cadence is a setting; the shape of what
   crosses is not.
2. **Release** (`releaseDueWindows`, run hourly by the `release-lab-usage`
   job). For each window that has ended in Bangkok and is not yet released,
   in one transaction: a marker row (`lab_release_window`, also for an empty
   window), totals per SKU and reason (`lab_usage_release`), and totals per
   outside lab as of the window's last day (`lab_total_day`). Written once,
   insert-only.
3. **A row belongs to the window in which it was entered**, not the one in
   which the work was done (`lab_usage.entered_on`). The writer and the
   release share a lock, and the writer dates a row after the last released
   window even if its clock is behind, so a row cannot land in a window
   already released. The hourly job also checks that usage and released
   totals agree and reports any difference.
4. **Feed** `GET /ops-feed/lab-releases?after=YYYY-MM-DD&limit=N`, bearer
   secret `KLEAR_OPS_FEED_SECRET` (at least 32 characters; unset means the
   route answers 503). The cursor is a window's end date.
5. **Limit, stated plainly.** At one or two jobs a week a window's totals
   can still point at one order. Weekly totals are much weaker evidence than
   a timestamped event, not none.
6. **Before the first production event** there is no window and no marker.
   Klear Operations must not wait for a marker for a period before the lab
   system started.
7. **Lab names.** Totals are grouped by the lab's name in lower case with
   white space collapsed, and that is the name served. A fixed list of labs
   chosen on the screen is the real fix and comes with the screens.
8. **Open:** a quote whose work came back and is never invoiced (a remake
   the lab does not bill) stays in "back and not invoiced" for good. It
   needs a "written off" action or a decision that it should.
9. **Lab totals assume one clock.** Usage dates are protected against a
   process whose clock runs behind the releasing one; a lab quote's
   timestamps are not. With two processes whose clocks differ, a receipt or
   invoice written just after a release can be missing from that window's
   total. The next window's total includes it (totals are cumulative).
10. **Limit:** totals are 32-bit whole satang, about 21 million baht per lab
   per figure. Past that the release fails loudly every hour until the
   columns are widened.

Known gaps, to be closed with the parts above:

1. `LENS_ISSUED` checks that each SKU is well formed. It cannot yet check
   that it is the right lens for the prescription, because no mapping from a
   prescription to a lens SKU exists in this repository.
2. A warranty remake needs the prescription back in the packet, but the
   retention sweep decides from the order and would blank it again that
   night. Retention must learn to keep a job that is back in production.
3. `remake_count` counts QC and warranty remakes only. A lens reissued after
   a spoil, or after a customer's changed prescription, is not counted, so a
   report of "more lens issues than remakes explain" must allow for those.
4. A job that failed QC at an outside lab and is then made in-house books
   its lens as a spoilage replacement, although no Klear lens was spoiled.
5. Free-text fields (a note, a hold or QC reason) are where a person could
   type a prescription. The screens must say not to.
6. When one lens of a pair goes back uncut and the other had been cut, the
   pair issued next is booked to the order; the lost lens is not booked as
   a remake.
7. The stage sweep reports each job it cannot set as its own error. If the
   stage write failed for every job, that is one report per job per pass.
8. The database tests import `pg`, which this package does not declare; it
   resolves through the workspace's hoisted install.

## Database tests

All database suites run from one file, `__tests__/lms.db.spec.ts` (each
suite is a `*.db-suite.ts` function; see the note at the top of that file
for why). They run against a real Postgres whose schema is built by
running this module's migration files in order (`__tests__/db-harness.ts`),
which is what a deploy does. CI starts a Postgres for them. Locally, point
them at any Postgres you can create a database on:

```bash
DB_HOST=localhost DB_PORT=5432 DB_USERNAME=postgres DB_PASSWORD=postgres npm run test:db
```

They create and reuse one database, `medusa_lms_test`, and drop its `public`
schema before every test. Never point them at a database you care about.
