import {
  type IShippingProvider,
  type RateQuoteInput,
  type RateQuote,
  type CreateShipmentInput,
  type Shipment,
  type TrackingEvent,
  type ShippingWebhookEvent,
  type ThaiCarrier,
  isShippingProvider,
} from "./types";
import { UnconfiguredShippopProvider } from "./providers/_unconfigured";
import { ShippopProvider } from "./providers/shippop";

export const SHIPPING_MODULE = "klear_shipping";

// Klear-specific shipping service.
//
// Wraps Shippop (DECISIONS.md 2026-05-20). Default routed carrier comes
// from env (SHIPPING_DEFAULT_CARRIER, default "FLE" = Flash Express);
// per-shipment overrides flow through createShipment.input.carrier.
//
// Architectural note: Medusa's fulfillment lifecycle goes through the native
// adapter in `./provider` (ShippopFulfillmentService, registered in
// medusa-config.ts). This plain service backs the webhook route's
// verify-and-parse step.

function resolveProvider(): IShippingProvider {
  const apiKey = process.env.SHIPPOP_API_KEY;
  const baseUrl = process.env.SHIPPOP_API_BASE_URL;
  const webhookSecret = process.env.SHIPPOP_WEBHOOK_PATH_SECRET;

  if (!apiKey || !baseUrl || !webhookSecret) {
    return new UnconfiguredShippopProvider();
  }
  return new ShippopProvider({
    api_key: apiKey,
    api_base_url: baseUrl,
    webhook_path_secret: webhookSecret,
  });
}

function resolveDefaultCarrier(): ThaiCarrier {
  const fromEnv = process.env.SHIPPING_DEFAULT_CARRIER as ThaiCarrier | undefined;
  return fromEnv ?? "FLE";
}

export default class ShippingModuleService {
  private readonly provider: IShippingProvider;
  private readonly defaultCarrier: ThaiCarrier;

  // `providerOverride` is for tests. Medusa itself calls
  // `new ShippingModuleService(container, moduleOptions)`, so the second arg
  // is the (empty) module options object at runtime: only a real provider is
  // accepted as an override.
  constructor(_container?: unknown, providerOverride?: unknown) {
    this.provider = isShippingProvider(providerOverride)
      ? providerOverride
      : resolveProvider();
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

  getTracking(shippop_tracking_code: string): Promise<TrackingEvent[]> {
    return this.provider.getTracking(shippop_tracking_code);
  }

  cancelShipment(courier_tracking_code: string): Promise<void> {
    return this.provider.cancelShipment(courier_tracking_code);
  }

  getLabelHtml(purchase_id: number): Promise<string> {
    return this.provider.getLabelHtml(purchase_id);
  }

  verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
    path_secret?: string;
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
