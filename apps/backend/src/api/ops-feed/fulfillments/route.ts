import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { authorizeOpsFeed } from "../auth";
import { readFulfillmentsPage, type Pg } from "../commerce-db";
import { answerFeedFailure, feedQuery } from "../feed-http";

/**
 * GET /ops-feed/fulfillments?after=<cursor>&limit=N
 *
 * Contract 1, stream 2: fulfillments of orders, read by the feed poller in
 * Klear Operations. Bearer secret `KLEAR_OPS_FEED_SECRET`. Same ordering
 * and cursor rule as the orders stream, with its own cursor.
 *
 *   { fulfillments: [ { id, order_id, created_at, kind,
 *                       quoted_shipping_satang, canceled_at, delivered_at,
 *                       updated_at,
 *                       lines: [ { line_item_id, sku, quantity } ] } ],
 *     next_after, has_more, polled_through }
 *
 * See `src/api/ops-feed/README.md`.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeOpsFeed(req, res)) return;
  const q = feedQuery(req, res);
  if (!q) return;
  try {
    const page = await readFulfillmentsPage(
      { pg: req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION) as unknown as Pg },
      q.after,
      q.limit,
    );
    res.json({
      fulfillments: page.records,
      next_after: page.next_after,
      has_more: page.has_more,
      polled_through: page.polled_through,
    });
  } catch (err) {
    answerFeedFailure(res, "ops-feed/fulfillments", err);
  }
}
