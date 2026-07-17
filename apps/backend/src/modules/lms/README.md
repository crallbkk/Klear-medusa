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
| `klear_prescription_status` | `"active"` \| `"pending"` (per line) |

### Order-level metadata (send-later flow, Website PR #126)

| key | meaning |
| --- | --- |
| `klear_prescription_status` | `"active"` \| `"pending"` — stamped on the cart → order at checkout |
| `klear_prescription_id` | written by `POST /api/order/[id]/prescription` when the customer submits their Rx **after** paying |

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
| `ok` | `queued` → `submitted` | submitted immediately if a provider is wired |
| `pending_rx` | `pending_rx` | awaiting the send-later Rx; reason in `last_error` |
| `failed` | `failed` | reason in `last_error`; heals via `/retry` |
| `skip` | *(no row)* | frame-only order — `console.info` only |

## Idempotency

`order.placed` can be redelivered. The subscriber does a read-before-create
existence check, and a **partial unique index** on `lab_job (order_id) WHERE
deleted_at IS NULL` backstops the race: a concurrent duplicate insert hits a
unique violation which the service catches and resolves to the existing row.

## Retry heals

`POST /admin/lab-jobs/[id]/retry` **re-runs** `buildLabJobPacket` against the
current order metadata before submitting. This is the heal path: a
`pending_rx` job whose Rx has since landed (now on the order metadata), or a
`failed` job whose metadata/prescription was fixed, is rebuilt and — only if
the rebuild yields a full packet — submitted.

## PDPA boundary

`packet_snapshot` holds plaintext Rx because the lab needs it. Never log it,
never put it in audit payloads, never expose it from the Store API. Decrypt
is fenced inside the `prescription` module's `decryptForLabHandoff()`.
