import { ShippopFulfillmentService } from "../service";
import type {
  IShippingProvider,
  RateQuote,
  Shipment,
  TrackingEvent,
  ShippingWebhookEvent,
  ThaiAddress,
} from "../../types";

class StubProvider implements IShippingProvider {
  readonly name = "shippop" as const;
  calls: { method: string; args: unknown[] }[] = [];
  ratesResult: RateQuote[] = [
    { carrier: "FLE", carrier_name: "Flash Express", price_thb: 32, estimate_time: "1-2d", available: true },
  ];
  shipmentResult: Shipment = {
    shipment_id: "SP123",
    courier_tracking_code: "TH456",
    purchase_id: 7777,
    carrier: "FLE",
    cost_thb: 32,
    status: "ready",
    confirmed: true,
  };
  labelHtmlResult = "<html>label</html>";

  async getRates(input: unknown): Promise<RateQuote[]> {
    this.calls.push({ method: "getRates", args: [input] });
    return this.ratesResult;
  }
  async createShipment(input: unknown): Promise<Shipment> {
    this.calls.push({ method: "createShipment", args: [input] });
    return this.shipmentResult;
  }
  async getTracking(code: string): Promise<TrackingEvent[]> {
    this.calls.push({ method: "getTracking", args: [code] });
    return [];
  }
  async cancelShipment(awb: string): Promise<void> {
    this.calls.push({ method: "cancelShipment", args: [awb] });
  }
  async getLabelHtml(purchaseId: number): Promise<string> {
    this.calls.push({ method: "getLabelHtml", args: [purchaseId] });
    return this.labelHtmlResult;
  }
  async verifyAndParseWebhook(): Promise<ShippingWebhookEvent> {
    throw new Error("not used in adapter tests");
  }
}

const WAREHOUSE: ThaiAddress = {
  name: "Klear HQ",
  phone: "0800000000",
  address: "1/1 Sukhumvit 55",
  district: "Khlong Tan Nuea",
  state: "Watthana",
  province: "Bangkok",
  postcode: "10110",
};

const OPTIONS = {
  warehouse: WAREHOUSE,
  default_parcel: { weight_g: 300, length_cm: 18, width_cm: 8, height_cm: 6 },
};

const noopLogger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

function makeService(stub: StubProvider = new StubProvider()) {
  return new ShippopFulfillmentService(
    { logger: noopLogger as unknown as never },
    OPTIONS,
    stub
  );
}

describe("ShippopFulfillmentService — Medusa fulfillment adapter", () => {
  it("declares the static identifier 'shippop'", () => {
    expect(ShippopFulfillmentService.identifier).toBe("shippop");
  });

  it("getFulfillmentOptions returns the configured carrier list", async () => {
    const svc = makeService();
    const opts = await svc.getFulfillmentOptions();
    const ids = opts.map((o) => o.id);
    expect(ids).toContain("FLE");
    expect(ids).toContain("EMST");
    expect(ids).toContain("KRYX");
  });

  it("validateOption accepts known carrier codes and rejects unknown", async () => {
    const svc = makeService();
    expect(await svc.validateOption({ id: "FLE" })).toBe(true);
    expect(await svc.validateOption({ courier_code: "EMST" })).toBe(true);
    expect(await svc.validateOption({ id: "MADE_UP" })).toBe(false);
  });

  it("validateFulfillmentData injects courier_code from optionData onto method data", async () => {
    const svc = makeService();
    const out = await svc.validateFulfillmentData(
      { id: "FLE", courier_code: "FLE" } as Record<string, unknown>,
      { something_else: "x" } as Record<string, unknown>,
      {} as Parameters<typeof svc.validateFulfillmentData>[2]
    );
    expect(out).toEqual({ something_else: "x", courier_code: "FLE" });
  });

  it("validateFulfillmentData throws for an unrecognised courier", async () => {
    const svc = makeService();
    await expect(
      svc.validateFulfillmentData(
        { id: "MADE_UP" } as Record<string, unknown>,
        {} as Record<string, unknown>,
        {} as Parameters<typeof svc.validateFulfillmentData>[2]
      )
    ).rejects.toThrow(/MADE_UP/);
  });

  it("calculatePrice delegates to provider.getRates with the cart's shipping_address", async () => {
    const stub = new StubProvider();
    const svc = makeService(stub);
    const price = await svc.calculatePrice(
      { courier_code: "FLE", id: "FLE" } as Record<string, unknown>,
      {} as Record<string, unknown>,
      {
        shipping_address: {
          address_1: "99/1 Silom",
          city: "Bang Rak",
          province: "Bangkok",
          postal_code: "10500",
          phone: "0801112222",
          first_name: "Customer",
          last_name: "One",
        },
        subtotal: 3000,
      } as unknown as Parameters<typeof svc.calculatePrice>[2]
    );
    expect(price.calculated_amount).toBe(32);
    expect(price.is_calculated_price_tax_inclusive).toBe(true);
    expect(stub.calls[0].method).toBe("getRates");
    const input = stub.calls[0].args[0] as { carriers: string[]; to: { postcode: string } };
    expect(input.carriers).toEqual(["FLE"]);
    expect(input.to.postcode).toBe("10500");
  });

  it("calculatePrice throws when the cart has no Thai address", async () => {
    const svc = makeService();
    await expect(
      svc.calculatePrice(
        { courier_code: "FLE" } as Record<string, unknown>,
        {} as Record<string, unknown>,
        { shipping_address: undefined } as unknown as Parameters<typeof svc.calculatePrice>[2]
      )
    ).rejects.toThrow(/Thai shipping address/);
  });

  it("createFulfillment books a shipment and returns Shippop linkage in `data`", async () => {
    const stub = new StubProvider();
    const svc = makeService(stub);
    const result = await svc.createFulfillment(
      { courier_code: "FLE" } as Record<string, unknown>,
      [{ id: "li_1" } as Parameters<typeof svc.createFulfillment>[1][number]],
      {
        id: "order_01",
        shipping_address: {
          address_1: "99/1",
          city: "Bang Rak",
          province: "Bangkok",
          postal_code: "10500",
          phone: "0800000001",
          first_name: "Customer",
          last_name: "One",
        },
        metadata: { public_code: "KLR-ABCDEF" },
      } as unknown as Parameters<typeof svc.createFulfillment>[2],
      { id: "ful_1" } as unknown as Parameters<typeof svc.createFulfillment>[3]
    );
    expect(result.data).toMatchObject({
      shippop_tracking_code: "SP123",
      courier_tracking_code: "TH456",
      purchase_id: 7777,
      courier_code: "FLE",
      status: "ready",
    });
    expect(result.labels?.[0].tracking_number).toBe("SP123");
    expect(result.labels?.[0].tracking_url).toContain("SP123");

    const createCall = stub.calls.find((c) => c.method === "createShipment");
    const input = createCall!.args[0] as { reference: { ref_no_1: string; ref_no_2: string } };
    expect(input.reference.ref_no_1).toBe("order_01");
    expect(input.reference.ref_no_2).toBe("KLR-ABCDEF");
  });

  it("cancelFulfillment calls cancelShipment with the courier AWB from fulfillment data", async () => {
    const stub = new StubProvider();
    const svc = makeService(stub);
    await svc.cancelFulfillment({ courier_tracking_code: "TH9999" } as Record<string, unknown>);
    expect(stub.calls[0]).toEqual({ method: "cancelShipment", args: ["TH9999"] });
  });

  it("cancelFulfillment throws when data is missing courier_tracking_code", async () => {
    const svc = makeService();
    await expect(svc.cancelFulfillment({} as Record<string, unknown>)).rejects.toThrow(/courier_tracking_code/);
  });

  it("getShipmentDocuments returns label HTML from Shippop", async () => {
    const stub = new StubProvider();
    const svc = makeService(stub);
    const docs = await svc.getShipmentDocuments({ purchase_id: 7777 } as Record<string, unknown>);
    expect(docs).toHaveLength(1);
    expect((docs[0] as unknown as { html: string }).html).toBe("<html>label</html>");
  });

  it("createReturnFulfillment throws — return wiring blocked on LMS design", async () => {
    const svc = makeService();
    await expect(svc.createReturnFulfillment({})).rejects.toThrow(/LMS/);
  });
});
