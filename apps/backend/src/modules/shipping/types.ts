// Shipping provider abstraction (Medusa-side).
//
// Wraps Shippop — a Thai aggregator fronting 50+ carriers behind one REST
// API. Default routed carrier is Flash Express; remote-postcode fallback
// is Thailand Post EMS. See SHIPPOP_API.md in this folder for the verified
// request/response shapes (sourced from the Postman collection 2026-05-20).
//
// Decision: storefront repo DECISIONS.md § "Shipping Provider" (2026-05-20).

// Shippop's courier_code values. Only the ones we route to are typed —
// `ShippopCourierCode` is intentionally an open union via the `string` tail
// so an unrecognised carrier_code from Shippop is surfaced rather than
// silently dropped.
export type ThaiCarrier =
  | "FLE"   // Flash Express
  | "EMST"  // EMS Thailand Post
  | "KRYS"  // Kerry Shop
  | "KRYX"  // Kerry Express
  | "JNTE"  // J&T Express
  | "DHL"   // DHL eCommerce
  | "NJV"   // Ninja Van
  | "SCG"   // SCG Express
  | "BEST"; // Best Express

export interface ParcelDims {
  weight_g: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}

export interface ThaiAddress {
  name: string;
  phone: string;
  address: string;
  // Shippop's nomenclature: district = subdistrict (tambon),
  // state = district (amphoe), province = province (changwat).
  district: string;
  state: string;
  province: string;
  postcode: string;
  email?: string;
  lat?: string;
  lng?: string;
}

export interface RateQuoteInput {
  from: ThaiAddress;
  to: ThaiAddress;
  parcel: ParcelDims;
  declared_value_thb: number;
  /**
   * Restrict to specific carriers, or omit to use Shippop's `showall: 1`
   * (returns all eligible couriers for the route).
   */
  carriers?: ThaiCarrier[];
}

export interface RateQuote {
  carrier: ThaiCarrier;
  carrier_name: string;
  price_thb: number;
  estimate_time: string; // free-form Thai/English string from Shippop
  available: boolean;
  remark?: string;
}

export interface CreateShipmentInput {
  order_id: string;
  from: ThaiAddress;
  to: ThaiAddress;
  parcel: ParcelDims;
  declared_value_thb: number;
  carrier: ThaiCarrier;
  /**
   * Free-form references stored on the Shippop order as ref_no_1 / ref_no_2.
   * We use ref_no_1 = Klear order ID (`order_*` from Medusa), ref_no_2 = the
   * public KLR-XXXXXX code.
   */
  reference?: { ref_no_1?: string; ref_no_2?: string };
  /**
   * Caller-supplied idempotency key. Shippop itself does not de-dupe on a
   * header; we de-dupe at the call site by checking for an existing
   * Shipment with this key before booking.
   */
  idempotency_key: string;
  /**
   * When true (default), call /confirm/ immediately after /booking/.
   * Set false only for batch flows that confirm later.
   */
  auto_confirm?: boolean;
}

export interface Shipment {
  /** Shippop's tracking_code (format: `SP\d+`). Stable across the order lifecycle. */
  shipment_id: string;
  /** Carrier's own AWB (e.g. Thai Post `ST...ST`). Used for cancellation calls. */
  courier_tracking_code: string;
  /** Shippop's purchase order grouping multiple shipments. */
  purchase_id: number;
  carrier: ThaiCarrier;
  cost_thb: number;
  status: ShipmentStatus;
  /** Set after auto_confirm; null when booking succeeded but confirm failed or was deferred. */
  confirmed: boolean;
}

export type ShipmentStatus =
  | "pending"          // booked, not yet confirmed
  | "ready"            // confirmed, waiting for carrier pickup
  | "picked_up"        // shipment.010
  | "in_transit"       // shipment.102 / 103
  | "out_for_delivery" // shipment.045
  | "delivered"        // shipment.POD
  | "delivery_failed"
  | "returned"
  | "cancelled";

export interface TrackingEvent {
  shipment_id: string;
  status: ShipmentStatus;
  occurred_at: string; // ISO 8601 (we convert from Shippop's "YYYY-MM-DD HH:mm:ss" Bangkok time)
  location?: string;
  raw_shippop_status: string; // "010" | "102" | "POD" | etc — kept for audit
  description: string;        // raw bilingual description from Shippop
}

/**
 * Shippop webhook bodies arrive as application/x-www-form-urlencoded with a
 * stable set of top-level fields. Our verifyAndParseWebhook normalises them
 * into this typed shape so downstream subscribers don't care about the
 * transport.
 */
export type ShippingWebhookEvent =
  | { type: "tracking_update"; event: TrackingEvent }
  | { type: "delivery_failed"; event: TrackingEvent; reason: string };

export interface IShippingProvider {
  readonly name: "shippop";
  getRates(input: RateQuoteInput): Promise<RateQuote[]>;
  createShipment(input: CreateShipmentInput): Promise<Shipment>;
  getTracking(shippop_tracking_code: string): Promise<TrackingEvent[]>;
  cancelShipment(courier_tracking_code: string): Promise<void>;
  /**
   * Retrieve the printable label HTML (4x6 sticker). Caller is responsible
   * for stashing to R2 if persistence beyond the Shippop session is needed.
   */
  getLabelHtml(purchase_id: number): Promise<string>;
  verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
    path_secret?: string;
  }): Promise<ShippingWebhookEvent>;
}

export class ShippingError extends Error {
  readonly code: string;
  readonly status_code?: number;
  readonly shippop_error_code?: string;
  constructor(
    code: string,
    message: string,
    extra?: { status_code?: number; shippop_error_code?: string }
  ) {
    super(message);
    this.name = "ShippingError";
    this.code = code;
    this.status_code = extra?.status_code;
    this.shippop_error_code = extra?.shippop_error_code;
  }
}
