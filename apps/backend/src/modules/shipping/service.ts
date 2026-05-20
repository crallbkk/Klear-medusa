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
// Wraps Shippop (DECISIONS.md 2026-05-20). Default routed carrier comes
// from env (SHIPPING_DEFAULT_CARRIER, default "FLE" = Flash Express);
// per-shipment overrides flow through createShipment.input.carrier.
//
// Architectural note: this module is currently invoked from subscribers
// and admin actions, not from Medusa's native fulfillment lifecycle. The
// conversion to an `AbstractFulfillmentProviderService` is tracked as
// task 2.11 in DEV_TRACKER.md.

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

  constructor(_container?: unknown, providerOverride?: IShippingProvider) {
    this.provider = providerOverride ?? resolveProvider();
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
