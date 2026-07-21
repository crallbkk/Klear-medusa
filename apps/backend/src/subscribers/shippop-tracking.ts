import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/medusa/core-flows";
import {
  carrierDisplayName,
  shippopTrackingUrl,
  type ShipmentStatus,
  type ShippingWebhookEvent,
} from "../modules/shipping/types";
import type { ShippopFulfillmentData } from "../modules/shipping/provider/service";
import { captureException, captureMessage } from "../lib/observability/sentry";

/**
 * H1 — carrier (Shippop) shipped/delivered propagation to the customer.
 *
 * Consumes the `shippop.tracking.update` / `shippop.delivery.failed` events the
 * Shippop webhook route emits (see api/webhooks/shippop/[secret]/route.ts — the
 * "task 2.12" it references is this subscriber). The Shippop payload carries NO
 * Medusa order id, so we resolve it here:
 *
 *   tracking code (SP…) → Fulfillment (matched on labels.tracking_number) →
 *   order id (fulfillment↔order link, exposed on the graph as `order`)
 *
 * The provider adapter stores the SP tracking_code as BOTH the Fulfillment
 * label's `tracking_number` AND `data.shippop_tracking_code` (courier AWB is
 * kept separately on `data.courier_tracking_code`). The webhook's `shipment_id`
 * is that same SP code, so a label match resolves it. `carrier` + `tracking_url`
 * are derived here from the resolved fulfillment (courier_code → display name;
 * label tracking_url, falling back to the shared Shippop URL) so the storefront
 * never has to.
 *
 * Two actions per event:
 *   (a) status "delivered" → mark the Medusa fulfillment delivered via the
 *       native workflow, guarded by delivered_at (a redelivered webhook must
 *       not throw or double-register).
 *   (b) every status in the wire contract (incl. delivery_failed) → POST the
 *       storefront `/api/webhooks/carrier-status` endpoint, 3 attempts with
 *       backoff. The storefront owns the customer-facing state machine +
 *       LINE/email dispatch.
 *
 * Containment: the webhook route already ack'd Shippop 200, so this subscriber
 * NEVER throws — an unresolved code, a failed mark, or exhausted POST retries
 * all log loudly (`[carrier-propagation]`) and return. Real failures also
 * report to Sentry (BACKLOG M5) so they're visible without tailing logs —
 * see the `captureException`/`captureMessage` calls below; only opaque ids
 * (order/tracking/shipment) go into `extra`, never customer data.
 *
 * ACCEPTED TRADE-OFF (pr-rigor F2, 2026-07-19): because containment means the
 * event bus records success, exhausting the 3 in-band POST attempts DROPS the
 * event — Medusa can read `delivered` while the storefront order stays
 * `shipped` and the customer is never told. Recovery today: Shippop webhook
 * redelivery, or the storefront's desync page on any future event for the
 * order. A dead-letter row + redrive sweep is the go-live hardening item
 * (BACKLOG M11) — required before real Shippop volume. See LESSONS.md
 * Pattern 24 for the general shape.
 */

const STOREFRONT_URL_ENV = "KLEAR_STOREFRONT_URL";
const WEBHOOK_SECRET_ENV = "KLEAR_CARRIER_WEBHOOK_SECRET";

/** Statuses the storefront wire contract accepts. Others (pending/ready/…) are
 *  booking-lifecycle states with no customer-facing meaning — we don't POST. */
const CONTRACT_STATUSES: ReadonlySet<ShipmentStatus> = new Set<ShipmentStatus>([
  "picked_up",
  "in_transit",
  "out_for_delivery",
  "delivered",
  "delivery_failed",
  "returned",
  "cancelled",
]);

const POST_BACKOFF_MS = [0, 2000, 5000] as const;
const POST_TIMEOUT_MS = 10_000;

/** Emitted at most once per process so a misconfigured env surfaces without
 *  flooding logs on every webhook. */
let envMissingWarned = false;

export default async function shippopTrackingHandler({
  event,
  container,
}: SubscriberArgs<ShippingWebhookEvent>): Promise<void> {
  const payload = event.data;
  const tracking = payload?.event;
  if (!tracking?.shipment_id) {
    console.warn("[carrier-propagation] event missing tracking payload; skipping");
    return;
  }

  const spCode = tracking.shipment_id;
  const status = tracking.status;

  const resolution = await resolveFulfillment(container, spCode);
  if (resolution.outcome === "query_failed") {
    // DISTINCT from the empty-match warn below: the graph query itself threw,
    // which usually means the query/link wiring is misconfigured (or the DB is
    // down) — every event will fail identically until it's fixed.
    console.error(
      `[carrier-propagation] fulfillment graph query FAILED — resolution may be misconfigured: ${resolution.message} (tracking code ${spCode}, status=${status})`,
    );
    captureException(new Error(resolution.message), {
      tags: { subscriber: "shippop-tracking", reason: "fulfillment_query_failed" },
      extra: { shipment_id: spCode, status },
    });
    return;
  }
  if (resolution.outcome === "no_match") {
    // Loud, deliberate: an unresolvable code means the order never got a
    // Shippop shipment through our adapter, or the label wasn't persisted.
    console.warn(
      `[carrier-propagation] no Medusa fulfillment matches tracking code ${spCode} (status=${status}, fulfillments checked: ${resolution.checked}); dropping event`,
    );
    captureMessage(
      `[carrier-propagation] no Medusa fulfillment matches tracking code`,
      {
        level: "warning",
        tags: { subscriber: "shippop-tracking", reason: "no_match" },
        extra: { shipment_id: spCode, status, checked: resolution.checked },
      },
    );
    return;
  }

  const { orderId, fulfillmentId, deliveredAt, carrier, trackingUrl } = resolution;

  // (a) delivered → mark the Medusa fulfillment delivered (idempotent).
  if (status === "delivered") {
    if (deliveredAt) {
      console.info(
        `[carrier-propagation] fulfillment ${fulfillmentId} already delivered_at=${deliveredAt}; skipping mark-delivered`,
      );
    } else {
      try {
        await markOrderFulfillmentAsDeliveredWorkflow(container).run({
          input: {
            orderId,
            fulfillmentId,
            // Klear fires its OWN customer notifications from the storefront
            // (the POST below → order-state machine → LINE/email). Suppress
            // Medusa's built-in delivery notification to avoid a duplicate.
            no_notification: true,
          },
        });
      } catch (err) {
        // A concurrent/redelivered webhook could race us past the delivered_at
        // guard and the workflow throws. Contain it — the POST still fires.
        console.error(
          `[carrier-propagation] mark-delivered failed for fulfillment ${fulfillmentId} (order ${orderId}): ${errMessage(err)}`,
        );
        captureException(err, {
          tags: { subscriber: "shippop-tracking", reason: "mark_delivered_failed" },
          extra: { order_id: orderId, fulfillment_id: fulfillmentId, status },
        });
      }
    }
  }

  // (b) POST the storefront for every contract status.
  if (!CONTRACT_STATUSES.has(status)) {
    console.info(
      `[carrier-propagation] status "${status}" is not in the wire contract; no storefront POST (order ${orderId})`,
    );
    return;
  }

  const storefrontUrl = process.env[STOREFRONT_URL_ENV];
  const secret = process.env[WEBHOOK_SECRET_ENV];
  if (!storefrontUrl || !secret) {
    if (!envMissingWarned) {
      envMissingWarned = true;
      console.error(
        `[carrier-propagation] ${STOREFRONT_URL_ENV} and/or ${WEBHOOK_SECRET_ENV} not set — skipping all storefront POSTs until configured`,
      );
      captureMessage(
        `[carrier-propagation] ${STOREFRONT_URL_ENV} and/or ${WEBHOOK_SECRET_ENV} not set`,
        {
          level: "error",
          tags: { subscriber: "shippop-tracking", reason: "env_missing" },
        },
      );
    }
    return;
  }

  const body = {
    medusa_order_id: orderId,
    status,
    carrier,
    tracking_number: spCode,
    tracking_url: trackingUrl,
    occurred_at: tracking.occurred_at,
    shipment_id: spCode,
    raw_status: tracking.raw_shippop_status,
  };

  const posted = await postToStorefront(
    `${storefrontUrl.replace(/\/$/, "")}/api/webhooks/carrier-status`,
    secret,
    body,
  );
  if (!posted) {
    console.error(
      `[carrier-propagation] storefront POST failed after ${POST_BACKOFF_MS.length} attempts for order ${orderId} (status=${status}, tracking=${spCode})`,
    );
    // The blind spot this closes: containment means the event bus still
    // records success, so an exhausted POST here silently drops the
    // storefront out of sync with Medusa (Medusa=delivered/shipped,
    // storefront stuck on the prior status, customer never notified — see
    // the ACCEPTED TRADE-OFF note above / BACKLOG M11). This is the one
    // capture in this subscriber that most needs real-time alerting.
    captureMessage(
      `[carrier-propagation] storefront POST exhausted after ${POST_BACKOFF_MS.length} attempts`,
      {
        level: "error",
        tags: { subscriber: "shippop-tracking", reason: "storefront_post_exhausted" },
        extra: { order_id: orderId, status, shipment_id: spCode },
      },
    );
  }
}

type ResolutionResult =
  | {
      outcome: "resolved";
      orderId: string;
      fulfillmentId: string;
      deliveredAt: string | null;
      carrier: string | null;
      trackingUrl: string | null;
    }
  /** The graph query itself threw — wiring/infra problem, not a data miss. */
  | { outcome: "query_failed"; message: string }
  /** Query ran fine but no fulfillment (with an order link) matched the code.
   *  `checked` = rows the query returned before the order-link filter. */
  | { outcome: "no_match"; checked: number };

/**
 * Resolve the Shippop SP code to a Medusa fulfillment (+ its order) via the
 * Query graph, matching on the label tracking_number the provider stored.
 *
 * Design note — "match on BOTH the SP and courier code": the webhook exposes
 * only the SP code (`shipment_id`), and that is exactly what the adapter writes
 * as the label `tracking_number` (and `data.shippop_tracking_code`). The courier
 * AWB lives on `data.courier_tracking_code`, which isn't graph-filterable, so we
 * match on the SP code — the one identifier the webhook actually carries. If a
 * future Shippop config ever delivers the courier AWB as the tracking code, the
 * data.courier_tracking_code field is already persisted for a follow-up lookup.
 */
async function resolveFulfillment(
  container: SubscriberArgs["container"],
  spCode: string,
): Promise<ResolutionResult> {
  let rows: FulfillmentGraphRow[];
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "fulfillment",
      fields: [
        "id",
        "delivered_at",
        "data",
        "labels.tracking_number",
        "labels.tracking_url",
        "order.id",
      ],
      filters: { labels: { tracking_number: [spCode] } },
    });
    rows = (data ?? []) as FulfillmentGraphRow[];
  } catch (err) {
    return { outcome: "query_failed", message: errMessage(err) };
  }

  const match = rows.find((r) => r.order?.id);
  if (!match || !match.order?.id) {
    return { outcome: "no_match", checked: rows.length };
  }

  const data = (match.data ?? {}) as Partial<ShippopFulfillmentData>;
  const labelUrl = Array.isArray(match.labels)
    ? match.labels.find((l) => l?.tracking_url)?.tracking_url
    : undefined;

  return {
    outcome: "resolved",
    orderId: match.order.id,
    fulfillmentId: match.id,
    deliveredAt: match.delivered_at ?? null,
    carrier: carrierDisplayName(data.courier_code),
    trackingUrl: labelUrl ?? shippopTrackingUrl(spCode),
  };
}

interface FulfillmentGraphRow {
  id: string;
  delivered_at?: string | null;
  data?: Record<string, unknown> | null;
  labels?: Array<{ tracking_number?: string | null; tracking_url?: string | null }> | null;
  order?: { id?: string } | null;
}

/**
 * POST the storefront with 3 attempts (backoff ~0/2/5s, 10s timeout each).
 * Returns true on the first 2xx, false when all attempts are exhausted. Never
 * throws — the caller logs a single loud error on total failure.
 */
async function postToStorefront(
  url: string,
  secret: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const serialized = JSON.stringify(body);
  for (let attempt = 0; attempt < POST_BACKOFF_MS.length; attempt++) {
    const delay = POST_BACKOFF_MS[attempt];
    if (delay > 0) await sleep(delay);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: serialized,
        signal: controller.signal,
      });
      if (res.ok) return true;
      console.warn(
        `[carrier-propagation] storefront POST attempt ${attempt + 1} returned ${res.status}`,
      );
    } catch (err) {
      console.warn(
        `[carrier-propagation] storefront POST attempt ${attempt + 1} errored: ${errMessage(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const config: SubscriberConfig = {
  event: ["shippop.tracking.update", "shippop.delivery.failed"],
};
