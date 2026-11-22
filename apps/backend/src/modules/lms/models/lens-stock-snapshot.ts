import { model } from "@medusajs/framework/utils";

/**
 * `lens_stock_snapshot`: lens on-hand per SKU as Klear Operations last sent
 * it (contract 5, part 2), one row per SKU. The whole table is replaced by
 * each snapshot; it is a copy of the stock ledger's figure, never a stock
 * record of its own. Nothing here is written back anywhere.
 *
 * `as_of` is the end of the last usage release window Operations had
 * applied when it took the figure. The lab's live view is that figure plus
 * the usage entered after that date (`LmsModuleService.lensStock`).
 *
 * SKUs and quantities only: nothing ties a row to a job, an order or a
 * person.
 */
const LensStockSnapshot = model
  .define("lens_stock_snapshot", {
    id: model.id({ prefix: "lenssnap" }).primaryKey(),
    sku: model.text(),
    on_hand: model.number(),
    // A Bangkok calendar date, "YYYY-MM-DD": a released window's end.
    as_of: model.text(),
  })
  .indexes([{ name: "UQ_lens_stock_snapshot_sku", on: ["sku"], unique: true }]);

export default LensStockSnapshot;
