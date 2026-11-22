import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE, LensSnapshotRefused } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import { authorizeBearer } from "../../ops-feed/auth";
import { answerFeedFailure } from "../../ops-feed/feed-http";
import { StockSyncBadRequest } from "../frame-stock";
import { parseLensSnapshotBody } from "../lens-stock";

/**
 * POST /ops-sync/lens-stock
 *
 * Contract 5, part 2: Klear Operations sends the lab system lens on-hand
 * per SKU as of the last usage window it applied. Bearer secret
 * `KLEAR_LENS_SNAPSHOT_SECRET`, which opens this route and nothing else.
 *
 *   request  { as_of: "YYYY-MM-DD", lenses: [ { sku, on_hand } ] }
 *   response { as_of, stored }
 *   409      a newer snapshot is held (type older_than_stored)
 *   422      as_of is not a released window's end (type not_a_release),
 *            or has not ended yet in Bangkok (type not_yet_closed)
 *
 * The snapshot replaces the one held. It is shown to the lab, never written
 * back, and never touches Medusa's inventory.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeBearer(req, res, "KLEAR_LENS_SNAPSHOT_SECRET")) return;
  let request;
  try {
    request = parseLensSnapshotBody(req.body);
  } catch (err) {
    if (err instanceof StockSyncBadRequest) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const stored = await lms.replaceLensSnapshot(request.as_of, request.lenses);
    res.json({ as_of: request.as_of, stored });
  } catch (err) {
    if (err instanceof LensSnapshotRefused) {
      res.status(err.code === "older_than_stored" ? 409 : 422).json({ type: err.code, message: err.message });
      return;
    }
    answerFeedFailure(res, "ops-sync/lens-stock", err);
  }
}
