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
 *
 * The decrypted Rx does not stay there for good: the `redact-lab-job-rx`
 * scheduled job blanks `packet_snapshot.prescription` once the job no
 * longer needs it and stamps `rx_redacted_at` (rules in `rx-retention.ts`).
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
  // When the readable prescription in packet_snapshot was blanked. Null
  // while the snapshot may still hold one. A rebuild (retry) clears this.
  rx_redacted_at: model.dateTime().nullable(),
  // When the readable prescription was put back to start a warranty
  // remake. Null on a job that never had one. See `rx-retention.ts`.
  rx_restored_at: model.dateTime().nullable(),

  // ── Production (see production.ts) ─────────────────────────────────────
  // Where the physical job is. Null until the packet is built. A cache of
  // the latest stage-changing row in production_event, written in the same
  // transaction as that row; never written anywhere else.
  stage: model.text().nullable(),
  stage_since: model.dateTime().nullable(),
  // Bumped on every stage change. An action names the version it saw and is
  // refused if the job has moved since (remake loops revisit stages, so the
  // stage alone cannot tell).
  stage_version: model.number().default(0),
  // The sequence number of the job's latest production event.
  event_seq: model.number().default(0),
  remake_count: model.number().default(0),
  on_hold: model.boolean().default(false),
  hold_reason: model.text().nullable(),
  // A lens was issued and the job was then cancelled or its prescription
  // changed: someone must say whether the lens had been cut.
  cut_question_pending: model.boolean().default(false),
  // The reason the next lens issue is booked under: order,
  // spoilage_replacement or remake.
  next_issue_reason: model.text().default("order"),
  // Warranty remakes started after the glasses were labelled or delivered.
  warranty_remakes: model.number().default(0),

  // ── What the Website shows (contract 6, see projection.ts) ─────────────
  // The Website state of the latest stage that has one, its sequence (the
  // stage_version it was reached at) and when it happened. Written by the
  // production writer in the same transaction as the stage, never elsewhere.
  projection_state: model.text().nullable(),
  projection_seq: model.number().default(0),
  projection_at: model.dateTime().nullable(),
  // When this server recorded that state (its own clock; projection_at can
  // be a back-dated paper-log time). The 30-day give-up counts from here.
  projection_recorded_at: model.dateTime().nullable(),
  // The highest sequence the Website has taken. Below projection_seq means
  // the latest state is still to be sent (the heal sweep sends it again).
  projection_sent_seq: model.number().default(0),
  // When the latest state was last sent and not taken; how many of those
  // answers said the Website does not know the order yet; and when sending
  // it was given up (reported once). All three reset with a new state.
  projection_attempted_at: model.dateTime().nullable(),
  projection_not_ready_count: model.number().default(0),
  projection_gave_up_at: model.dateTime().nullable(),
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
