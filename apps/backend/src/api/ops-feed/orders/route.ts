import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { authorizeOpsFeed } from "../auth";
import { readOrdersPage, type Pg } from "../commerce-db";
import { answerFeedFailure, feedQuery } from "../feed-http";

/**
 * GET /ops-feed/orders?after=<cursor>&limit=N
 *
 * Contract 1, stream 1: orders, read by the feed poller in Klear
 * Operations. Bearer secret `KLEAR_OPS_FEED_SECRET`. Records come by
 * (updated_at, id) ascending, after the cursor, and none updated in the last
 * 60 seconds. Each order is served as it was placed (its version-1 rows).
 *
 *   { orders: [ { id, display_id, cart_id, placed_at, currency_code,
 *                 item_total_satang, discount_total_satang,
 *                 shipping_total_satang, total_satang, canceled_at,
 *                 sales_channel_id, version, updated_at,
 *                 lines: [ { id, sku, description, quantity,
 *                            gross_satang, discount_satang } ] } ],
 *     next_after, has_more, polled_through }
 *
 * See `src/api/ops-feed/README.md` for the cursor rule and what never
 * crosses.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeOpsFeed(req, res)) return;
  const q = feedQuery(req, res);
  if (!q) return;
  try {
    const page = await readOrdersPage(
      { pg: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg },
      q.after,
      q.limit,
    );
    res.json({
      orders: page.records,
      next_after: page.next_after,
      has_more: page.has_more,
      polled_through: page.polled_through,
    });
  } catch (err) {
    answerFeedFailure(res, "ops-feed/orders", err);
  }
}
