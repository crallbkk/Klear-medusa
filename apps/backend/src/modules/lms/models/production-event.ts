import { model } from "@medusajs/framework/utils";

/**
 * `production_event`: the history of a lab job. One row per thing that
 * happened, numbered per job. Insert-only: a database trigger refuses update
 * and delete (Migration20261120000100), and the only writer is
 * `LmsModuleService.applyProductionAction`.
 *
 * `detail` holds what the action recorded (a lens SKU, a reason, a quote).
 * It never holds a prescription value.
 */
const ProductionEvent = model
  .define("production_event", {
    id: model.id({ prefix: "prodevt" }).primaryKey(),
    lab_job_id: model.text(),
    seq: model.number(),
    action: model.text(),
    from_stage: model.text().nullable(),
    // Null for an action that does not move the job (a note, a hold).
    to_stage: model.text().nullable(),
    // Made by the screen when it renders the action, so a repeated press or
    // a retried request returns the first result instead of acting twice.
    idempotency_key: model.text(),
    // "user" (a Medusa admin user id in actor_id) or "system".
    actor_type: model.text(),
    actor_id: model.text(),
    // When it happened, if entered after the fact from the paper log.
    // Null means "when it was entered" (created_at).
    happened_at: model.dateTime().nullable(),
    detail: model.json(),
    // A digest of what the caller sent (details and time). A repeat of the
    // key with different contents is refused instead of being answered with
    // the first result. Null on rows written by the migration.
    request_hash: model.text().nullable(),
  })
  .indexes([
    { name: "UQ_production_event_job_seq", on: ["lab_job_id", "seq"], unique: true },
    { name: "UQ_production_event_idempotency_key", on: ["idempotency_key"], unique: true },
  ]);

export default ProductionEvent;
