import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import { authorizeOpsFeed } from "../auth";

/**
 * GET /ops-feed/lab-releases?after=YYYY-MM-DD&limit=N
 *
 * Contract 2 (production usage and lab totals), read by the feed poller in
 * Klear Operations. Returns released windows whose last day is after
 * `after`, oldest first. Each window is complete: its usage totals per SKU
 * and reason, and the lab totals as of its last day. A window with no usage
 * is still returned; it is the "release marker".
 *
 *   { windows: [ { window_end, released_at,
 *                  usage:      [ { id, sku, reason, net_qty } ],
 *                  lab_totals: [ { id, vendor, as_of,
 *                                  quoted_uninvoiced_satang,
 *                                  invoiced_to_date_satang,
 *                                  written_off_satang } ] } ],
 *     next_after }
 *
 * `written_off_satang` is the quoted value the lab will not invoice (written
 * off, and not invoiced since) as of that day; it is no longer in
 * `quoted_uninvoiced_satang`. 0 in windows released before write-offs
 * existed. Never the reason, nor who wrote it off.
 *
 * The cursor is the last window's end date; pass it back as `after`.
 * Released windows never change, so re-reading is always safe.
 *
 * What must never appear here: a job, an order, a day or time of use, a
 * prescription, or a cost tied to a job. The response is built field by
 * field from the three release tables, and the caller cannot ask for fields.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeOpsFeed(req, res)) return;

  const rawAfter = req.query.after;
  let after: string | null = null;
  if (rawAfter !== undefined && rawAfter !== "") {
    if (typeof rawAfter !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawAfter)) {
      res.status(400).json({ error: "after must be a date, YYYY-MM-DD" });
      return;
    }
    after = rawAfter;
  }
  const rawLimit = req.query.limit;
  const limit =
    typeof rawLimit === "string" ? Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200) : 50;

  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
  const windows = await lms.listReleasedWindows(after, limit);
  res.json({
    windows,
    next_after: windows.length > 0 ? windows[windows.length - 1].window_end : after,
  });
}
