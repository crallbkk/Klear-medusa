import { MedusaError } from "@medusajs/framework/utils";
import { POST } from "../[id]/retry/route";
import { LMS_MODULE } from "../../../../modules/lms/service";
import { buildLabJobPacket } from "../../../../modules/lms/build-packet";
import type { BuildPacketResult } from "../../../../modules/lms/types";

jest.mock("../../../../modules/lms/build-packet", () => ({
  buildLabJobPacket: jest.fn(),
}));

const mockBuild = buildLabJobPacket as jest.MockedFunction<
  typeof buildLabJobPacket
>;

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

  it("400s when the id param is missing", async () => {
    const lms = makeLms();
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(makeReq(lms, null) as any, res as any);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(lms.retrieveLabJob).not.toHaveBeenCalled();
  });
});
