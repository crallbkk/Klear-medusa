import { ShippopProvider, mapShippopTrackingStatus } from "../providers/shippop";
import {
  ShippingError,
  type ThaiAddress,
  type ParcelDims,
} from "../types";

// Hand-rolled fetch mock matching the `FetchLike` shape in shippop.ts.
type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

function makeFetchMock(
  responses: Array<{ ok?: boolean; status?: number; body: string }>
): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch = (async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    calls.push({ url: input, init });
    const r = responses[i++];
    if (!r) throw new Error(`No mocked response at index ${i - 1}`);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      async text() {
        return r.body;
      },
    };
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const SAMPLE_FROM: ThaiAddress = {
  name: "Klear HQ",
  phone: "0800000000",
  address: "1/1 Sukhumvit 55",
  district: "Khlong Tan Nuea",
  state: "Watthana",
  province: "Bangkok",
  postcode: "10110",
};

const SAMPLE_TO: ThaiAddress = {
  name: "Customer",
  phone: "0800000001",
  address: "99/1",
  district: "Silom",
  state: "Bang Rak",
  province: "Bangkok",
  postcode: "10500",
};

const SAMPLE_PARCEL: ParcelDims = {
  weight_g: 300,
  length_cm: 18,
  width_cm: 8,
  height_cm: 6,
};

const CONFIG = {
  api_key: "test_key",
  api_base_url: "https://mall.shippop.com",
  webhook_path_secret: "wh_secret_abc",
};

describe("ShippopProvider", () => {
  it("getRates: posts JSON to /pricelist/ and maps the batched response", async () => {
    const { fetch, calls } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          data: {
            "0": {
              FLE: {
                courier_code: "FLE",
                courier_name: "FlashExpress",
                price: "32",
                estimate_time: "ภายใน 1 - 2 วัน",
                available: true,
              },
            },
          },
        }),
      },
    ]);
    const result = await new ShippopProvider(CONFIG, fetch as never).getRates({
      from: SAMPLE_FROM,
      to: SAMPLE_TO,
      parcel: SAMPLE_PARCEL,
      declared_value_thb: 1500,
      carriers: ["FLE"],
    });
    expect(result).toEqual([
      {
        carrier: "FLE",
        carrier_name: "FlashExpress",
        price_thb: 32,
        estimate_time: "ภายใน 1 - 2 วัน",
        available: true,
        remark: undefined,
      },
    ]);
    expect(calls[0].url).toBe("https://mall.shippop.com/pricelist/");
    const sentBody = JSON.parse(calls[0].init!.body!);
    expect(sentBody.api_key).toBe("test_key");
    expect(sentBody.data["0"].courier_code).toBe("FLE");
    expect(sentBody.data["0"].showall).toBe(1);
  });

  it("getRates: drops unavailable couriers", async () => {
    const { fetch } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          data: {
            "0": {
              FLE: { courier_code: "FLE", price: "32", available: true },
              EMST: { courier_code: "EMST", price: "52", available: false, err_code: "OUT_OF_ZONE" },
            },
          },
        }),
      },
    ]);
    const rates = await new ShippopProvider(CONFIG, fetch as never).getRates({
      from: SAMPLE_FROM,
      to: SAMPLE_TO,
      parcel: SAMPLE_PARCEL,
      declared_value_thb: 1500,
    });
    expect(rates.map((r) => r.carrier)).toEqual(["FLE"]);
  });

  it("getRates: throws ShippingError when Shippop returns status=false", async () => {
    const { fetch } = makeFetchMock([
      { body: JSON.stringify({ status: false, message: "API_KEY_INVALID" }) },
    ]);
    await expect(
      new ShippopProvider(CONFIG, fetch as never).getRates({
        from: SAMPLE_FROM,
        to: SAMPLE_TO,
        parcel: SAMPLE_PARCEL,
        declared_value_thb: 1500,
      })
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("createShipment: posts /booking/ then /confirm/, returns the tracking codes", async () => {
    const { fetch, calls } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          purchase_id: 452002,
          total_price: 32,
          data: {
            "0": {
              status: true,
              tracking_code: "SP452045855",
              courier_tracking_code: "TH123456789",
              courier_code: "FLE",
              price: 32,
            },
          },
        }),
      },
      {
        body: JSON.stringify({
          status: true,
          result: {
            "0": {
              status: true,
              tracking_code: "SP452045855",
              courier_tracking_code: "TH123456789",
              courier_code: "FLE",
            },
          },
        }),
      },
    ]);

    const shipment = await new ShippopProvider(CONFIG, fetch as never).createShipment({
      order_id: "order_01",
      from: SAMPLE_FROM,
      to: SAMPLE_TO,
      parcel: SAMPLE_PARCEL,
      declared_value_thb: 1500,
      carrier: "FLE",
      idempotency_key: "idem_001",
    });

    expect(shipment).toEqual({
      shipment_id: "SP452045855",
      courier_tracking_code: "TH123456789",
      purchase_id: 452002,
      carrier: "FLE",
      cost_thb: 32,
      status: "ready",
      confirmed: true,
    });
    expect(calls[0].url).toBe("https://mall.shippop.com/booking/");
    expect(calls[1].url).toBe("https://mall.shippop.com/confirm/");
    // /confirm/ uses urlencoded form body
    expect(calls[1].init!.headers!["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[1].init!.body).toContain("purchase_id=452002");
  });

  it("createShipment: skips /confirm/ when auto_confirm=false", async () => {
    const { fetch, calls } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          purchase_id: 555,
          data: {
            "0": {
              status: true,
              tracking_code: "SP555",
              courier_tracking_code: "TH555",
              courier_code: "EMST",
              price: 52,
            },
          },
        }),
      },
    ]);
    const shipment = await new ShippopProvider(CONFIG, fetch as never).createShipment({
      order_id: "order_02",
      from: SAMPLE_FROM,
      to: SAMPLE_TO,
      parcel: SAMPLE_PARCEL,
      declared_value_thb: 1500,
      carrier: "EMST",
      idempotency_key: "idem_002",
      auto_confirm: false,
    });
    expect(shipment.confirmed).toBe(false);
    expect(shipment.status).toBe("pending");
    expect(calls).toHaveLength(1);
  });

  it("createShipment: throws when the booking row reports status=false", async () => {
    const { fetch } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          purchase_id: 600,
          data: { "0": { status: false, message: "Invalid postcode" } },
        }),
      },
    ]);
    await expect(
      new ShippopProvider(CONFIG, fetch as never).createShipment({
        order_id: "order_03",
        from: SAMPLE_FROM,
        to: SAMPLE_TO,
        parcel: SAMPLE_PARCEL,
        declared_value_thb: 1500,
        carrier: "FLE",
        idempotency_key: "idem_003",
      })
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("getTracking: posts /tracking/ and maps states to canonical Klear statuses", async () => {
    const { fetch } = makeFetchMock([
      {
        body: JSON.stringify({
          status: true,
          order_status: "complete",
          courier_code: "FLE",
          tracking_code: "SP529189074",
          courier_tracking_code: "TH9999",
          states: [
            { status: "010", datetime: "2026-05-20 09:15:00", location: "Bangkok", description: "Shipment picked up" },
            { status: "045", datetime: "2026-05-20 14:00:00", location: "Bangkok", description: "Out for delivery" },
            { status: "POD", datetime: "2026-05-20 16:30:00", location: "Bangkok", description: "Delivered" },
          ],
        }),
      },
    ]);
    const events = await new ShippopProvider(CONFIG, fetch as never).getTracking("SP529189074");
    expect(events.map((e) => e.status)).toEqual(["picked_up", "out_for_delivery", "delivered"]);
    expect(events[0].raw_shippop_status).toBe("010");
    // Bangkok 09:15 → UTC 02:15
    expect(events[0].occurred_at).toBe("2026-05-20T02:15:00.000Z");
  });

  it("cancelShipment: posts to /cancel/ with the courier_tracking_code", async () => {
    const { fetch, calls } = makeFetchMock([{ body: JSON.stringify({ status: true }) }]);
    await new ShippopProvider(CONFIG, fetch as never).cancelShipment("TH9999");
    const body = JSON.parse(calls[0].init!.body!);
    expect(body.courier_tracking_code).toBe("TH9999");
    expect(body.api_key).toBe("test_key");
  });

  it("getLabelHtml: returns the HTML string from /label/", async () => {
    const { fetch } = makeFetchMock([
      { body: JSON.stringify({ status: true, html: "<html>label</html>" }) },
    ]);
    const html = await new ShippopProvider(CONFIG, fetch as never).getLabelHtml(452002);
    expect(html).toBe("<html>label</html>");
  });

  it("verifyAndParseWebhook: rejects requests without the path secret", async () => {
    const provider = new ShippopProvider(CONFIG, (() => {}) as never);
    await expect(
      provider.verifyAndParseWebhook({
        raw_body: "tracking_code=SP1&order_status=POD",
        headers: {},
      })
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("verifyAndParseWebhook: parses urlencoded body when path secret matches", async () => {
    const provider = new ShippopProvider(CONFIG, (() => {}) as never);
    const result = await provider.verifyAndParseWebhook({
      raw_body: "tracking_code=SP123&order_status=POD&courier_tracking_code=TH9&data%5Bdatetime%5D=2026-05-20+16%3A30%3A00",
      headers: {},
      path_secret: "wh_secret_abc",
    });
    expect(result.type).toBe("tracking_update");
    if (result.type === "tracking_update") {
      expect(result.event.shipment_id).toBe("SP123");
      expect(result.event.status).toBe("delivered");
      expect(result.event.occurred_at).toBe("2026-05-20T09:30:00.000Z");
    }
  });

  it("verifyAndParseWebhook: maps `fail` order_status to delivery_failed event", async () => {
    const provider = new ShippopProvider(CONFIG, (() => {}) as never);
    const result = await provider.verifyAndParseWebhook({
      raw_body: "tracking_code=SP456&order_status=fail&courier_tracking_code=TH8&data%5Bdatetime%5D=2026-05-20+14%3A00%3A00&data%5Breason%5D=no_one_home",
      headers: {},
      path_secret: "wh_secret_abc",
    });
    expect(result.type).toBe("delivery_failed");
    if (result.type === "delivery_failed") {
      expect(result.reason).toBe("no_one_home");
    }
  });

  it("HTTP-level failure raises a ShippingError with the status code", async () => {
    const { fetch } = makeFetchMock([{ ok: false, status: 502, body: "Bad Gateway" }]);
    try {
      await new ShippopProvider(CONFIG, fetch as never).getTracking("SP1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ShippingError);
      expect((err as ShippingError).status_code).toBe(502);
    }
  });
});

describe("mapShippopTrackingStatus", () => {
  it("maps documented codes correctly", () => {
    expect(mapShippopTrackingStatus("010")).toBe("picked_up");
    expect(mapShippopTrackingStatus("102")).toBe("in_transit");
    expect(mapShippopTrackingStatus("103")).toBe("in_transit");
    expect(mapShippopTrackingStatus("045")).toBe("out_for_delivery");
    expect(mapShippopTrackingStatus("POD")).toBe("delivered");
    expect(mapShippopTrackingStatus("complete")).toBe("delivered");
    expect(mapShippopTrackingStatus("cancel")).toBe("cancelled");
    expect(mapShippopTrackingStatus("return")).toBe("returned");
    expect(mapShippopTrackingStatus("fail")).toBe("delivery_failed");
  });

  it("falls back to in_transit (never delivered) for unknown codes", () => {
    expect(mapShippopTrackingStatus("999")).toBe("in_transit");
    expect(mapShippopTrackingStatus("")).toBe("in_transit");
  });
});
