import { model } from "@medusajs/framework/utils";

/**
 * `lab_job` — one row per lab-handoff attempt for a Medusa order.
 *
 * Lifecycle:
 *   queued    — created locally; not yet submitted to the lab provider
 *   submitted — provider accepted the job; provider_job_id populated
 *   failed    — provider rejected (with last_error); will retry per policy
 *   cancelled — order was cancelled before lab production started
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
});

export default LabJob;
