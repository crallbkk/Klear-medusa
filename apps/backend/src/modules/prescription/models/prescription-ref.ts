import { model } from "@medusajs/framework/utils";

/**
 * `prescription_ref` — link between a Medusa order and a Klear-side
 * prescription stored in Supabase.
 *
 * Medusa never sees plaintext Rx data. This row is just the pointer:
 * given a Medusa `order_id`, the LMS module can look up the
 * `prescription_id` and then fetch + decrypt the actual Rx from
 * Supabase via the Vault RPC at lab-handoff time.
 *
 * One row per (order, prescription) — typically one prescription per
 * order, but the schema doesn't enforce a unique constraint on
 * `order_id` because a future flow could legitimately attach more
 * than one (e.g. order with two pairs at different Rx). Until that
 * exists, callers should treat it as effectively unique.
 */
const PrescriptionRef = model.define("prescription_ref", {
  id: model.id({ prefix: "rxref" }).primaryKey(),
  // Medusa order id (`order_xxx`). Stored as text — no FK across module
  // boundaries; Medusa v2 modules use service-level joins via module links.
  order_id: model.text().searchable(),
  // Klear-side prescription id — UUID from Supabase `prescriptions.id`.
  prescription_id: model.text(),
});

export default PrescriptionRef;
