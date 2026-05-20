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

const NOT_CONFIGURED_MSG =
  "Shippop is selected as the shipping provider (DECISIONS.md 2026-05-20) " +
  "but SHIPPOP_API_KEY is not set. Provision a Shippop merchant account, " +
  "add SHIPPOP_API_KEY + SHIPPOP_API_BASE_URL to Railway env, then swap " +
  "UnconfiguredShippopProvider for ShippopProvider in service.ts.";

export class UnconfiguredShippopProvider implements IShippingProvider {
  readonly name = "shippop" as const;

  async getRates(_input: RateQuoteInput): Promise<RateQuote[]> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async createShipment(_input: CreateShipmentInput): Promise<Shipment> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async getTracking(_tracking_number: string): Promise<TrackingEvent[]> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async cancelShipment(_shipment_id: string): Promise<void> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async verifyAndParseWebhook(_input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<ShippingWebhookEvent> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }
}
