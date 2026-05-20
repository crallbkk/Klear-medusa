import {
  type IShippingProvider,
  type RateQuoteInput,
  type RateQuote,
  type CreateShipmentInput,
  type Shipment,
  type ShipmentStatus,
  type ThaiAddress,
  type ThaiCarrier,
  type TrackingEvent,
  type ShippingWebhookEvent,
  ShippingError,
} from "../types";

// Shippop provider — real implementation.
//
// API reference: see SHIPPOP_API.md in this folder (extracted from the
// public Postman collection 2026-05-20).
//
// Endpoints used:
//   POST {base}/pricelist/            — rate quote (2.1.1)
//   POST {base}/booking/              — create + reserve shipment (3.1)
//   POST {base}/confirm/              — commit purchase_id (3.2)
//   POST {base}/cancel/               — cancel by courier_tracking_code (3.4)
//   POST {base}/tracking/             — pull tracking events (5.1)
//   POST {base}/label/                — fetch label HTML (6.1)
//
// Auth: Shippop accepts `api_key` as a top-level body field on JSON calls
// and as a form field on multipart calls. No Authorization header.

export interface ShippopConfig {
  api_key: string;
  api_base_url: string;
  /**
   * Secret embedded in the webhook callback URL (e.g.
   * https://api.klear.com/webhooks/shippop/<path_secret>). Shippop does
   * not sign webhook bodies; the path secret is our only authentication
   * surface unless we also IP-allowlist Shippop's egress.
   */
  webhook_path_secret: string;
}

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const TEN_MM_TO_CM = 0.1; // unused; keep for future if Shippop revises units

export class ShippopProvider implements IShippingProvider {
  readonly name = "shippop" as const;
  private readonly config: ShippopConfig;
  private readonly fetchImpl: FetchLike;

  constructor(config: ShippopConfig, fetchImpl: FetchLike = (globalThis as { fetch?: FetchLike }).fetch as FetchLike) {
    if (!fetchImpl) {
      throw new ShippingError(
        "no_fetch",
        "ShippopProvider requires a fetch implementation (global fetch or injected)."
      );
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async getRates(input: RateQuoteInput): Promise<RateQuote[]> {
    const carrierList = input.carriers && input.carriers.length > 0 ? input.carriers : [undefined];
    // Shippop's /pricelist/ is batched; we issue one row per requested carrier
    // (or one row with no courier_code + showall=1 when carriers is omitted).
    const data: Record<string, unknown> = {};
    carrierList.forEach((courier, idx) => {
      data[String(idx)] = {
        from: toShippopAddress(input.from),
        to: toShippopAddress(input.to),
        parcel: toShippopParcel(input.parcel),
        ...(courier ? { courier_code: courier } : {}),
        showall: 1,
      };
    });

    const body = JSON.stringify({ api_key: this.config.api_key, data });
    const res = await this.post("/pricelist/", body);

    if (!res.status) {
      throw new ShippingError("pricelist_failed", res.message ?? "Shippop returned status=false on /pricelist/");
    }

    const rates: RateQuote[] = [];
    const responseData = (res.data ?? {}) as Record<string, Record<string, ShippopRateRow>>;
    for (const row of Object.values(responseData)) {
      for (const [carrierCode, q] of Object.entries(row)) {
        if (!q.available) continue;
        rates.push({
          carrier: carrierCode as ThaiCarrier,
          carrier_name: q.courier_name ?? carrierCode,
          price_thb: Number(q.price),
          estimate_time: q.estimate_time ?? "",
          available: q.available,
          remark: q.remark,
        });
      }
    }
    return rates;
  }

  async createShipment(input: CreateShipmentInput): Promise<Shipment> {
    const bookingBody = JSON.stringify({
      api_key: this.config.api_key,
      email: input.from.email ?? "",
      data: [
        {
          from: toShippopAddress(input.from),
          to: toShippopAddress(input.to),
          parcel: toShippopParcel(input.parcel),
          courier_code: input.carrier,
          ...(input.reference
            ? {
                ref_no_1: input.reference.ref_no_1 ?? input.order_id,
                ref_no_2: input.reference.ref_no_2 ?? input.idempotency_key,
              }
            : { ref_no_1: input.order_id, ref_no_2: input.idempotency_key }),
        },
      ],
    });

    const booking = await this.post("/booking/", bookingBody);
    if (!booking.status) {
      throw new ShippingError("booking_failed", booking.message ?? "Shippop returned status=false on /booking/");
    }
    const first = (booking.data ?? {})["0"] as ShippopBookingRow | undefined;
    if (!first || !first.status) {
      throw new ShippingError("booking_row_failed", first?.message ?? "First row of /booking/ response was unsuccessful");
    }

    const purchaseId = booking.purchase_id as number;
    const autoConfirm = input.auto_confirm !== false;
    let confirmed = false;
    if (autoConfirm) {
      const confirmBody = new URLSearchParams({
        api_key: this.config.api_key,
        purchase_id: String(purchaseId),
      }).toString();
      const confirmRes = await this.postForm("/confirm/", confirmBody);
      if (!confirmRes.status) {
        throw new ShippingError(
          "confirm_failed",
          confirmRes.message ?? "Shippop returned status=false on /confirm/"
        );
      }
      const confirmRow = ((confirmRes.result ?? {}) as Record<string, ShippopConfirmRow>)["0"];
      if (confirmRow && confirmRow.status === false) {
        throw new ShippingError(
          "confirm_row_failed",
          confirmRow.message ?? "Confirm row reported failure"
        );
      }
      confirmed = true;
    }

    return {
      shipment_id: first.tracking_code,
      courier_tracking_code: first.courier_tracking_code,
      purchase_id: purchaseId,
      carrier: first.courier_code as ThaiCarrier,
      cost_thb: Number(first.price),
      status: confirmed ? "ready" : "pending",
      confirmed,
    };
  }

  async getTracking(shippop_tracking_code: string): Promise<TrackingEvent[]> {
    const body = JSON.stringify({ tracking_code: shippop_tracking_code });
    const res = await this.post("/tracking/", body);
    if (!res.status) {
      throw new ShippingError("tracking_failed", res.message ?? "Shippop returned status=false on /tracking/");
    }
    const states = (res.states ?? []) as ShippopTrackingState[];
    return states.map((s) => ({
      shipment_id: shippop_tracking_code,
      status: mapShippopTrackingStatus(s.status),
      occurred_at: bangkokToIso(s.datetime),
      location: s.location,
      raw_shippop_status: s.status,
      description: s.description,
    }));
  }

  async cancelShipment(courier_tracking_code: string): Promise<void> {
    const body = JSON.stringify({
      api_key: this.config.api_key,
      courier_tracking_code,
    });
    const res = await this.post("/cancel/", body);
    if (!res.status) {
      throw new ShippingError("cancel_failed", res.message ?? "Shippop returned status=false on /cancel/");
    }
  }

  async getLabelHtml(purchase_id: number): Promise<string> {
    const body = JSON.stringify({
      api_key: this.config.api_key,
      purchase_id: String(purchase_id),
      type: "html",
      size: "sticker4x6",
    });
    const res = await this.post("/label/", body);
    if (!res.status || typeof res.html !== "string") {
      throw new ShippingError("label_failed", res.message ?? "Shippop returned status=false or missing html on /label/");
    }
    return res.html;
  }

  async verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
    path_secret?: string;
  }): Promise<ShippingWebhookEvent> {
    // Shippop does not HMAC-sign webhook bodies. Authentication is via the
    // path secret embedded in the callback URL we registered with them.
    // Caller (Medusa API route) is responsible for extracting the path
    // segment and passing it here.
    if (!input.path_secret || input.path_secret !== this.config.webhook_path_secret) {
      throw new ShippingError("webhook_unauthorized", "Webhook path secret missing or invalid.");
    }

    const params = new URLSearchParams(input.raw_body);
    const trackingCode = params.get("tracking_code");
    const orderStatus = params.get("order_status");
    const courierTrackingCode = params.get("courier_tracking_code") ?? "";
    const datetime = params.get("data[datetime]") ?? new Date().toISOString();

    if (!trackingCode || !orderStatus) {
      throw new ShippingError(
        "webhook_malformed",
        "Webhook missing required fields tracking_code or order_status."
      );
    }

    const status = mapShippopTrackingStatus(orderStatus);
    const event: TrackingEvent = {
      shipment_id: trackingCode,
      status,
      occurred_at: bangkokToIso(datetime),
      raw_shippop_status: orderStatus,
      description: `${orderStatus} (courier ${courierTrackingCode})`,
    };

    if (status === "delivery_failed") {
      return {
        type: "delivery_failed",
        event,
        reason: params.get("data[reason]") ?? "unknown",
      };
    }
    return { type: "tracking_update", event };
  }

  // ─────────────────────────────────────────────────────────────────────

  private async post(path: string, body: string): Promise<ShippopEnvelope> {
    return this.request(path, body, "application/json");
  }

  private async postForm(path: string, body: string): Promise<ShippopEnvelope> {
    return this.request(path, body, "application/x-www-form-urlencoded");
  }

  private async request(path: string, body: string, contentType: string): Promise<ShippopEnvelope> {
    const url = `${trimTrailingSlash(this.config.api_base_url)}${path}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": contentType, accept: "application/json" },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ShippingError("http_error", `Shippop ${path} returned HTTP ${res.status}: ${text.slice(0, 500)}`, {
        status_code: res.status,
      });
    }
    try {
      return JSON.parse(text) as ShippopEnvelope;
    } catch {
      throw new ShippingError("invalid_json", `Shippop ${path} returned non-JSON body: ${text.slice(0, 500)}`);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function toShippopAddress(a: ThaiAddress): Record<string, string> {
  return {
    name: a.name,
    address: a.address,
    district: a.district,
    state: a.state,
    province: a.province,
    postcode: a.postcode,
    tel: a.phone,
    ...(a.email ? { email: a.email } : {}),
    ...(a.lat ? { lat: a.lat } : {}),
    ...(a.lng ? { lng: a.lng } : {}),
  };
}

function toShippopParcel(p: {
  weight_g: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
}): Record<string, number | string> {
  return {
    name: "-",
    weight: p.weight_g,
    width: p.width_cm,
    length: p.length_cm,
    height: p.height_cm,
  };
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Convert Shippop's "YYYY-MM-DD HH:mm:ss" Bangkok-local timestamp to an
 * ISO-8601 UTC string. Shippop never sends a timezone marker — empirically
 * the timestamps are Asia/Bangkok (UTC+7).
 */
function bangkokToIso(raw: string): string {
  if (!raw) return new Date().toISOString();
  // Already ISO?
  if (raw.includes("T")) return new Date(raw).toISOString();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return new Date().toISOString();
  const [, y, mo, d, h, mi, s] = match;
  // Build UTC date by subtracting Bangkok's UTC+7 offset.
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return new Date(asUtc - 7 * 60 * 60 * 1000).toISOString();
}

/**
 * Shippop forwards each underlying carrier's status code (numeric strings
 * like "010", "045", or letter codes like "POD"). The mapping below covers
 * the documented happy-path codes from the API docs; unknown codes fall
 * back to `in_transit` (safe default — never `delivered` unless we
 * recognise the code).
 *
 * Public for unit testing.
 */
export function mapShippopTrackingStatus(raw: string): ShipmentStatus {
  switch (raw) {
    case "010":
      return "picked_up";
    case "102":
    case "103":
      return "in_transit";
    case "045":
      return "out_for_delivery";
    case "POD":
    case "complete":
      return "delivered";
    case "cancel":
      return "cancelled";
    case "return":
      return "returned";
    case "fail":
      return "delivery_failed";
    case "ready":
      return "ready";
    default:
      return "in_transit";
  }
}

// ─── Shippop response envelopes (minimal, just what we consume) ──────

interface ShippopEnvelope {
  status: boolean;
  message?: string;
  data?: unknown;
  result?: unknown;
  purchase_id?: number;
  total_price?: number;
  states?: unknown;
  state?: unknown;
  html?: string;
  // Tracking-specific top-level fields we surface unchanged:
  order_status?: string;
  courier_code?: string;
  tracking_code?: string;
  courier_tracking_code?: string;
}

interface ShippopRateRow {
  courier_code: string;
  courier_name?: string;
  price: string | number;
  estimate_time?: string;
  available: boolean;
  remark?: string;
}

interface ShippopBookingRow {
  status: boolean;
  message?: string;
  tracking_code: string;
  courier_tracking_code: string;
  courier_code: string;
  price: string | number;
}

interface ShippopConfirmRow {
  status: boolean;
  message?: string;
  tracking_code: string;
  courier_tracking_code: string;
  courier_code: string;
}

interface ShippopTrackingState {
  status: string;
  datetime: string;
  location: string;
  description: string;
}
