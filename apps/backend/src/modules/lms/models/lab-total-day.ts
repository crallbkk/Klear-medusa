import { model } from "@medusajs/framework/utils";

/**
 * `lab_total_day`: totals per outside lab as of the end of a release window,
 * for the month-end accrual in Klear Operations. No job and no order.
 *
 *   quoted_uninvoiced_satang  quoted value of work that had come back and
 *                             was not yet invoiced at the end of that day
 *   invoiced_to_date_satang   everything marked invoiced up to that day
 *
 * Insert-only.
 */
const LabTotalDay = model
  .define("lab_total_day", {
    id: model.id({ prefix: "labtot" }).primaryKey(),
    vendor: model.text(),
    as_of: model.text(),
    quoted_uninvoiced_satang: model.number(),
    invoiced_to_date_satang: model.number(),
  })
  .indexes([{ name: "UQ_lab_total_day_vendor_as_of", on: ["vendor", "as_of"], unique: true }]);

export default LabTotalDay;
