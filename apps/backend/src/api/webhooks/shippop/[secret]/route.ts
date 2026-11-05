import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { SHIPPING_MODULE } from "../../../../modules/shipping";
import type ShippingModuleService from "../../../../modules/shipping/service";
import { ShippingError } from "../../../../modules/shipping/types";
import { extractRawBody } from "../raw-body";

// Shippop tracking webhook.
//
// Shippop posts `application/x-www-form-urlencoded` tracking updates to a
// URL we register in their merchant dashboard. The full URL we register is:
//
//   https://<medusa-railway-url>/webhooks/shippop/<SHIPPOP_WEBHOOK_PATH_SECRET>
//
// Shippop does NOT HMAC-sign these payloads. Authentication is:
//   1. Path-secret match (compared inside verifyAndParseWebhook)
//   2. Source-IP allowlist at the firewall (Railway / Cloudflare WAF)
//
// On a verified event we emit a Klear-namespaced event onto the event bus.
// `src/subscribers/shippop-tracking.ts` consumes it: it marks the Medusa
// fulfillment delivered and forwards the status to the storefront, which owns
// the customer-facing order state and LINE/email messages.
//
// The body is read raw (`src/api/middlewares.ts` sets preserveRawBody for
// this route): Medusa's urlencoded parser would otherwise turn
// `data[datetime]` / `data[reason]` into a nested object.

const EVENT_TRACKING_UPDATE = "shippop.tracking.update";
const EVENT_DELIVERY_FAILED = "shippop.delivery.failed";

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER);
  const shippingModule = req.scope.resolve(SHIPPING_MODULE) as ShippingModuleService;
  const eventBus = req.scope.resolve(Modules.EVENT_BUS) as {
    emit: (event: { name: string; data: unknown }) => Promise<void>;
  };
  const secret = req.params.secret as string;

  const rawBody = extractRawBody(req);

  let event;
  try {
    event = await shippingModule.verifyAndParseWebhook({
      raw_body: rawBody,
      headers: collectHeaders(req),
      path_secret: secret,
    });
  } catch (err) {
    if (err instanceof ShippingError && err.code === "webhook_unauthorized") {
      logger.warn(`Shippop webhook rejected: ${err.message}`);
      // Match Shippop's expected response shape even on rejection so they
      // don't aggressively retry; the request itself was malformed/forged.
      res.status(401).json({ success: 0, error: "unauthorized" });
      return;
    }
    logger.error(`Shippop webhook parsing failed: ${(err as Error).message}`);
    res.status(400).json({ success: 0, error: "malformed" });
    return;
  }

  logger.info(
    `Shippop ${event.type}: shipment=${event.event.shipment_id} status=${event.event.status} raw=${event.event.raw_shippop_status}`
  );

  const eventName = event.type === "delivery_failed" ? EVENT_DELIVERY_FAILED : EVENT_TRACKING_UPDATE;
  await eventBus.emit({ name: eventName, data: event });

  // Shippop expects exactly this body for a successful ack.
  res.status(200).json({ success: 1 });
};

function collectHeaders(req: MedusaRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    if (Array.isArray(v)) out[k] = v.join(",");
    else if (typeof v === "string") out[k] = v;
  }
  return out;
}
