import {
  type IShippingProvider,
  type RateQuoteInput,
  type RateQuote,
  type CreateShipmentInput,
  type Shipment,
  type TrackingEvent,
  type ShippingWebhookEvent,
  type ThaiCarrier,
} from "./types";
import { UnconfiguredShippopProvider } from "./providers/_unconfigured";
import { ShippopProvider } from "./providers/shippop";

export const SHIPPING_MODULE = "klear_shipping";

// Klear-specific shipping service.
//
// Wraps Shippop (the chosen aggregator — DECISIONS.md 2026-05-20). Distinct
// from Medusa's built-in fulfillment module: this one handles label
// creation, multi-carrier rate quoting, tracking-webhook ingestion, and
// cancellation against the Thai carrier network. The Medusa core
// fulfillment module continues to manage the order-side lifecycle.
//
// Default routed carrier comes from env (SHIPPING_DEFAULT_CARRIER, e.g.
// "flash"); per-shipment overrides flow through createShipment.input.carrier.

function resolveProvider(): IShippingProvider {
  const apiKey = process.env.SHIPPOP_API_KEY;
  const baseUrl = process.env.SHIPPOP_API_BASE_URL;
  const webhookSecret = process.env.SHIPPOP_WEBHOOK_SECRET;

  if (!apiKey || !baseUrl || !webhookSecret) {
    return new UnconfiguredShippopProvider();
  }
  return new ShippopProvider({
    api_key: apiKey,
    api_base_url: baseUrl,
    webhook_secret: webhookSecret,
  });
}

function resolveDefaultCarrier(): ThaiCarrier {
  const fromEnv = process.env.SHIPPING_DEFAULT_CARRIER as ThaiCarrier | undefined;
  return fromEnv ?? "flash";
}

export default class ShippingModuleService {
  private readonly provider: IShippingProvider;
  private readonly defaultCarrier: ThaiCarrier;

  constructor() {
    this.provider = resolveProvider();
    this.defaultCarrier = resolveDefaultCarrier();
  }

  getRates(input: RateQuoteInput): Promise<RateQuote[]> {
    return this.provider.getRates(input);
  }

  createShipment(
    input: Omit<CreateShipmentInput, "carrier"> & { carrier?: ThaiCarrier }
  ): Promise<Shipment> {
    return this.provider.createShipment({
      ...input,
      carrier: input.carrier ?? this.defaultCarrier,
    });
  }

  getTracking(tracking_number: string): Promise<TrackingEvent[]> {
    return this.provider.getTracking(tracking_number);
  }

  cancelShipment(shipment_id: string): Promise<void> {
    return this.provider.cancelShipment(shipment_id);
  }

  verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<ShippingWebhookEvent> {
    return this.provider.verifyAndParseWebhook(input);
  }

  getProviderName(): string {
    return this.provider.name;
  }

  getDefaultCarrier(): ThaiCarrier {
    return this.defaultCarrier;
  }
}
