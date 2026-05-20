// Shipping provider abstraction (Medusa-side).
//
// Aggregator-first design — Shippop fronts 50+ Thai carriers behind one REST
// API, so this module hides the carrier choice from the rest of the system.
// The default routed carrier is configured (initially Flash Express) but
// changeable per-shipment at request time (e.g. Thailand Post EMS for remote
// postcodes Flash refuses).
//
// Decision: DECISIONS.md § "Shipping Provider — Shippop (aggregator)" (2026-05-20).
// Reference: http://developers.shippop.com/

export type ThaiCarrier =
  | "flash"
  | "kerry"
  | "jt"
  | "thailand_post_ems"
  | "dhl_ecommerce"
  | "ninja_van"
  | "scg"
  | "best";

export interface ParcelDims {
  weight_g: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface ThaiAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string;
  subdistrict: string;
  district: string;
  province: string;
  postcode: string;
  country: "TH";
}

export interface RateQuoteInput {
  from: ThaiAddress;
  to: ThaiAddress;
  parcel: ParcelDims;
  declared_value_thb: number;
  carriers?: ThaiCarrier[];
}

export interface RateQuote {
  carrier: ThaiCarrier;
  service_code: string;
  price_thb: number;
  eta_business_days: { min: number; max: number };
  insurance_included_thb: number;
}

export interface CreateShipmentInput {
  order_id: string;
  from: ThaiAddress;
  to: ThaiAddress;
  parcel: ParcelDims;
  declared_value_thb: number;
  carrier: ThaiCarrier;
  reference?: string;
  idempotency_key: string;
}

export interface Shipment {
  shipment_id: string;
  tracking_number: string;
  carrier: ThaiCarrier;
  label_url: string;
  cost_thb: number;
  status: ShipmentStatus;
}

export type ShipmentStatus =
  | "pending"
  | "label_created"
  | "picked_up"
  | "in_transit"
  | "out_for_delivery"
  | "delivered"
  | "delivery_failed"
  | "returned"
  | "cancelled";

export interface TrackingEvent {
  shipment_id: string;
  status: ShipmentStatus;
  occurred_at: string;
  location?: string;
  raw_carrier_status: string;
}

export type ShippingWebhookEvent =
  | { type: "tracking_update"; event: TrackingEvent }
  | { type: "delivery_failed"; event: TrackingEvent; reason: string };

export interface IShippingProvider {
  readonly name: "shippop";
  getRates(input: RateQuoteInput): Promise<RateQuote[]>;
  createShipment(input: CreateShipmentInput): Promise<Shipment>;
  getTracking(tracking_number: string): Promise<TrackingEvent[]>;
  cancelShipment(shipment_id: string): Promise<void>;
  verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<ShippingWebhookEvent>;
}

export class ShippingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ShippingError";
    this.code = code;
  }
}
