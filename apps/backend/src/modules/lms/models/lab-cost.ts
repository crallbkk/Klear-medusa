import { model } from "@medusajs/framework/utils";

/**
 * `lab_cost`: an outside lab's quote for one job, opened when the job is
 * sent out. One row per send, so a remake sent out again has its own.
 * Amounts are whole satang.
 *
 * Stays inside the lab system: a cost tied to a job never crosses to Klear
 * Operations. Only totals per vendor do.
 *
 * States (`quoteState` in production.ts): sent, back and not invoiced,
 * written off, invoiced.
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
    // A quote whose work came back and that the lab will never invoice (a
    // remake it does not bill). Who wrote it off, when, and why. The reason
    // is free text and may name a customer: it stays on this row, never in
    // an event, a log line, a report or the feed to Operations. A later
    // invoice reverses the write-off and leaves these as they were.
    written_off_at: model.dateTime().nullable(),
    written_off_by: model.text().nullable(),
    written_off_reason: model.text().nullable(),
  })
  .indexes([{ name: "IDX_lab_cost_job", on: ["lab_job_id"] }]);

export default LabCost;
