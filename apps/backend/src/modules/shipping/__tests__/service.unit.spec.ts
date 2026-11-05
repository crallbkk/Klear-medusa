import ShippingModuleService, { SHIPPING_MODULE } from "../service";
import { ShippingError, type ThaiAddress, type ParcelDims } from "../types";

const sampleAddress: ThaiAddress = {
  name: "Test Recipient",
  phone: "0812345678",
  address: "123 Sukhumvit",
  district: "Khlong Tan",
  state: "Khlong Toei",
  province: "Bangkok",
  postcode: "10110",
};

const sampleParcel: ParcelDims = {
  weight_g: 300,
  length_cm: 18,
  width_cm: 8,
  height_cm: 6,
};

describe("ShippingModuleService — interface shape", () => {
  // Force unconfigured branch regardless of host env.
  const originalKey = process.env.SHIPPOP_API_KEY;
  const originalBase = process.env.SHIPPOP_API_BASE_URL;
  const originalSecret = process.env.SHIPPOP_WEBHOOK_SECRET;

  beforeEach(() => {
    delete process.env.SHIPPOP_API_KEY;
    delete process.env.SHIPPOP_API_BASE_URL;
    delete process.env.SHIPPOP_WEBHOOK_SECRET;
  });

  afterAll(() => {
    if (originalKey !== undefined) process.env.SHIPPOP_API_KEY = originalKey;
    if (originalBase !== undefined) process.env.SHIPPOP_API_BASE_URL = originalBase;
    if (originalSecret !== undefined) process.env.SHIPPOP_WEBHOOK_SECRET = originalSecret;
  });

  it("uses a Klear-specific module key (distinct from Medusa's built-in fulfillment)", () => {
    expect(SHIPPING_MODULE).toBe("klear_shipping");
  });

  it("exposes the full IShippingProvider surface plus provider/carrier accessors", () => {
    const svc = new ShippingModuleService();
    expect(typeof svc.getRates).toBe("function");
    expect(typeof svc.createShipment).toBe("function");
    expect(typeof svc.getTracking).toBe("function");
    expect(typeof svc.cancelShipment).toBe("function");
    expect(typeof svc.verifyAndParseWebhook).toBe("function");
    expect(typeof svc.getProviderName).toBe("function");
    expect(typeof svc.getDefaultCarrier).toBe("function");
  });

  it("provider name is 'shippop' (aggregator chosen 2026-05-20)", () => {
    const svc = new ShippingModuleService();
    expect(svc.getProviderName()).toBe("shippop");
  });

  it("default carrier defaults to 'FLE' (Flash Express) when env not set", () => {
    const svc = new ShippingModuleService();
    expect(svc.getDefaultCarrier()).toBe("FLE");
  });

  it("default carrier honours SHIPPING_DEFAULT_CARRIER env override", () => {
    process.env.SHIPPING_DEFAULT_CARRIER = "EMST";
    const svc = new ShippingModuleService();
    expect(svc.getDefaultCarrier()).toBe("EMST");
    delete process.env.SHIPPING_DEFAULT_CARRIER;
  });

  it("getRates throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(
      svc.getRates({
        from: sampleAddress,
        to: sampleAddress,
        parcel: sampleParcel,
        declared_value_thb: 1500,
      })
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("createShipment throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(
      svc.createShipment({
        order_id: "order_1",
        from: sampleAddress,
        to: sampleAddress,
        parcel: sampleParcel,
        declared_value_thb: 1500,
        idempotency_key: "idem_1",
      })
    ).rejects.toBeInstanceOf(ShippingError);
  });

  it("getTracking throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(svc.getTracking("SP123")).rejects.toBeInstanceOf(ShippingError);
  });

  it("cancelShipment throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(svc.cancelShipment("TH123456789")).rejects.toBeInstanceOf(
      ShippingError
    );
  });

  it("getLabelHtml throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(svc.getLabelHtml(452002)).rejects.toBeInstanceOf(
      ShippingError
    );
  });

  it("verifyAndParseWebhook throws ShippingError(not_configured) without an API key", async () => {
    const svc = new ShippingModuleService();
    await expect(
      svc.verifyAndParseWebhook({ raw_body: "{}", headers: {} })
    ).rejects.toBeInstanceOf(ShippingError);
  });
});

describe("ShippingModuleService — constructed the way Medusa constructs it", () => {
  const PREV = { ...process.env };
  afterEach(() => {
    process.env = { ...PREV };
  });

  it("ignores Medusa's module-options arg and uses the real Shippop provider", async () => {
    process.env.SHIPPOP_API_KEY = "k";
    process.env.SHIPPOP_API_BASE_URL = "https://shippop.test";
    process.env.SHIPPOP_WEBHOOK_PATH_SECRET = "path-secret";
    // Medusa: new Service(container, moduleOptions)
    const svc = new ShippingModuleService({}, {});
    const event = await svc.verifyAndParseWebhook({
      raw_body: "tracking_code=SP1&order_status=POD",
      headers: {},
      path_secret: "path-secret",
    });
    expect(event.type).toBe("tracking_update");
    expect(event.event.status).toBe("delivered");
  });

  it("falls back to the unconfigured provider (not the options object) without env", async () => {
    delete process.env.SHIPPOP_API_KEY;
    const svc = new ShippingModuleService({}, {});
    await expect(
      svc.verifyAndParseWebhook({ raw_body: "", headers: {}, path_secret: "x" }),
    ).rejects.toMatchObject({ code: "not_configured" });
  });
});
