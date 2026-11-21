import { MedusaError } from "@medusajs/framework/utils";
import { captureException } from "../../../../lib/observability/sentry";
import { POST } from "../[id]/retry/route";
import {
  LMS_MODULE,
  LabJobNotRebuildableError,
  ProductionWriteError,
} from "../../../../modules/lms/service";
import { buildLabJobPacket } from "../../../../modules/lms/build-packet";
import type { BuildPacketResult } from "../../../../modules/lms/types";

jest.mock("../../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));
jest.mock("../../../../modules/lms/build-packet", () => ({
  buildLabJobPacket: jest.fn(),
}));

const mockBuild = buildLabJobPacket as jest.MockedFunction<
  typeof buildLabJobPacket
>;

const okResult = () =>
  ({
    outcome: "ok",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    packet: { klear_order_id: "order_1" } as any,
  }) as BuildPacketResult;

function makeLms(overrides: Record<string, unknown> = {}) {
  return {
    retrieveLabJob: jest
      .fn()
      .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "failed" }),
    updateJobFromBuild: jest
      .fn()
      .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "queued" }),
    submitJob: jest
      .fn()
      .mockResolvedValue({ outcome: "queued_no_provider", job: { id: "labjob_1" } }),
    ...overrides,
  };
}

function makeRes() {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

// `null` id ⇒ request with no id param (passing `undefined` would trigger
// the default, so we use `null` as the sentinel).
function makeReq(lms: unknown, id: string | null = "labjob_1") {
  return {
    params: id === null ? {} : { id },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === LMS_MODULE) return lms;
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("POST /admin/lab-jobs/[id]/retry", () => {
  it("404s when the job does not exist (MedusaError NOT_FOUND)", async () => {
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockRejectedValue(
          new MedusaError(MedusaError.Types.NOT_FOUND, "LabJob not found"),
        ),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("500s (not 400) when retrieve fails for infra reasons", async () => {
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockRejectedValue(new Error("connection refused")),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("400s a cancelled job", async () => {
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "cancelled" }),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("409s a job whose submission claim is in flight (submitting)", async () => {
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "submitting" }),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockBuild).not.toHaveBeenCalled();
    expect(lms.updateJobFromBuild).not.toHaveBeenCalled();
  });

  it("no-ops a submitted job (idempotent, no rebuild)", async () => {
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "submitted" }),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "submitted" }),
    );
    expect(mockBuild).not.toHaveBeenCalled();
    expect(lms.updateJobFromBuild).not.toHaveBeenCalled();
    expect(lms.submitJob).not.toHaveBeenCalled();
  });

  it("heals a pending_rx job: rebuild ok → update → submit", async () => {
    mockBuild.mockResolvedValue({
      outcome: "ok",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      packet: { klear_order_id: "order_1" } as any,
    } as BuildPacketResult);
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "pending_rx" }),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(mockBuild).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "order_1" }),
    );
    expect(lms.updateJobFromBuild).toHaveBeenCalledWith(
      "labjob_1",
      expect.objectContaining({ outcome: "ok" }),
    );
    expect(lms.submitJob).toHaveBeenCalledWith("labjob_1");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "queued_no_provider" }),
    );
  });

  it("does NOT submit when the rebuild is still pending_rx", async () => {
    mockBuild.mockResolvedValue({
      outcome: "pending_rx",
      reason: "still awaiting Rx",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    } as BuildPacketResult);
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "pending_rx" }),
      updateJobFromBuild: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "pending_rx" }),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(lms.submitJob).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "pending_rx",
        reason: "still awaiting Rx",
      }),
    );
  });

  it("does NOT submit when the rebuild still fails, and refreshes the reason", async () => {
    mockBuild.mockResolvedValue({
      outcome: "failed",
      reason: "prescription signature invalid — possible tampering",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    } as BuildPacketResult);
    const lms = makeLms();
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(lms.submitJob).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failed" }),
    );
  });

  it("500s when the rebuild throws (infra failure is not a bad request)", async () => {
    mockBuild.mockRejectedValue(new Error("order module down"));
    const lms = makeLms();
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("never echoes an error's own text in its answer or its log line", async () => {
    // A database error's text is the SQL with its values written in.
    // Over several lines, one of which starts like a stack frame.
    mockBuild.mockRejectedValue(
      new Error(
        ['insert into "lab_job" ... sph_right -2.25 ...', "    at time zone Somchai Secretname", " values (...)"].join(
          String.fromCharCode(10),
        ),
      ),
    );
    const logged = jest.spyOn(console, "error").mockImplementation(() => {});
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(makeLms()) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(500);
    const reported = (captureException as jest.Mock).mock.calls
      .map((c) => `${String(c[0]?.message)} ${String(c[0]?.stack)} ${JSON.stringify(c[1])}`)
      .join(" ");
    expect((captureException as jest.Mock).mock.calls.length).toBeGreaterThan(0);
    // What is reported still says where the failure came from.
    const sent = (captureException as jest.Mock).mock.calls.at(-1)[0] as Error;
    expect(sent.stack).toMatch(/retry\.unit\.spec\.ts:\d+:\d+/);
    const said =
      JSON.stringify(res.json.mock.calls) + JSON.stringify(logged.mock.calls) + reported;
    logged.mockRestore();
    expect(said).not.toMatch(/sph_right|2\.25|Secretname|lab_job"/);
  });

  it("answers in its own words when the failure is one this code describes itself", async () => {
    mockBuild.mockResolvedValue(okResult());
    // A failed save: built from the error code alone, so safe to show.
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "pending_rx" }),
      updateJobFromBuild: jest.fn().mockRejectedValue(
        new ProductionWriteError({ code: "23502", constraint: "lab_job_status_check" }),
      ),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json.mock.calls[0][0].error).toMatch(/could not be saved \(database error 23502/);
    // Reported as itself, so Sentry keeps where it came from.
    const last = (captureException as jest.Mock).mock.calls.at(-1);
    expect(last[0]).toBeInstanceOf(ProductionWriteError);
  });

  it("409s when the job moved on while it was being rebuilt", async () => {
    mockBuild.mockResolvedValue(okResult());
    const lms = makeLms({
      retrieveLabJob: jest
        .fn()
        .mockResolvedValue({ id: "labjob_1", order_id: "order_1", status: "pending_rx" }),
      updateJobFromBuild: jest.fn().mockRejectedValue(
        new LabJobNotRebuildableError("updateJobFromBuild: job labjob_1 is submitted"),
      ),
    });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (captureException as jest.Mock).mockClear();
    await POST(makeReq(lms) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(409);
    // The job simply moved on: nothing to report.
    expect(captureException).not.toHaveBeenCalled();
  });

  it("400s when the id param is missing", async () => {
    const lms = makeLms();
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms, null) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(lms.retrieveLabJob).not.toHaveBeenCalled();
  });
});
