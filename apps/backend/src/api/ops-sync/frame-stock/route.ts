import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { authorizeBearer } from "../../ops-feed/auth";
import { answerFeedFailure } from "../../ops-feed/feed-http";
import { StockSyncBadRequest, parseFrameStockBody, reportFrameStock } from "../frame-stock";

/**
 * POST /ops-sync/frame-stock
 *
 * Contract 5, part 1, report-only (decision D2). Bearer secret
 * `KLEAR_STOCK_SYNC_SECRET`, which opens this route and nothing else.
 *
 *   request  { watermark: "<fulfillments cursor>" | null,
 *              frames: [ { inventory_item_id, on_hand } ] }
 *   response { mode: "report_only",
 *              frames: [ { inventory_item_id, known, medusa_stocked,
 *                          expected, difference, written: false } ] }
 *
 * Writes nothing, ever, in this mode. See `frame-stock.ts`.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeBearer(req, res, "KLEAR_STOCK_SYNC_SECRET")) return;
  let request;
  try {
    request = parseFrameStockBody(req.body);
  } catch (err) {
    if (err instanceof StockSyncBadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  try {
    const frames = await reportFrameStock(
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        pg: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inventory: req.scope.resolve(Modules.INVENTORY) as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        locking: req.scope.resolve(Modules.LOCKING) as any,
      },
      request,
    );
    res.json({ mode: "report_only", frames });
  } catch (err) {
    answerFeedFailure(res, "ops-sync/frame-stock", err);
  }
}
