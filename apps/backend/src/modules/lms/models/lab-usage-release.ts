import { model } from "@medusajs/framework/utils";

/**
 * `lab_usage_release`: what crosses to Klear Operations. One row per release
 * window, SKU and reason: the net number of pieces. No job, no order, no day
 * and no time of day, so a lens power cannot be lined up with an order.
 * Written once per window and never changed. Insert-only.
 */
const LabUsageRelease = model
  .define("lab_usage_release", {
    id: model.id({ prefix: "labrel" }).primaryKey(),
    window_end: model.text(),
    sku: model.text(),
    reason: model.text(),
    net_qty: model.number(),
  })
  .indexes([
    {
      name: "UQ_lab_usage_release_window_sku_reason",
      on: ["window_end", "sku", "reason"],
      unique: true,
    },
  ]);

export default LabUsageRelease;
