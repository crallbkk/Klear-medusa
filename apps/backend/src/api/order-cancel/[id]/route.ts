import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { authorizeBearer } from "../../ops-feed/auth";
import { ORDER_ID, cancelUnfulfilledOrder } from "../cancel";

/**
 * POST /order-cancel/:id: the Website cancels one Medusa order that has not
 * shipped (contract 7, `order-cancel-v1`). Behind its own secret,
 * `KLEAR_ORDER_CANCEL_SECRET`, which opens this route and nothing else. No
 * body is read. See `../cancel.ts` for the answers.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  if (!authorizeBearer(req, res, "KLEAR_ORDER_CANCEL_SECRET", { error: "not configured" })) return;
  const id = String(req.params?.id ?? "");
  if (!ORDER_ID.test(id)) {
    res.status(400).json({ outcome: "invalid_order_id" });
    return;
  }
  const answer = await cancelUnfulfilledOrder(req.scope, id);
  res.status(answer.status).json(answer.body);
}
