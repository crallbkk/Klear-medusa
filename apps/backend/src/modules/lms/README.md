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
6. **An outside lab's quote** is `lab_cost`, one row per send. Its states
   (`quoteState` in `production.ts`): sent, back and not invoiced, written
   off, invoiced.
   1. **Written off** (`LAB_QUOTE_WRITTEN_OFF`, owner's decision of
      2026-11-21): a quote whose work came back and that the lab will never
      invoice (a remake it does not bill). Recorded through the writer like
      every other step, through `POST /admin/lab-jobs/:id/ops-actions` with
      `detail: { lab_cost_id, reason }` and `expected_version`. The pure
      rule `writeOffRefusal` allows it only from "back, not invoiced" and
      refuses with `quote_not_back`, `quote_invoiced` or
      `quote_written_off` (409), or `quote_not_found` (404) for a quote
      that is not this job's. A repeated key answers as a replay.
   2. It does not depend on the job's stage: a cancelled or held job's lab
      work can come back and never be billed. It needs a stage (a job never
      in production has no quote).
   3. **Who, when and why** are on the quote (`written_off_by`,
      `written_off_at`, `written_off_reason`). The reason is free text,
      1 to 300 characters once trimmed (every free-text field is measured
      after trimming), and may name a customer: it is not on
      the event (which names the quote, its lab and quoted amount), not in
      any log, Sentry event, report or feed, and a lab account is not sent
      it. A lab account cannot write a quote off: the step is an ops step
      and the lab gate refuses that route. Nor can it enter the invoice
      that would reverse one (item 6).
   4. **An invoice after a write-off** is still taken and reverses the
      write-off in the same step: the quote counts as invoiced, the
      write-off stays on the quote as it was made, and the LAB_INVOICED
      event says `reversed_write_off` and which quote. There is no other
      undo, as there is none for an invoice.
   5. **An invoice may name its quote** (`detail.lab_cost_id`, optional):
      this job's, not deleted, not invoiced yet (`quote_not_found`,
      `quote_invoiced`). The job screen names it, and asks which when more
      than one quote is waiting. Without a name the writer takes work that
      came back and is not written off, then work that came back and was
      written off, then work that never came back, oldest first within
      each. On a job with no write-off that is the choice it always made.
   6. **Only a full admin enters an invoice** (owner's decision of
      2026-11-25: a lab account never records an outside lab's bill or
      writes one off; it still types the quoted price on SENT_TO_LAB). `LAB_INVOICED` is
      an ops step, through `POST /admin/lab-jobs/:id/ops-actions` with
      `detail: { invoiced_satang, lab_cost_id? }`. The lab's own route
      refuses it (400) and the lab gate refuses a lab account the ops
      route (403), so the job route does not offer a lab account "Enter
      lab invoice". A lab account still sees the invoiced amount on the
      quote.
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
| `POST /admin/lab-jobs/:id/ops-actions` | Hold and release; an outside lab's invoice; writing off a lab quote | `lab_job_ops:update` |
| `POST /admin/lab-jobs/:id/rx-changed` | A changed prescription on a job in production | `lab_job_ops:update` |
| `POST /admin/lab-jobs/:id/retry` | Rebuild a packet, as before | `lab_job_ops:update` |
| `POST /admin/lab-jobs/:id/warranty-remake` | Fetch the prescription back into a labelled or delivered job's packet and start a remake | `lab_job_ops:update` |

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
   refuses a lens that was not). A write-off is offered on each quote, not
   on the job: `actions.write_off` lists the quotes `writeOffRefusal`
   allows, for ops accounts only, and the job screen puts a "Write off"
   button on that quote's row, asking for the reason. A written-off quote
   shows when and by whom (and, for ops, why). A database test walks the
   quote states against the writer (`write-off.db-suite.ts`).
   1. **A warranty remake after the prescription was removed.** The
      readable prescription is blanked from a packet 60 days after
      delivery (the customer's stored, encrypted prescription is kept for
      two years and is not touched by that). A labelled or delivered job
      in that state offers "Start warranty remake" in place of the plain
      remake: `POST /admin/lab-jobs/:id/warranty-remake` builds the packet
      again from the order, which decrypts the stored prescription, puts
      it back, and records REMAKE_STARTED. If the stored prescription is
      gone (erased, or past its two years) the answer is 422 and nothing
      changes.
3. **Overdue thresholds** (`OVERDUE_AFTER_HOURS`, `OVERDUE_WAITING_HOURS`
   in `board.ts`). Glasses made in-house are produced the same day, so a
   bench step, an open cut question or a failed packet is overdue after
   four hours. Still placeholders nobody has agreed: a week at an outside
   lab, three days for a labelled parcel or a missing prescription. The
   clock runs through nights and weekends; a job left at the bench on
   Friday evening is overdue on Monday morning, which is right, and one
   that arrived at 17:55 is flagged at opening time, which is noise.
   1. **On hold means stop.** A held job refuses every step a person takes
      that moves it, until it is released. Notes, a broken frame, a lab
      invoice and what the order itself does (label, delivery, cancel, a
      changed prescription) are still recorded.
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
8. **Not built: lens stock on the job screen.** The snapshot now arrives
   and the live figures are computed (`lensStock`, see "Lens stock"
   below), but a job cannot say which lens SKU it needs: no mapping from a
   prescription to a lens SKU exists (known gap 1). Showing all 277 SKUs
   on every job is a design choice nobody has made.
9. **Not built: a person's name in the history.** It shows the admin user
   id. Looking a name up needs Medusa's user route, which a lab role is
   not meant to reach.
10. **A lens SKU box accepts anything shaped like a SKU**, which includes
    `1.25`. The warning beside free-text boxes is the only guard against a
    lens power typed there.

## Lab accounts

A lab account can use the lab screens and nothing else in Medusa Admin.
This is the gate the design sets before any lab login exists (10.10 items
6 and 7). The code is `src/api/admin/lab-gate.ts`.

1. **How.** One check in front of every admin route (`/admin*`, after
   Medusa's own sign-in check). An account that carries the lab mark is
   answered 403 unless the request is on a short list: the queue, the
   reports, a job, its history, its packet, the lab's steps, and "who am
   I". Every other account passes through exactly as before.
2. **Why not Medusa's role module.** It checks only routes that declare a
   permission, and several of Medusa's own declare none, so it cannot
   promise that a lab login is refused everywhere else. This check refuses
   by default and needs nothing switched on. The `policies` entries on the
   lab routes stay; they do nothing while that module is off.
3. **The mark** is `klear_role: "lab"` in the USER's metadata. The check
   reads it from the database for the signed-in user on every admin
   request (kept for five seconds), not from the sign-in token. Set,
   cleared and listed with:

   ```bash
   LAB_ACCOUNT=list npx medusa exec ./src/scripts/lab-account.ts
   LAB_ACCOUNT_EMAIL=someone@example.com LAB_ACCOUNT=lab  npx medusa exec ./src/scripts/lab-account.ts
   LAB_ACCOUNT_EMAIL=someone@example.com LAB_ACCOUNT=none npx medusa exec ./src/scripts/lab-account.ts
   ```

   1. It is felt within seconds, also by a session that was already open,
      and it holds for every way that user can sign in.
      The email is matched whatever its capitals. Medusa stores an email
      as typed, so `Lab@x.com` and `lab@x.com` can be two users; both are
      marked.
   2. **An account is a full admin account until it is marked.** Create
      the user with `npx medusa user`, mark it, and only then hand over
      the password.
   3. **Never invite a lab person from Settings.** An invited person sets
      their own password and is a full admin from that moment, before
      anyone can mark them. `LAB_ACCOUNT=list` shows every admin account
      and which are lab; run it after adding anyone.
   4. No admin route a lab account can reach changes a user, creates a
      user or a key, or reads an invite. A secret API key is not a user
      and is not confined: a key is full access and is never given to the
      lab.
   5. If the check cannot find out (the database does not answer), the
      request is refused with 503 for everyone, not let through.
4. **What a lab account is shown and can do.**
   1. Not the ops steps: hold and release, an outside lab's invoice,
      writing off a lab quote, a changed prescription, a rebuild, a
      warranty remake. The job route
      does not offer a lab account their buttons, and leaves a write-off's
      reason out of the quotes it shows one.
   2. **Never an order's id.** Medusa's storefront API answers `GET
      /store/orders/<id>` for anyone who presents an order id, with the
      customer's email, address and phone. So every lab route cuts a job
      down to a fixed list of fields for a lab account (`jobFor`,
      `LAB_SEES` in `production-http.ts`), the packet's reference becomes
      the job's own, and the report leaves the order out. The screens
      title a job "Job …" for a lab account and "Order …" for ops.
   3. The packet a lab account is shown still holds the customer's name,
      phone and delivery address beside the prescription: the lab needs
      them, and every look is recorded.
   4. Not a job's `last_error` either. It is free text: older rows name
      the order in it, and a lab provider's rejection could echo the job's
      reference. The board's column already says "packet failed" or
      "waiting for prescription". The packet builder no longer writes an
      order id into a reason.
   5. The packet is cut down to named fields for a lab account (frame,
      lens, coatings, prescription, customer, when it was built). A field
      added to the packet later is not shown to the lab until someone
      adds it to that list.
   6. **What ops types, the lab reads.** A hold reason, a note and a QC
      reason are shown to the lab as written. Do not type an order number
      or a customer's details into them.
   7. A person's idempotency key may hold letters, digits, dot, dash and
      underscore only. The system's own keys carry a colon
      (`ready:<job>`); a key is unique across all jobs, so a person able
      to use one of those could have stopped a job from ever being put at
      ready.
5. **Two requests are answered for the page.** Medusa's admin page asks
   for the store's settings and the notification feed before it draws
   anything, and treats a refusal as a crash. A lab account is given
   neither: the check answers both itself with fixed, empty content, and
   the real routes never run.
6. **Two routes Medusa serves without its sign-in check** (which features
   are on; accepting an invite). On those the check cannot see who is
   calling. Accepting an invite needs the invite's secret token, which a
   lab account cannot create or read. The tests fail if Medusa adds a
   third.
7. **The tests.** A unit test reads every admin route from Medusa's
   installed files and from this project and asserts the rule
   (`src/api/admin/__tests__/lab-gate.unit.spec.ts`). A second test starts
   the whole backend on a scratch database, signs in as a lab account the
   way a person does, and calls every one of those routes over HTTP
   (`integration-tests/http/lab-gate.spec.ts`, `npm run
   test:integration:http`, in CI). A route added by a Medusa upgrade, or
   by us, is covered the day it appears.
8. **Limits, stated plainly.**
   1. The side menu still shows Orders, Products and the rest. Each opens
      to an error for a lab account; nothing is shown. Hiding the entries
      needs a lab-only page, which is not built.
   2. This confines the admin API. Medusa's storefront API hands out an
      order's details to anyone who presents its id (`GET
      /store/orders/<id>`, no sign-in; a known gap in Medusa). That is
      true for everyone, not only the lab, and is why a lab account is
      never given an order id. Closing it for everyone means putting an
      ownership check on that route, which first needs a look at what the
      website's order-confirmation page relies on. Not done here.
   3. The check protects against a lab account, not against an owner: an
      account without the mark can do everything, as before, including
      the ops routes.

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
   outside lab as of the window's last day (`lab_total_day`): quoted value
   back and not invoiced (`quoted_uninvoiced_satang`), invoiced to date
   (`invoiced_to_date_satang`), and quoted value written off and not
   invoiced since (`written_off_satang`). A written-off quote leaves the
   first and is counted in the third from the day it was written off, so
   Operations stops expecting its invoice; a later invoice moves it to the
   second. Windows released before write-offs existed carry 0. Written
   once, insert-only.
3. **A row belongs to the window in which it was entered**, not the one in
   which the work was done (`lab_usage.entered_on`). The writer and the
   release share a lock, and the writer dates a row after the last released
   window even if its clock is behind, so a row cannot land in a window
   already released. The hourly job also checks that usage and released
   totals agree and reports any difference.
4. **Feed** `GET /ops-feed/lab-releases?after=YYYY-MM-DD&limit=N`, bearer
   secret `KLEAR_OPS_FEED_SECRET` (at least 32 characters; unset means the
   route answers 503). The cursor is a window's end date. The commerce
   feed and the stock sync routes beside it are described in
   `src/api/ops-feed/README.md`.
5. **Limit, stated plainly.** At one or two jobs a week a window's totals
   can still point at one order. Weekly totals are much weaker evidence than
   a timestamped event, not none.
6. **Before the first production event** there is no window and no marker.
   Klear Operations must not wait for a marker for a period before the lab
   system started.
7. **Lab names.** Totals are grouped by the lab's name in lower case with
   white space collapsed, and that is the name served. A fixed list of labs
   chosen on the screen is the real fix and comes with the screens.
8. **Written off.** A quote whose work came back and is never invoiced (a
   remake the lab does not bill) is written off (Production, item 6.1),
   which takes it out of "back and not invoiced". The lab report
   (`GET /admin/lab-reports`) counts quotes per lab (grouped as the
   release groups them, named by the lab's most recent spelling): back and
   not invoiced
   (count and quoted amount, whatever their age) and written off in the
   period and not invoiced since (count and quoted amount). Migration
   `Migration20261123000200` adds the columns, written by hand in the shape
   `db:generate` writes, with the module snapshot updated to match.
9. **Lab totals assume one clock.** Usage dates are protected against a
   process whose clock runs behind the releasing one; a lab quote's
   timestamps (a write-off's included) are not. With two processes whose clocks differ, a receipt or
   invoice written just after a release can be missing from that window's
   total. The next window's total includes it (totals are cumulative).
10. **Limit:** totals are 32-bit whole satang, about 21 million baht per lab
   per figure. Past that the release fails loudly every hour until the
   columns are widened.

## Lens stock

Klear Operations sends the lab system lens on-hand per SKU (contract 5,
part 2) to `POST /ops-sync/lens-stock`, bearer secret
`KLEAR_LENS_SNAPSHOT_SECRET` (see `src/api/ops-feed/README.md`).

1. **The snapshot** is `lens_stock_snapshot`, one row per SKU with its
   on-hand and `as_of`: the end of the last usage window Operations had
   applied. Each snapshot replaces the table in one transaction
   (`replaceLensSnapshot`). It is a copy, never a stock record, and nothing
   is written back to Operations or to Medusa's inventory.
2. **Refused**, with nothing changed: a snapshot older than the one held
   (409), so a delayed retry cannot roll the view back; and an `as_of` that
   is not a released window's end once usage exists on or before it (422),
   because the figure and "used since" would then not meet; and an `as_of`
   that is today or later in Bangkok (422 `not_yet_closed`, Bangkok's date
   on the database clock). Without that last rule a future date passed
   while no usage existed, was stored, and then refused every real snapshot
   as older. The same `as_of` again is still a correction: it is always a
   finished day, so a corrected figure for it is a real correction. An
   empty snapshot is refused: an empty shelf is every SKU at zero.
3. **The live figure** (`lensStock`) is the snapshot's on-hand plus the net
   `lab_usage` entered after `as_of` (an issue is -1, an uncut lens put
   back +1). A window takes usage by the date it was entered, so this is
   exactly the usage Operations had not applied.
4. **Privacy.** SKUs and quantities only, in both directions. The figure
   is never tied to a job here.
5. **Migration** `Migration20261123000100` adds the table. Written by hand
   in the shape `medusa db:generate` writes (the generator did not finish
   locally), with the module snapshot updated to match; the database tests
   build the schema from the migration files and read the table through
   Medusa's generated `listLensStockSnapshots`.

Known gaps, to be closed with the parts above:

1. `LENS_ISSUED` checks that each SKU is well formed. It cannot yet check
   that it is the right lens for the prescription, because no mapping from a
   prescription to a lens SKU exists in this repository.
2. Closed for jobs whose packet is ours (`queued`). A warranty remake puts
   the prescription back (see "Screens", item 2.1). How it holds together:
   1. The prescription is stored by the writer in the same transaction as
      the REMAKE_STARTED event, whose detail says `prescription_restored`.
      A refused request stores nothing. Nothing is decrypted for a request
      that can be seen to fail beforehand. Two exceptions: a job that
      moves in the moment between the check and the write, and the same
      request sent twice at once (both fetch; one is recorded).
   2. The writer stamps `lab_job.rx_restored_at` when it puts a
      prescription back, and nothing else sets it. Retention
      (`rx-retention.ts`) reads that stamp: the prescription is kept for
      60 days after it was put back, or, once the remake is delivered
      again, 60 days after that delivery. Moving the job between stages
      does not extend it. A job that was never restored (a remake after a
      QC failure included) is judged exactly as before.
   3. If a remake is still unfinished 60 days after the prescription was
      put back, it is blanked. The lab then works from the sheet it
      printed, or starts the remake again once the job is back at
      labelled or delivered.
   4. The packet is built from the order as it is NOW. If the customer has
      since saved a new prescription on that order's line, the remake is
      made from the new one. The event says the prescription was put back;
      it does not say whether it differs from the first.
   5. Not possible once a lab provider holds the packet (`submitted`), or
      for a job whose packet failed: neither is offered the button.
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
