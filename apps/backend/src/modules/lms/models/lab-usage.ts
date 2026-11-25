import { model } from "@medusajs/framework/utils";

/**
 * `lab_usage`: a lens (or a frame broken in the lab) leaving or returning to
 * the shelf, one row per piece. Insert-only, written with its production
 * event in one transaction.
 *
 * This table stays inside the lab system. It ties a lens power to a job,
 * which is health data. Only weekly totals per SKU and reason are released
 * to Klear Operations, with no job, order, day or time.
 */
const LabUsage = model
  .define("lab_usage", {
    id: model.id({ prefix: "labuse" }).primaryKey(),
    lab_job_id: model.text(),
    production_event_id: model.text(),
    sku: model.text(),
    // order | spoilage_replacement | remake | spoilage | return_unused
    reason: model.text(),
    // -1 for a piece used, +1 for an uncut lens put back.
    qty: model.number(),
    // The Bangkok calendar date the row was entered (not when the work was
    // done), "YYYY-MM-DD". A release window takes rows by this date.
    entered_on: model.text(),
  })
  .indexes([
    { name: "IDX_lab_usage_entered_on", on: ["entered_on"] },
    { name: "IDX_lab_usage_event", on: ["production_event_id"] },
  ]);

export default LabUsage;
