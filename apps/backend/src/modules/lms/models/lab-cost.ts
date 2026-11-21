import { model } from "@medusajs/framework/utils";

/**
 * `lab_cost`: an outside lab's quote for one job, opened when the job is
 * sent out. One row per send, so a remake sent out again has its own.
 * Amounts are whole satang.
 *
 * Stays inside the lab system: a cost tied to a job never crosses to Klear
 * Operations. Only totals per vendor do.
 */
const LabCost = model
  .define("lab_cost", {
    id: model.id({ prefix: "labcost" }).primaryKey(),
    lab_job_id: model.text(),
    vendor: model.text(),
    quoted_satang: model.number(),
    expected_on: model.text().nullable(),
    sent_event_id: model.text(),
    received_at: model.dateTime().nullable(),
    invoiced_satang: model.number().nullable(),
    invoiced_at: model.dateTime().nullable(),
  })
  .indexes([{ name: "IDX_lab_cost_job", on: ["lab_job_id"] }]);

export default LabCost;
