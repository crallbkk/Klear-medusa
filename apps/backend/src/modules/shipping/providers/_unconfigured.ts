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
  "but SHIPPOP_API_KEY / SHIPPOP_API_BASE_URL / SHIPPOP_WEBHOOK_PATH_SECRET " +
  "are not set. Provision a Shippop merchant account, add the env vars to " +
  "Railway, then ShippingModuleService will auto-resolve to ShippopProvider.";

export class UnconfiguredShippopProvider implements IShippingProvider {
  readonly name = "shippop" as const;

  async getRates(_input: RateQuoteInput): Promise<RateQuote[]> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async createShipment(_input: CreateShipmentInput): Promise<Shipment> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async getTracking(_shippop_tracking_code: string): Promise<TrackingEvent[]> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async cancelShipment(_courier_tracking_code: string): Promise<void> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async getLabelHtml(_purchase_id: number): Promise<string> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }

  async verifyAndParseWebhook(_input: {
    raw_body: string;
    headers: Record<string, string>;
    path_secret?: string;
  }): Promise<ShippingWebhookEvent> {
    throw new ShippingError("not_configured", NOT_CONFIGURED_MSG);
  }
}
