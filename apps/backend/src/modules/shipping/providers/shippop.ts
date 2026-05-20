import {
  type IShippingProvider,
  type RateQuoteInput,
  type RateQuote,
  type CreateShipmentInput,
  type Shipment,
  type TrackingEvent,
  type ShippingWebhookEvent,
  ShippingError,
} from "../types";

// Shippop provider — real implementation skeleton.
//
// API reference: http://developers.shippop.com/
// Endpoints (subject to confirmation against live docs once account exists):
//   POST /api/v1/getprice            — rate quote across carriers
//   POST /api/v1/booking             — create shipment + return label
//   GET  /api/v1/tracking/{awb}      — tracking events
//   POST /api/v1/cancel              — cancel pending shipment
//   POST /webhooks/<klear>           — Shippop posts tracking updates here
//
// All methods currently throw `not_implemented` — they are intentional
// placeholders so the module wires cleanly into Medusa today and the
// real wire-up is a small, contained PR after the API key arrives.

export interface ShippopConfig {
  api_key: string;
  api_base_url: string;
  webhook_secret: string;
}

const NOT_IMPLEMENTED_MSG =
  "ShippopProvider method not yet wired. See module README.md and " +
  "developers.shippop.com for the request/response shapes.";

export class ShippopProvider implements IShippingProvider {
  readonly name = "shippop" as const;
  private readonly config: ShippopConfig;

  constructor(config: ShippopConfig) {
    this.config = config;
  }

  async getRates(_input: RateQuoteInput): Promise<RateQuote[]> {
    // TODO: POST {api_base_url}/api/v1/getprice with from/to/parcel
    //   → map response[].carrier_code → ThaiCarrier
    //   → map response[].price → price_thb (already THB)
    //   → fold response[].insurance_amount into insurance_included_thb
    throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async createShipment(_input: CreateShipmentInput): Promise<Shipment> {
    // TODO: POST {api_base_url}/api/v1/booking
    //   - idempotency_key → x-idempotency-key header (or body field per docs)
    //   - response.tracking_code → tracking_number
    //   - response.label_url → label_url (PDF; stash in R2 if Shippop URLs expire)
    //   - response.courier_code → carrier
    //   - response.purchase_id → shipment_id
    throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async getTracking(_tracking_number: string): Promise<TrackingEvent[]> {
    // TODO: GET {api_base_url}/api/v1/tracking/{tracking_number}
    //   - response.tracking[].status → ShipmentStatus via mapShippopStatus()
    //   - response.tracking[].datetime → occurred_at (ISO 8601)
    //   - response.tracking[].description → location
    throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async cancelShipment(_shipment_id: string): Promise<void> {
    // TODO: POST {api_base_url}/api/v1/cancel { purchase_id }
    //   - allowed only before pickup; surface ShippingError("too_late_to_cancel", ...)
    //     when carrier already scanned
    throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async verifyAndParseWebhook(_input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<ShippingWebhookEvent> {
    // TODO: HMAC verify with `webhook_secret` BEFORE parsing the body.
    // Pattern mirrors the LINE webhook verifier in storefront
    // (src/lib/line/webhook.ts) — never trust the body until the
    // signature header is constant-time compared.
    throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
  }
}

/**
 * Maps Shippop's per-carrier status strings to Klear's canonical
 * ShipmentStatus. Filled in against the real status enum once we have
 * a Shippop sandbox account and can observe webhook payloads.
 */
export function mapShippopStatus(_raw: string): never {
  throw new ShippingError("not_implemented", NOT_IMPLEMENTED_MSG);
}
