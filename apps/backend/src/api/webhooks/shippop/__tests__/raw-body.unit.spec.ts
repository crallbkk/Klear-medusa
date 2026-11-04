import { extractRawBody } from "../raw-body";
import { ShippopProvider } from "../../../../modules/shipping/providers/shippop";

const SECRET = "path-secret";
const provider = new ShippopProvider(
  { api_key: "k", api_base_url: "https://example.test", webhook_path_secret: SECRET },
  async () => ({ ok: true, status: 200, text: async () => "{}" }),
);

// What Medusa's urlencoded parser (extended: true) makes of a Shippop body.
const PARSED_FAILED_DELIVERY = {
  tracking_code: "SP123",
  order_status: "fail",
  courier_tracking_code: "TH456",
  data: { datetime: "2026-11-04 10:00:00", reason: "ไม่มีผู้รับ" },
};

describe("extractRawBody (Shippop webhook)", () => {
  it("prefers the preserved raw body, byte for byte", () => {
    const raw = "tracking_code=SP1&order_status=POD&data%5Bdatetime%5D=2026-11-04+10%3A00%3A00";
    expect(extractRawBody({ rawBody: Buffer.from(raw), body: {} } as never)).toBe(raw);
    expect(extractRawBody({ rawBody: raw, body: {} } as never)).toBe(raw);
  });

  it("re-encodes a parsed nested body in bracket notation, not [object Object]", () => {
    const body = extractRawBody({ body: PARSED_FAILED_DELIVERY } as never);
    expect(body).not.toContain("object");
    const params = new URLSearchParams(body);
    expect(params.get("data[datetime]")).toBe("2026-11-04 10:00:00");
    expect(params.get("data[reason]")).toBe("ไม่มีผู้รับ");
    expect(params.get("tracking_code")).toBe("SP123");
  });

  it("keeps the delivery-failure reason and event time through the parser", async () => {
    const raw = extractRawBody({ body: PARSED_FAILED_DELIVERY } as never);
    const event = await provider.verifyAndParseWebhook({
      raw_body: raw,
      headers: {},
      path_secret: SECRET,
    });
    expect(event.type).toBe("delivery_failed");
    if (event.type !== "delivery_failed") throw new Error("unreachable");
    expect(event.reason).toBe("ไม่มีผู้รับ");
    // 10:00 Bangkok = 03:00 UTC
    expect(event.event.occurred_at).toBe("2026-11-04T03:00:00.000Z");
  });

  it("re-encodes arrays with indexes and empty values as empty strings", () => {
    const body = extractRawBody({ body: { a: ["x", "y"], b: null } } as never);
    const params = new URLSearchParams(body);
    expect(params.get("a[0]")).toBe("x");
    expect(params.get("a[1]")).toBe("y");
    expect(params.get("b")).toBe("");
  });

  it("returns an empty string with no body", () => {
    expect(extractRawBody({} as never)).toBe("");
  });
});
