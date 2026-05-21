import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils";
import type { Logger } from "@medusajs/framework/types";
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
  ValidateFulfillmentDataContext,
} from "@medusajs/types";

import {
  ShippopProvider,
} from "../providers/shippop";
import { UnconfiguredShippopProvider } from "../providers/_unconfigured";
import type {
  IShippingProvider,
  RateQuote,
  ShipmentStatus,
  ThaiAddress,
  ThaiCarrier,
} from "../types";

// Medusa-native fulfillment-provider adapter wrapping ShippopProvider.
//
// Registered under Medusa's built-in fulfillment module via
// `src/modules/shipping/provider/index.ts`. Once wired in `medusa-config.ts`,
// the admin user can create shipping options against our carriers, and
// Medusa drives the full Fulfillment lifecycle:
//   - calculatePrice → live Shippop quote at checkout
//   - createFulfillment → /booking/ + /confirm/, returns label data
//   - cancelFulfillment → /cancel/ against the carrier AWB
//   - getShipmentDocuments → label HTML via /label/
//
// The `data` we persist on the Fulfillment after createFulfillment is the
// link back to Shippop: shippop_tracking_code, courier_tracking_code,
// purchase_id, courier_code. The webhook route looks shipments up by
// shippop_tracking_code on the fulfillment metadata to drive
// markOrderFulfillmentAsDeliveredWorkflow.

type ShippopFulfillmentOptions = {
  /** Sender address Shippop sees on every label. */
  warehouse: ThaiAddress;
  /** Default parcel dims for eyewear; overridable per-item once variant weights land. */
  default_parcel: {
    weight_g: number;
    length_cm: number;
    width_cm: number;
    height_cm: number;
  };
};

type InjectedDependencies = { logger: Logger };

/**
 * Stored on the Fulfillment's `data` after createFulfillment. Used by the
 * webhook subscriber to map Shippop events back to a Medusa fulfillment.
 */
export interface ShippopFulfillmentData extends Record<string, unknown> {
  shippop_tracking_code: string;
  courier_tracking_code: string;
  purchase_id: number;
  courier_code: ThaiCarrier;
  label_html?: string;
  status: ShipmentStatus;
}

/** Static set of carriers we expose as fulfillment options. Mirrors ThaiCarrier. */
const FULFILLMENT_OPTIONS: ReadonlyArray<{ id: ThaiCarrier; name: string }> = [
  { id: "FLE", name: "Flash Express" },
  { id: "EMST", name: "Thailand Post EMS" },
  { id: "KRYX", name: "Kerry Express" },
  { id: "KRYS", name: "Kerry Shop" },
  { id: "JNTE", name: "J&T Express" },
  { id: "DHL", name: "DHL eCommerce" },
  { id: "NJV", name: "Ninja Van" },
  { id: "SCG", name: "SCG Express" },
  { id: "BEST", name: "Best Express" },
];

export class ShippopFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = "shippop";

  protected readonly logger_: Logger;
  protected readonly options_: ShippopFulfillmentOptions;
  protected readonly provider_: IShippingProvider;

  constructor(
    { logger }: InjectedDependencies,
    options: ShippopFulfillmentOptions,
    providerOverride?: IShippingProvider
  ) {
    super();
    this.logger_ = logger;
    this.options_ = options;
    this.provider_ = providerOverride ?? buildProvider();
  }

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return FULFILLMENT_OPTIONS.map((o) => ({ id: o.id, name: o.name, courier_code: o.id }));
  }

  async validateOption(data: Record<string, unknown>): Promise<boolean> {
    const code = data?.id ?? data?.courier_code;
    return typeof code === "string" && FULFILLMENT_OPTIONS.some((o) => o.id === code);
  }

  async validateFulfillmentData(
    optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: ValidateFulfillmentDataContext
  ): Promise<Record<string, unknown>> {
    // Merge the option's courier_code into the method data so it travels
    // through to createFulfillment without the admin/checkout needing to
    // pass it explicitly.
    const courier = (optionData?.courier_code ?? optionData?.id ?? data?.courier_code) as
      | ThaiCarrier
      | undefined;
    if (!courier || !FULFILLMENT_OPTIONS.some((o) => o.id === courier)) {
      throw new Error(`Unknown courier_code "${String(courier)}" — must be one of: ${FULFILLMENT_OPTIONS.map((o) => o.id).join(", ")}`);
    }
    return { ...data, courier_code: courier };
  }

  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return true;
  }

  async calculatePrice(
    optionData: CalculateShippingOptionPriceDTO["optionData"],
    _data: CalculateShippingOptionPriceDTO["data"],
    context: CalculateShippingOptionPriceDTO["context"]
  ): Promise<CalculatedShippingOptionPrice> {
    const courier = ((optionData as Record<string, unknown>).courier_code ??
      (optionData as Record<string, unknown>).id) as ThaiCarrier;
    const toAddress = extractAddress(context?.shipping_address);
    if (!toAddress) {
      throw new Error("calculatePrice requires a Thai shipping address with postcode on the cart context.");
    }

    const rates = await this.provider_.getRates({
      from: this.options_.warehouse,
      to: toAddress,
      parcel: this.options_.default_parcel,
      declared_value_thb: estimateDeclaredValueThb(context),
      carriers: [courier],
    });
    const match = rates.find((r) => r.carrier === courier) ?? rates[0];
    if (!match) {
      throw new Error(`No rate returned by Shippop for carrier ${courier}`);
    }
    return {
      calculated_amount: match.price_thb,
      // Thai VAT is inclusive; Klear's pricing engine treats shipping as
      // VAT-inclusive in line with the storefront's tax model.
      is_calculated_price_tax_inclusive: true,
    };
  }

  async createFulfillment(
    data: Record<string, unknown>,
    items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
    order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, "provider_id" | "data" | "items">>
  ): Promise<CreateFulfillmentResult> {
    const courier = (data.courier_code as ThaiCarrier | undefined) ?? "FLE";
    const toAddress = extractAddress(fulfillment.delivery_address ?? order?.shipping_address);
    if (!toAddress) {
      throw new Error("createFulfillment requires a Thai shipping address on the order/fulfillment.");
    }
    const orderId = (order?.id ?? fulfillment.id ?? "unknown") as string;
    const publicCode = (order?.metadata?.public_code as string | undefined) ?? orderId;
    const idempotencyKey = (fulfillment.id ?? `${orderId}_${Date.now()}`) as string;

    const declaredValue = estimateDeclaredValueFromItems(items);
    const parcel = computeParcelFromItems(items, this.options_.default_parcel);

    const shipment = await this.provider_.createShipment({
      order_id: orderId,
      from: this.options_.warehouse,
      to: toAddress,
      parcel,
      declared_value_thb: declaredValue,
      carrier: courier,
      reference: { ref_no_1: orderId, ref_no_2: publicCode },
      idempotency_key: idempotencyKey,
      auto_confirm: true,
    });

    const out: ShippopFulfillmentData = {
      shippop_tracking_code: shipment.shipment_id,
      courier_tracking_code: shipment.courier_tracking_code,
      purchase_id: shipment.purchase_id,
      courier_code: shipment.carrier,
      status: shipment.status,
    };

    return {
      data: out,
      labels: [
        {
          tracking_number: shipment.shipment_id,
          tracking_url: trackingUrlFor(shipment.shipment_id),
          // label URL filled in lazily via getShipmentDocuments — keeps
          // createFulfillment fast and avoids a second Shippop call when
          // the admin just wants to confirm the booking.
          label_url: trackingUrlFor(shipment.shipment_id),
        },
      ],
    };
  }

  async cancelFulfillment(data: Record<string, unknown>): Promise<unknown> {
    const courierAwb = (data as ShippopFulfillmentData).courier_tracking_code;
    if (!courierAwb) {
      throw new Error("cancelFulfillment: missing courier_tracking_code on fulfillment data.");
    }
    await this.provider_.cancelShipment(courierAwb);
    return { cancelled: true };
  }

  async createReturnFulfillment(_fulfillment: Record<string, unknown>): Promise<CreateFulfillmentResult> {
    // Shippop supports return labels via a separate booking with swapped
    // from/to addresses, but the lab/return workflow is owned by the LMS
    // module (DECISIONS.md #6 — still blocked on edger hardware). Throw
    // loudly until both pieces are ready rather than silently no-op.
    throw new Error(
      "Return fulfillment via Shippop is not yet wired — depends on LMS return-flow design (DECISIONS.md #6)."
    );
  }

  async getShipmentDocuments(data: Record<string, unknown>): Promise<never[]> {
    const purchaseId = (data as ShippopFulfillmentData).purchase_id;
    if (!purchaseId) return [];
    const html = await this.provider_.getLabelHtml(purchaseId);
    return [{ type: "label", html } as never];
  }

  async getFulfillmentDocuments(_data: Record<string, unknown>): Promise<never[]> {
    return [];
  }

  async getReturnDocuments(_data: Record<string, unknown>): Promise<never[]> {
    return [];
  }
}

export default ShippopFulfillmentService;

// ─── helpers ───────────────────────────────────────────────────────

function buildProvider(): IShippingProvider {
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

function extractAddress(addr: unknown): ThaiAddress | null {
  if (!addr || typeof addr !== "object") return null;
  const a = addr as Record<string, unknown>;
  // Medusa addresses use `address_1` + `address_2`, `city`, `country_code`,
  // `postal_code`. Klear's Thai-address convention maps to:
  //   district (Shippop "district") = metadata.subdistrict
  //   state    (Shippop "state")    = metadata.district
  //   province                       = a.province ?? city
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const postcode = (a.postal_code ?? a.postcode) as string | undefined;
  if (!postcode) return null;
  return {
    name: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "ลูกค้า Klear",
    phone: (a.phone as string) ?? "",
    address: [a.address_1, a.address_2].filter(Boolean).join(" "),
    district: (meta.subdistrict as string | undefined) ?? "",
    state: (meta.district as string | undefined) ?? (a.city as string) ?? "",
    province: (a.province as string | undefined) ?? (a.city as string) ?? "",
    postcode,
  };
}

function estimateDeclaredValueThb(context: CalculateShippingOptionPriceDTO["context"]): number {
  const total = (context as { item_total?: number; subtotal?: number })?.subtotal ??
    (context as { item_total?: number })?.item_total ??
    1500;
  return Math.max(1, Math.round(Number(total)));
}

function estimateDeclaredValueFromItems(items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[]): number {
  // Items don't carry unit_price in the FulfillmentItem DTO; fall back to a
  // conservative default. Future PR: thread the order subtotal through.
  return Math.max(1, items.length) * 1500;
}

function computeParcelFromItems(
  items: Partial<Omit<FulfillmentItemDTO, "fulfillment">>[],
  defaults: ShippopFulfillmentOptions["default_parcel"]
) {
  // Eyewear: assume each pair is its own case, light. Stack weight linearly,
  // keep dims at single-pair until we have real product weight data.
  const count = Math.max(1, items.length);
  return {
    weight_g: defaults.weight_g * count,
    length_cm: defaults.length_cm,
    width_cm: defaults.width_cm,
    height_cm: defaults.height_cm,
  };
}

function trackingUrlFor(shippop_tracking_code: string): string {
  // Customer-friendly tracking page hosted by Shippop. Pasted into the
  // shipped-email + LINE template by the storefront's order surface.
  return `https://www.shippop.com/tracking/?tracking_code=${encodeURIComponent(shippop_tracking_code)}`;
}
