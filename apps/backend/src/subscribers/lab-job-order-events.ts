import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { recordOrderEventSafely } from "../modules/lms/order-events";
import { captureException } from "../lib/observability/sentry";

/**
 * Keeps a lab job in step with its order.
 *
 *   order.fulfillment_created   a shipping label was booked   → LABELLED
 *   order.fulfillment_canceled  that label was cancelled      → LABEL_CANCELLED
 *   delivery.created            the parcel was delivered      → DELIVERED
 *   order.canceled              the order was cancelled       → CANCELLED
 *
 * Each is recorded once per fulfillment (or per order for a cancel), however
 * often the event is delivered. An order with no lab job is ignored. Never
 * throws: see `recordOrderEventSafely`.
 */
type EventData = {
  id?: string;
  order_id?: string;
  fulfillment_id?: string;
};

export default async function labJobOrderEventsHandler({
  event,
  container,
}: SubscriberArgs<EventData>) {
  const data = event.data ?? {};
  const source = `event:${event.name}`;

  switch (event.name) {
    case "order.fulfillment_created":
      if (!data.order_id || !data.fulfillment_id) return;
      await recordOrderEventSafely(
        container,
        data.order_id,
        "LABELLED",
        `labelled:${data.fulfillment_id}`,
        source,
        data.fulfillment_id,
      );
      return;

    case "order.fulfillment_canceled":
      if (!data.order_id || !data.fulfillment_id) return;
      await recordOrderEventSafely(
        container,
        data.order_id,
        "LABEL_CANCELLED",
        `label-cancelled:${data.fulfillment_id}`,
        source,
        data.fulfillment_id,
      );
      return;

    case "delivery.created": {
      // The event carries the fulfillment id only.
      if (!data.id) return;
      let orderId: string | undefined;
      try {
        const query = container.resolve(ContainerRegistrationKeys.QUERY);
        const { data: rows } = await query.graph({
          entity: "fulfillment",
          fields: ["id", "order.id"],
          filters: { id: [data.id] },
        });
        orderId = (rows?.[0] as { order?: { id?: string } } | undefined)?.order?.id;
      } catch (err) {
        console.error(
          `[lms] could not find the order of fulfillment ${data.id}: ${
            err instanceof Error ? err.message : "unknown"
          }`,
        );
        captureException(err, {
          tags: { subscriber: "lab-job-order-events", reason: "fulfillment_query_failed" },
          extra: { fulfillment_id: data.id },
        });
        return;
      }
      if (!orderId) return;
      await recordOrderEventSafely(
        container,
        orderId,
        "DELIVERED",
        `delivered:${data.id}`,
        source,
        data.id,
      );
      return;
    }

    case "order.canceled":
      if (!data.id) return;
      await recordOrderEventSafely(container, data.id, "CANCELLED", `cancelled:${data.id}`, source);
      return;
  }
}

export const config: SubscriberConfig = {
  event: [
    "order.fulfillment_created",
    "order.fulfillment_canceled",
    "delivery.created",
    "order.canceled",
  ],
};
