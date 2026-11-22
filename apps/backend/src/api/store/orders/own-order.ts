// `GET /store/orders/:id` answers only the signed-in customer who owns the
// order.
//
// Medusa's own route has no sign-in and no ownership check (its source
// carries a note asking whether it should). Anyone who presents an order's
// id is given that order: email, delivery address, phone, items, totals. An
// order id is a long random string and is not listed anywhere public, which
// was the only protection. The website already assumes the route answers
// "not found" for someone else's order, and its order, cancel, refund and
// prescription pages lean on that; this makes it true.
//
// A caller who is not the owner gets the same 404 a missing order gets, so
// the answer does not say whether the order exists.

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";

/**
 * Medusa's order-transfer routes (`POST /store/orders/:id/transfer/request`,
 * `cancel`, `accept`, `decline`) are switched off.
 *
 * `request` and `cancel` answer with the whole order to ANY signed-in
 * customer who is not its owner: the only check is "you have an account
 * and this is not already yours". With the single-order route closed, a
 * free account and one of these would open it again. The website does not
 * use Medusa's transfers, so they are refused outright, before Medusa's own
 * handler runs. The answer is the same for every order id, existing or not.
 */
export function refuseOrderTransfers(
  _req: MedusaRequest,
  res: MedusaResponse,
  _next: MedusaNextFunction,
): void {
  res.status(404).json({ type: "not_found", message: "Order transfers are not available" });
}

export async function requireOrderOwner(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const id = req.params?.id;
  const notFound = (): void => {
    res.status(404).json({ type: "not_found", message: `Order with id: ${id} was not found` });
  };
  // Medusa's sign-in check for /store lets a caller through without a
  // sign-in; a customer's token, when sent, is read into `auth_context`.
  const auth = (req as { auth_context?: { actor_id?: string; actor_type?: string } }).auth_context;
  if (!auth?.actor_id || auth.actor_type !== "customer") {
    res.status(401).json({ type: "unauthorized", message: "Sign in to see this order" });
    return;
  }
  if (typeof id !== "string" || id === "") {
    notFound();
    return;
  }
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "customer_id"],
    filters: { id },
  });
  const order = (data ?? [])[0] as { customer_id?: string | null } | undefined;
  // Compared as two present values: an order with no customer belongs to
  // nobody who can sign in.
  if (!order || !order.customer_id || order.customer_id !== auth.actor_id) {
    notFound();
    return;
  }
  next();
}
