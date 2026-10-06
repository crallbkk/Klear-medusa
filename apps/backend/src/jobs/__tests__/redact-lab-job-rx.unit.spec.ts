import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import redactLabJobRxJob, { config } from "../redact-lab-job-rx";
import { LMS_MODULE } from "../../modules/lms/service";
import {
  RX_REDACT_AFTER_DELIVERY_DAYS,
  RX_REDACT_MAX_AGE_DAYS,
} from "../../modules/lms/rx-retention";
import { captureException } from "../../lib/observability/sentry";

jest.mock("../../lib/observability/sentry", () => ({
  captureException: jest.fn(),
}));

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

type Candidate = {
  id: string;
  order_id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
  rx_redacted_at: null;
};

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  order_id: `order_${id}`,
  status: "queued",
  created_at: daysAgo(5),
  updated_at: daysAgo(5),
  rx_redacted_at: null,
  ...over,
});

type OrderRow = {
  id: string;
  canceled_at?: Date | null;
  fulfillments: Array<{ delivered_at: Date | null; canceled_at?: Date | null }>;
};

function setup(candidates: Candidate[], orders: OrderRow[] | Error) {
  const lms = {
    listJobsHoldingRx: jest.fn().mockResolvedValue(candidates),
    redactJobRx: jest.fn().mockResolvedValue(true),
  };
  const graph = jest.fn(async ({ filters }: { filters: { id: string[] } }) => {
    if (orders instanceof Error) throw orders;
    return { data: orders.filter((o) => filters.id.includes(o.id)) };
  });
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === LMS_MODULE) return lms;
      if (key === ContainerRegistrationKeys.QUERY) return { graph };
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { lms, graph, run: () => redactLabJobRxJob(container as any) };
}

let infoSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("redact-lab-job-rx scheduled job", () => {
  it("runs once a day", () => {
    expect(config.name).toBe("redact-lab-job-rx");
    expect(config.schedule).toBe("15 20 * * *");
  });

  it("does nothing, and asks for no orders, when no job holds a prescription", async () => {
    const { lms, graph, run } = setup([], []);
    await run();
    expect(graph).not.toHaveBeenCalled();
    expect(lms.redactJobRx).not.toHaveBeenCalled();
  });

  it("blanks exactly the jobs past a window and leaves every live one alone", async () => {
    const { lms, run } = setup(
      [
        cand("cancelled", { status: "cancelled" }),
        cand("order_cancelled"),
        cand("delivered_long_ago"),
        cand("delivered_recently"),
        cand("in_transit"),
        cand("no_fulfillment"),
        cand("order_gone"),
        cand("too_old", { created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1) }),
        cand("mid_submission", {
          status: "submitting",
          created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1),
          updated_at: new Date(),
        }),
      ],
      [
        // The lab job is still `queued`; only the Medusa order knows.
        { id: "order_order_cancelled", canceled_at: daysAgo(1), fulfillments: [] },
        {
          id: "order_delivered_long_ago",
          fulfillments: [{ delivered_at: daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS + 1) }],
        },
        {
          id: "order_delivered_recently",
          fulfillments: [{ delivered_at: daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS - 1) }],
        },
        { id: "order_in_transit", fulfillments: [{ delivered_at: null }] },
        { id: "order_no_fulfillment", fulfillments: [] },
      ],
    );
    await run();
    const blanked = lms.redactJobRx.mock.calls.map((c) => c[0]).sort();
    expect(blanked).toEqual([
      "cancelled",
      "delivered_long_ago",
      "order_cancelled",
      "too_old",
    ]);
  });

  it("reads delivery from the order's fulfillments, and nothing about the prescription", async () => {
    const { graph, run } = setup([cand("a")], []);
    await run();
    expect(graph).toHaveBeenCalledWith({
      entity: "order",
      fields: [
        "id",
        "canceled_at",
        "fulfillments.delivered_at",
        "fulfillments.canceled_at",
      ],
      filters: { id: ["order_a"] },
    });
  });

  it("when the order lookup fails, nothing is blanked on the order's say-so; the job's own status and age still apply", async () => {
    const { lms, run } = setup(
      [
        cand("delivered_long_ago"),
        cand("cancelled", { status: "cancelled" }),
        cand("too_old", { created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1) }),
      ],
      new Error("graph down"),
    );
    await run();
    const blanked = lms.redactJobRx.mock.calls.map((c) => c[0]).sort();
    expect(blanked).toEqual(["cancelled", "too_old"]);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("one failed batch of orders does not stop the other batches", async () => {
    const many = Array.from({ length: 150 }, (_, i) => cand(`j${i}`));
    const { lms, graph, run } = setup(
      many,
      many.map((c) => ({
        id: c.order_id,
        fulfillments: [{ delivered_at: daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS + 5) }],
      })),
    );
    graph.mockImplementationOnce(async () => {
      throw new Error("first batch failed");
    });
    await run();
    // The first 100 orders are unknown and kept; the last 50 are blanked.
    expect(lms.redactJobRx).toHaveBeenCalledTimes(50);
    expect(lms.redactJobRx.mock.calls[0][0]).toBe("j100");
  });

  it("counts a job that changed underneath (redactJobRx answered false) apart from the blanked ones", async () => {
    const { lms, run } = setup(
      [cand("a", { status: "cancelled" }), cand("b", { status: "cancelled" })],
      [],
    );
    lms.redactJobRx.mockImplementation(async (id: string) => id !== "b");
    await run();
    const line = infoSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(line).toMatch(/blanked 1 cancelled/);
    expect(line).toMatch(/1 changed underneath/);
  });

  it("one job's failure does not stop the rest", async () => {
    const { lms, run } = setup(
      [
        cand("a", { status: "cancelled" }),
        cand("b", { status: "cancelled" }),
        cand("c", { status: "cancelled" }),
      ],
      [],
    );
    lms.redactJobRx.mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("db write failed");
      return true;
    });
    await expect(run()).resolves.toBeUndefined();
    expect(lms.redactJobRx).toHaveBeenCalledTimes(3);
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        extra: { lab_job_id: "b", order_id: "order_b" },
      }),
    );
  });

  it("looks orders up in batches of 100, each order once", async () => {
    const many = Array.from({ length: 230 }, (_, i) => cand(`j${i}`));
    // Two candidate rows naming one order must not double the id.
    many.push(cand("dup", { order_id: "order_j0" }));
    const { graph, run } = setup(many, []);
    await run();
    expect(graph).toHaveBeenCalledTimes(3);
    const asked = graph.mock.calls.flatMap((c) => c[0].filters.id);
    expect(asked).toHaveLength(230);
    expect(new Set(asked).size).toBe(230);
  });

  it("logs counts only: no prescription value, no snapshot", async () => {
    const { run } = setup([cand("a", { status: "cancelled" })], []);
    await run();
    const logged = [...infoSpy.mock.calls, ...errorSpy.mock.calls]
      .map((c) => c.join(" "))
      .join("\n");
    expect(logged).toMatch(/blanked 1 cancelled/);
    expect(logged).not.toMatch(/sph|cyl|prescription":|packet_snapshot/i);
  });
});
