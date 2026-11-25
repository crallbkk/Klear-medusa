import { requirePackedBeforeLabel } from "../require-packed";
import { LMS_MODULE } from "../../../../modules/lms/service";

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(job: unknown, opts: { actor?: string | null; id?: string | null } = {}) {
  const lms = {
    getJobByOrderId:
      job instanceof Error ? jest.fn().mockRejectedValue(job) : jest.fn().mockResolvedValue(job),
  };
  return {
    lms,
    req: {
      params: opts.id === null ? {} : { id: opts.id ?? "order_1" },
      auth_context: opts.actor === null ? undefined : { actor_id: opts.actor ?? "user_1" },
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === LMS_MODULE) return lms;
          throw new Error(`unexpected resolve(${key})`);
        }),
      },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (req: unknown, res: unknown, next: unknown) => requirePackedBeforeLabel(req as any, res as any, next as any);

describe("requirePackedBeforeLabel", () => {
  const saved = process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
  beforeEach(() => {
    process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = "true";
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
    else process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = saved;
  });

  it("does nothing at all unless the setting is exactly true", async () => {
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      if (value === undefined) delete process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
      else process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = value;
      const { req, lms } = makeReq({ stage: "printed" });
      const res = makeRes();
      const next = jest.fn();
      await run(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(lms.getJobByOrderId).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("refuses a label while the lab job is anywhere before packed", async () => {
    for (const stage of [
      "ready", "printed", "lens_issued", "sent_to_lab", "received_from_lab",
      "edged", "mounted", "qc_passed", "qc_failed",
    ]) {
      const { req } = makeReq({ stage });
      const res = makeRes();
      const next = jest.fn();
      await run(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json.mock.calls[0][0].message).toContain(stage);
    }
  });

  it("refuses a label for a lens order whose packet was never built", async () => {
    for (const status of ["pending_rx", "failed"]) {
      const { req } = makeReq({ stage: null, status });
      const res = makeRes();
      const next = jest.fn();
      await run(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(409);
    }
  });

  it("lets through a packed job, later parcels once the glasses are out, an order with no job, a job from before production and a cancelled job", async () => {
    for (const job of [
      { stage: "packed" },
      // A second parcel, a claim's replacement items, an accessory.
      { stage: "labelled" },
      { stage: "delivered" },
      null,
      { stage: null, status: "queued" },
      { stage: null, status: "submitted" },
      { stage: "cancelled" },
    ]) {
      const { req } = makeReq(job);
      const res = makeRes();
      const next = jest.fn();
      await run(req, res, next);
      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    }
  });

  it("says nothing about an order to a caller who is not signed in", async () => {
    const { req, lms } = makeReq({ stage: "printed" }, { actor: null });
    const res = makeRes();
    const next = jest.fn();
    await run(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(lms.getJobByOrderId).not.toHaveBeenCalled();
  });

  it("hands a lookup failure to the error handler; it never lets the label through on a guess", async () => {
    const boom = new Error("db down");
    const { req } = makeReq(boom);
    const res = makeRes();
    const next = jest.fn();
    await run(req, res, next);
    expect(next).toHaveBeenCalledWith(boom);
  });
});
