import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows";
import { captureException } from "../../lib/observability/sentry";
import { failureKind } from "../../modules/lms/service";

/**
 * Contract 7 (`order-cancel-v1`): the Website cancels one Medusa order that
 * has not shipped, before it refunds the customer (design 8.3 item 8, choice
 * R11). Cancelling releases the frame's reservation, and Medusa's
 * `order.canceled` event takes the lab job off the queue
 * (`subscribers/lab-job-order-events.ts`).
 *
 * Answers (the fixture `contracts/order-cancel-v1.json` lists them):
 *
 *   200 cancelled            the order is cancelled now
 *   200 already_cancelled    it was already: a retry is a success
 *   409 refused / fulfilled  a shipping label exists (a fulfillment that is
 *                            not cancelled). The Website does not refund
 *                            through its cancel path: the case is a return.
 *   409 refused / completed  the order is completed: also a return
 *   409 refused / not_cancellable  any other status (draft, archived)
 *   404 not_found            no such order
 *   500 error                anything else; nothing was changed, try again
 *
 * Never more than the order id, the outcome and a reason: no customer data,
 * and nothing of an error's text.
 *
 * Money: Medusa's cancel workflow writes refund or payment-cancel records
 * against its own system payment provider, which moves nothing. The real
 * refund is the Opn refund the Website makes after this answers success.
 */

/** A Medusa order id. A `pending_cart_completion:` placeholder is not. */
export const ORDER_ID = /^order_[A-Za-z0-9]{1,64}$/;

export type CancelAnswer = { status: number; body: Record<string, string> };

type OrderRead = {
  id: string;
  status: string;
  fulfillments?: Array<{ id: string; canceled_at: string | Date | null } | null> | null;
};

/** Statuses an order can be cancelled from. */
const CANCELLABLE = new Set(["pending", "requires_action"]);

async function readOrder(container: MedusaContainer, orderId: string): Promise<OrderRead | null> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "order",
    fields: ["id", "status", "fulfillments.id", "fulfillments.canceled_at"],
    filters: { id: orderId },
  });
  return ((data ?? [])[0] as OrderRead | undefined) ?? null;
}

/** What the order as it stands says, or null when it can be cancelled.
 *  Fulfillments are checked before reporting a cancel as done: a cancelled
 *  order with a fulfillment that is not cancelled is answered as refused. */
function standing(orderId: string, order: OrderRead | null): CancelAnswer | null {
  if (!order) return { status: 404, body: { order_id: orderId, outcome: "not_found" } };
  if (hasLiveFulfillment(order)) {
    if (order.status === "canceled") reportLabelAfterCancel(orderId);
    return { status: 409, body: { order_id: orderId, outcome: "refused", reason: "fulfilled" } };
  }
  if (order.status === "canceled") {
    return { status: 200, body: { order_id: orderId, outcome: "already_cancelled" } };
  }
  if (order.status === "completed") {
    return { status: 409, body: { order_id: orderId, outcome: "refused", reason: "completed" } };
  }
  if (!CANCELLABLE.has(order.status)) {
    return { status: 409, body: { order_id: orderId, outcome: "refused", reason: "not_cancellable" } };
  }
  return null;
}

const hasLiveFulfillment = (order: OrderRead) => (order.fulfillments ?? []).some((f) => f && !f.canceled_at);

/** A cancelled order that has a shipping label: told to ops each time it is
 *  answered, until a person deals with it. */
function reportLabelAfterCancel(orderId: string): void {
  console.error(`[order-cancel] order ${orderId} has a shipping label after its cancel; answered as refused`);
  captureException(new Error("order cancel: a shipping label exists after the cancel"), {
    tags: { route: "order-cancel", reason: "label_booked_during_cancel" },
    extra: { order_id: orderId },
  });
}

const failed = (orderId: string): CancelAnswer => ({
  status: 500,
  body: { order_id: orderId, outcome: "error" },
});

function report(err: unknown, orderId: string, step: string): void {
  // The error's own text is not sent: a workflow error can quote the order.
  console.error(`[order-cancel] ${step} failed for order ${orderId}: ${failureKind(err)}`);
  captureException(new Error(`order cancel: ${step} failed (${failureKind(err)})`), {
    tags: { route: "order-cancel", reason: `${step}_failed` },
    extra: { order_id: orderId },
  });
}

export async function cancelUnfulfilledOrder(
  container: MedusaContainer,
  orderId: string,
): Promise<CancelAnswer> {
  let order: OrderRead | null;
  try {
    order = await readOrder(container, orderId);
  } catch (err) {
    report(err, orderId, "read");
    return failed(orderId);
  }
  const before = standing(orderId, order);
  if (before) return before;

  try {
    await cancelOrderWorkflow(container).run({
      input: { order_id: orderId, no_notification: true, canceled_by: "klear-website" },
    });
  } catch (err) {
    // The workflow checks the order again and throws if it was cancelled,
    // or labelled, since it was read: answer by the order as it is now.
    try {
      const now = standing(orderId, await readOrder(container, orderId));
      if (now && now.status !== 404) return now;
    } catch {
      // Fall through to the plain error.
    }
    report(err, orderId, "cancel");
    return failed(orderId);
  }

  // Read the order once more before answering. Booking a label calls the
  // carrier before its fulfillment row exists, so a label can be booked
  // while the cancel runs. The Website refunds only on "cancelled": if a
  // fulfillment that is not cancelled is there now, answer as a refusal
  // (the case is a return, handled by a person) and tell ops.
  let after: OrderRead | null;
  try {
    after = await readOrder(container, orderId);
  } catch (err) {
    report(err, orderId, "read_after_cancel");
    return failed(orderId);
  }
  if (after && hasLiveFulfillment(after)) {
    reportLabelAfterCancel(orderId);
    return { status: 409, body: { order_id: orderId, outcome: "refused", reason: "fulfilled" } };
  }
  return { status: 200, body: { order_id: orderId, outcome: "cancelled" } };
}
