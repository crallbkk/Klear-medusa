import { model } from "@medusajs/framework/utils";

/**
 * `lab_release_window`: one row per release window, written when the window
 * is released, also when it is empty. This is the "release marker": Klear
 * Operations will not close a month until the marker for its last window
 * has arrived. Insert-only.
 */
const LabReleaseWindow = model
  .define("lab_release_window", {
    id: model.id({ prefix: "labwin" }).primaryKey(),
    // Bangkok calendar dates, "YYYY-MM-DD", both inclusive.
    window_start: model.text(),
    window_end: model.text(),
    released_at: model.dateTime(),
  })
  .indexes([{ name: "UQ_lab_release_window_end", on: ["window_end"], unique: true }]);

export default LabReleaseWindow;
