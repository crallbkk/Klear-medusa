import { model } from "@medusajs/framework/utils";

/**
 * `lab_job` — one row per lab-handoff attempt for a Medusa order.
 *
 * Lifecycle:
 *   queued     — packet built OK; not yet submitted to the lab provider
 *   submitted  — provider accepted the job; provider_job_id populated
 *   pending_rx — customer paid but their send-later prescription hasn't
 *                arrived yet; heals via /retry once the Rx is submitted
 *                (reason carried in last_error). NOT an error state.
 *   failed     — packet build or provider submission failed; reason in
 *                last_error. Ops-visible in /admin/lab-jobs; heals via /retry
 *                once the underlying metadata/prescription is fixed.
 *   cancelled  — order was cancelled before lab production started
 *
 * `packet_snapshot` captures the exact LabJobPacket sent (or planned)
 * for forensic reproducibility. It includes decrypted Rx, so this
 * column is treated as PDPA-sensitive — never logged, never exported
 * outside the lab-handoff path.
 */
const LabJob = model.define("lab_job", {
  id: model.id({ prefix: "labjob" }).primaryKey(),
  // Medusa order id (`order_xxx`). Searchable so admin queue UIs can
  // filter by order.
  order_id: model.text().searchable(),
  // Lifecycle. Stored as text rather than enum so we can add states
  // without an ALTER TYPE migration.
  status: model.text(),
  // The LabJobPacket as actually composed at job-creation time. PDPA
  // sensitive — never log, never include in audit payloads.
  packet_snapshot: model.json(),
  // Provider id once the lab accepts the job. Null while queued.
  provider_job_id: model.text().nullable(),
  // Provider name at submission time. Useful for forensic review when
  // we eventually switch labs.
  provider_name: model.text().nullable(),
  // Number of submission attempts. Caller bumps on each provider.submitJob call.
  attempts: model.number().default(0),
  // Last error message (truncated to 500 chars upstream). Null on success.
  last_error: model.text().nullable(),
  // When the lab provider confirmed receipt (status moved to "submitted").
  submitted_at: model.dateTime().nullable(),
})
  // ── DO NOT REMOVE ──────────────────────────────────────────────────────
  // This partial unique index is idempotency-critical: it is what stops two
  // racing order.placed deliveries from creating two lab jobs for one order
  // (the service catches the 23505 and adopts the existing row). It is ALSO
  // declared in Migration20260717000100 and the module snapshot; declaring
  // it here keeps the model as the source of truth so a future
  // `medusa db:generate` diffs cleanly instead of emitting a DROP INDEX.
  .indexes([
    {
      name: "UQ_lab_job_order_id_active",
      on: ["order_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
  ]);

export default LabJob;
