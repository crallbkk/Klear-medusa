import orderPlacedHandler from "../order-placed";
import { LMS_MODULE } from "../../modules/lms/service";
import { buildLabJobPacket } from "../../modules/lms/build-packet";
import type { BuildPacketResult, LabJobPacket } from "../../modules/lms/types";
import { captureException } from "../../lib/observability/sentry";

jest.mock("../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

jest.mock("../../modules/lms/build-packet", () => ({
  buildLabJobPacket: jest.fn(),
}));

const mockBuild = buildLabJobPacket as jest.MockedFunction<
  typeof buildLabJobPacket
>;

function makeLms(overrides: Record<string, unknown> = {}) {
  return {
    getJobByOrderId: jest.fn().mockResolvedValue(null),
    createFromBuild: jest
      .fn()
      .mockResolvedValue({ id: "labjob_1", status: "queued" }),
    submitJob: jest
      .fn()
      .mockResolvedValue({ outcome: "queued_no_provider", job: {} }),
    ...overrides,
  };
}

// `null` orderId ⇒ an event with no id (distinct from the "order_1" default;
// passing `undefined` would trigger the default, so we use `null`).
function runHandler(lms: unknown, orderId: string | null = "order_1") {
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === LMS_MODULE) return lms;
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  return orderPlacedHandler({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: { data: orderId === null ? {} : { id: orderId } } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    container: container as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

const PACKET = { klear_order_id: "order_1" } as unknown as LabJobPacket;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("order-placed subscriber", () => {
  it("creates a queued job and submits on an ok build", async () => {
    mockBuild.mockResolvedValue({
      outcome: "ok",
      packet: PACKET,
    } as BuildPacketResult);
    const lms = makeLms();
    await runHandler(lms);
    expect(lms.createFromBuild).toHaveBeenCalledTimes(1);
    expect(lms.submitJob).toHaveBeenCalledWith("labjob_1");
  });

  it("is idempotent — skips build+create when a job already exists", async () => {
    const lms = makeLms({
      getJobByOrderId: jest.fn().mockResolvedValue({ id: "labjob_existing" }),
    });
    await runHandler(lms);
    expect(mockBuild).not.toHaveBeenCalled();
    expect(lms.createFromBuild).not.toHaveBeenCalled();
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("records a pending_rx row and does NOT submit", async () => {
    mockBuild.mockResolvedValue({
      outcome: "pending_rx",
      reason: "awaiting Rx",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    } as BuildPacketResult);
    const lms = makeLms({
      createFromBuild: jest
        .fn()
        .mockResolvedValue({ id: "labjob_2", status: "pending_rx" }),
    });
    await runHandler(lms);
    expect(lms.createFromBuild).toHaveBeenCalledTimes(1);
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("records a failed row and does NOT submit", async () => {
    mockBuild.mockResolvedValue({
      outcome: "failed",
      reason: "unknown lens type",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    } as BuildPacketResult);
    const lms = makeLms({
      createFromBuild: jest
        .fn()
        .mockResolvedValue({ id: "labjob_3", status: "failed" }),
    });
    await runHandler(lms);
    expect(lms.createFromBuild).toHaveBeenCalledTimes(1);
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("skips (no row) a frame-only order", async () => {
    mockBuild.mockResolvedValue({
      outcome: "skip",
      order_id: "order_1",
      reason: "frame-only",
    } as BuildPacketResult);
    const lms = makeLms();
    await runHandler(lms);
    expect(lms.createFromBuild).not.toHaveBeenCalled();
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("persists a durable failed row when the build throws", async () => {
    mockBuild.mockRejectedValue(new Error("order module exploded"));
    const created: BuildPacketResult[] = [];
    const lms = makeLms({
      createFromBuild: jest.fn(async (r: BuildPacketResult) => {
        created.push(r);
        return { id: "labjob_4", status: "failed" };
      }),
    });
    await runHandler(lms);
    expect(lms.createFromBuild).toHaveBeenCalledTimes(1);
    expect(created[0]!.outcome).toBe("failed");
    // The reason is stored on the job: a fixed sentence, not the error's text.
    expect(JSON.stringify(created[0])).not.toMatch(/exploded/);
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("logs and reports a failure by its kind, never the error's own text", async () => {
    const leaky = () =>
      Object.assign(new Error("insert into lab_job values ('LENS-SECRET-SKU', 'Somchai Secretname')"), {
        code: "23505",
      });
    // The build throws (a failed row is kept); on another order the build
    // is fine and the submit throws.
    mockBuild.mockRejectedValueOnce(leaky());
    await runHandler(makeLms());
    mockBuild.mockResolvedValueOnce({ outcome: "ok", packet: PACKET } as BuildPacketResult);
    await runHandler(makeLms({ submitJob: jest.fn().mockRejectedValue(leaky()) }), "order_2");
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    const sent = (captureException as jest.Mock).mock.calls
      .map((c) => `${String(c[0]?.message)}\n${String(c[0]?.stack)}`)
      .join("\n");
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(logged).not.toMatch(/SECRET|Secretname|insert into/);
    expect(sent).not.toMatch(/SECRET|Secretname|insert into/);
    expect(logged).toContain("Error/23505");
  });

  it("does nothing when the event has no order id", async () => {
    const lms = makeLms();
    await runHandler(lms, null);
    expect(lms.getJobByOrderId).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
  });
});
