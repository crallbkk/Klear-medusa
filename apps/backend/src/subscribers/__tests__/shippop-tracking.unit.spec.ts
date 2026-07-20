import shippopTrackingHandler from "../shippop-tracking";
import { markOrderFulfillmentAsDeliveredWorkflow } from "@medusajs/medusa/core-flows";
import type { ShippingWebhookEvent } from "../../modules/shipping/types";

jest.mock("@medusajs/medusa/core-flows", () => ({
  markOrderFulfillmentAsDeliveredWorkflow: jest.fn(),
}));

const mockWorkflow = markOrderFulfillmentAsDeliveredWorkflow as unknown as jest.Mock;

const FULFILLMENT_ROW = {
  id: "ful_1",
  delivered_at: null as string | null,
  data: {
    courier_code: "FLE",
    shippop_tracking_code: "SP123",
    courier_tracking_code: "ST1ST",
  },
  labels: [
    {
      tracking_number: "SP123",
      tracking_url: "https://www.shippop.com/tracking/?tracking_code=SP123",
    },
  ],
  order: { id: "order_1" },
};

function makeContainer(graphData: unknown[]) {
  const graph = jest.fn().mockResolvedValue({ data: graphData });
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "query") return { graph };
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  return { container, graph };
}

function trackingUpdate(
  status: string,
  overrides: Record<string, unknown> = {},
): { data: ShippingWebhookEvent } {
  return {
    data: {
      type: "tracking_update",
      event: {
        shipment_id: "SP123",
        status: status as never,
        occurred_at: "2026-07-19T10:00:00.000Z",
        raw_shippop_status: "010",
        description: "picked up / รับพัสดุแล้ว",
        ...overrides,
      },
    } as ShippingWebhookEvent,
  };
}

function deliveryFailed(): { data: ShippingWebhookEvent } {
  return {
    data: {
      type: "delivery_failed",
      event: {
        shipment_id: "SP123",
        status: "delivery_failed" as never,
        occurred_at: "2026-07-19T12:00:00.000Z",
        raw_shippop_status: "fail",
        description: "delivery failed / จัดส่งไม่สำเร็จ",
      },
      reason: "customer unavailable",
    } as ShippingWebhookEvent,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function run(payload: { data: ShippingWebhookEvent }, container: any) {
  return shippopTrackingHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: payload as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    container: container as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

let fetchMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});

  mockWorkflow.mockReturnValue({ run: jest.fn().mockResolvedValue({}) });

  fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
  global.fetch = fetchMock as unknown as typeof fetch;

  process.env.KLEAR_STOREFRONT_URL = "https://kleareyes.com";
  process.env.KLEAR_CARRIER_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("shippop-tracking subscriber", () => {
  it("resolves the order and POSTs the storefront with derived carrier + tracking (picked_up)", async () => {
    const { container, graph } = makeContainer([FULFILLMENT_ROW]);
    await run(trackingUpdate("picked_up"), container);

    // Query was filtered by the SP code on the label tracking_number.
    expect(graph).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "fulfillment",
        filters: { labels: { tracking_number: ["SP123"] } },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://kleareyes.com/api/webhooks/carrier-status");
    expect(init.headers.authorization).toBe("Bearer test-secret");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      medusa_order_id: "order_1",
      status: "picked_up",
      carrier: "Flash Express",
      tracking_number: "SP123",
      tracking_url: "https://www.shippop.com/tracking/?tracking_code=SP123",
      occurred_at: "2026-07-19T10:00:00.000Z",
      shipment_id: "SP123",
      raw_status: "010",
    });

    // picked_up never touches the fulfillment.
    expect(mockWorkflow).not.toHaveBeenCalled();
  });

  it("unresolvable tracking code → warns with checked count, no POST, no workflow", async () => {
    const { container } = makeContainer([]); // no fulfillment matched
    await run(trackingUpdate("picked_up"), container);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWorkflow).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("no Medusa fulfillment matches tracking code SP123"),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("fulfillments checked: 0"),
    );
    // The empty-match path must NOT use the query-failed error wording.
    expect(console.error).not.toHaveBeenCalled();
  });

  it("graph query THROW → distinct loud error (misconfiguration wording), no POST, no workflow, no throw", async () => {
    const graph = jest.fn().mockRejectedValue(new Error("column labels.tracking_number does not exist"));
    const container = {
      resolve: jest.fn((key: string) => {
        if (key === "query") return { graph };
        throw new Error(`unexpected resolve(${key})`);
      }),
    };

    await expect(run(trackingUpdate("picked_up"), container)).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockWorkflow).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "fulfillment graph query FAILED — resolution may be misconfigured",
      ),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("column labels.tracking_number does not exist"),
    );
    // Distinct paths: the no-match warn must not fire on a query failure.
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("delivered fresh → marks the fulfillment delivered AND POSTs", async () => {
    const runStep = jest.fn().mockResolvedValue({});
    mockWorkflow.mockReturnValue({ run: runStep });
    const { container } = makeContainer([{ ...FULFILLMENT_ROW, delivered_at: null }]);

    await run(trackingUpdate("delivered", { raw_shippop_status: "POD" }), container);

    expect(mockWorkflow).toHaveBeenCalledTimes(1);
    expect(runStep).toHaveBeenCalledWith({
      input: { orderId: "order_1", fulfillmentId: "ful_1", no_notification: true },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.status).toBe("delivered");
  });

  it("delivered idempotency guard → already delivered_at → NO workflow, still POSTs", async () => {
    const { container } = makeContainer([
      { ...FULFILLMENT_ROW, delivered_at: "2026-07-19T11:00:00.000Z" },
    ]);

    await run(trackingUpdate("delivered", { raw_shippop_status: "POD" }), container);

    expect(mockWorkflow).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivery_failed → POSTs but never marks the fulfillment", async () => {
    const { container } = makeContainer([FULFILLMENT_ROW]);
    await run(deliveryFailed(), container);

    expect(mockWorkflow).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.status).toBe("delivery_failed");
    expect(body.raw_status).toBe("fail");
  });

  it("POST retry-then-fail is contained → 3 attempts, one loud error, no throw", async () => {
    jest.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("network down"));
    const { container } = makeContainer([FULFILLMENT_ROW]);

    const p = run(trackingUpdate("picked_up"), container);
    await jest.advanceTimersByTimeAsync(8000); // flush the 2s + 5s backoffs
    await expect(p).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("storefront POST failed after 3 attempts"),
    );
  });

  it("env missing → skips the POST, never crashes (delivered mark still runs)", async () => {
    delete process.env.KLEAR_STOREFRONT_URL;
    delete process.env.KLEAR_CARRIER_WEBHOOK_SECRET;
    const runStep = jest.fn().mockResolvedValue({});
    mockWorkflow.mockReturnValue({ run: runStep });
    const { container } = makeContainer([FULFILLMENT_ROW]);

    await run(trackingUpdate("delivered", { raw_shippop_status: "POD" }), container);

    // delivered marking is Medusa-internal — independent of storefront env.
    expect(runStep).toHaveBeenCalledTimes(1);
    // POST skipped.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
