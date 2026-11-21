// What the lab's screens are told by the routes they read: the board's
// columns and overdue flags, the buttons a job offers, and the report.

import { GET as production } from "../[id]/production/route";
import { GET as queue } from "../../lab-queue/route";
import { GET as reports } from "../../lab-reports/route";
import { POST as warrantyRemake } from "../[id]/warranty-remake/route";
import { startWarrantyRemake } from "../../../../modules/lms/rebuild";
import { ProductionError } from "../../../../modules/lms/production";
import { LMS_MODULE } from "../../../../modules/lms/service";
import { OVERDUE_AFTER_HOURS, OVERDUE_WAITING_HOURS } from "../../../../modules/lms/board";
import { captureException } from "../../../../lib/observability/sentry";

jest.mock("../../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));
jest.mock("../../../../modules/lms/rebuild", () => ({ startWarrantyRemake: jest.fn() }));
const mockRemake = startWarrantyRemake as jest.MockedFunction<typeof startWarrantyRemake>;

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
function makeReq(lms: unknown, query: object = {}) {
  return {
    params: { id: "labjob_1" },
    body: {},
    query,
    auth_context: { actor_id: "user_lab", actor_type: "user" },
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === LMS_MODULE) return lms;
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (handler: any, req: unknown, res: unknown) => handler(req as any, res as any);

const JOB = {
  id: "labjob_1",
  order_id: "order_1",
  status: "queued",
  stage: "printed",
  stage_version: 2,
  event_seq: 5,
  updated_at: "2026-11-21T05:00:00.000Z",
  remake_count: 0,
  on_hold: false,
  cut_question_pending: false,
  next_issue_reason: "order",
  packet_snapshot: { prescription: { sph_right: -2.25 } },
};

describe("GET /admin/lab-queue", () => {
  it("gives each job its column and whether it is overdue, and counts both", async () => {
    const hours = (h: number) => new Date(Date.now() - h * 3600_000);
    const lms = {
      listQueue: jest.fn().mockResolvedValue([
        { id: "old", stage: "ready", status: "queued", on_hold: false, cut_question_pending: false,
          stage_since: hours(OVERDUE_AFTER_HOURS.ready! + 2) },
        { id: "new", stage: "ready", status: "queued", on_hold: false, cut_question_pending: false,
          stage_since: hours(1) },
        { id: "held", stage: "edged", status: "queued", on_hold: true, cut_question_pending: false,
          stage_since: hours(5000) },
        { id: "stuck", stage: null, status: "failed", on_hold: false, cut_question_pending: false,
          stage_since: null, created_at: hours(OVERDUE_WAITING_HOURS.packet_failed + 2) },
      ]),
    };
    const res = makeRes();
    await call(queue, makeReq(lms), res);
    const body = res.json.mock.calls[0][0];
    expect(body.jobs.map((j: { id: string; column: string; overdue: boolean }) => [j.id, j.column, j.overdue])).toEqual([
      ["old", "ready", true],
      ["new", "ready", false],
      ["held", "on_hold", false],
      ["stuck", "packet_failed", true],
    ]);
    expect(body.counts).toEqual({ ready: 2, on_hold: 1, packet_failed: 1 });
    expect(body.overdue).toBe(2);
    expect(body.overdue_after_hours).toEqual({ ...OVERDUE_AFTER_HOURS, ...OVERDUE_WAITING_HOURS });
    expect(body.truncated).toBe(false);
  });
});

describe("GET /admin/lab-jobs/[id]/production", () => {
  const lmsFor = (job: object, costs: object[] = []) => ({
    retrieveLabJob: jest.fn().mockResolvedValue(job),
    listProductionEventsForJob: jest.fn().mockResolvedValue([]),
    listLabCosts: jest.fn().mockResolvedValue(costs),
    listLabVendors: jest.fn().mockResolvedValue(["Bangkok Optics"]),
  });

  it("says which buttons the job offers, split by the permission each needs", async () => {
    const res = makeRes();
    await call(production, makeReq(lmsFor(JOB)), res);
    const body = res.json.mock.calls[0][0];
    // A printed job: issue a lens or send it out; a frame can break; a note.
    expect(body.actions.lab.sort()).toEqual(["FRAME_DAMAGED", "LENS_ISSUED", "NOTE", "SENT_TO_LAB"]);
    expect(body.actions.ops).toEqual(["HOLD"]);
    expect([body.actions.packet, body.actions.retry, body.actions.rx_changed]).toEqual([
      true,
      false,
      true,
    ]);
    expect(body.vendors).toEqual(["Bangkok Optics"]);
    // The screen builds its request keys from these and checks a shown
    // packet against `updated_at`. Without them it would misbehave quietly.
    expect([body.job.stage_version, body.job.event_seq, body.job.updated_at]).toEqual([
      2,
      5,
      "2026-11-21T05:00:00.000Z",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/sph_right|packet_snapshot/);
  });

  it("offers the invoice only while a quote is waiting for one", async () => {
    const open = { id: "c1", invoiced_satang: null };
    const paid = { id: "c2", invoiced_satang: 500 };
    for (const [costs, offered] of [
      [[], false],
      [[paid], false],
      [[paid, open], true],
    ] as const) {
      const res = makeRes();
      await call(production, makeReq(lmsFor(JOB, [...costs])), res);
      expect(res.json.mock.calls[0][0].actions.lab.includes("LAB_INVOICED")).toBe(offered);
    }
  });

  it("offers release, not hold, on a held job, and the cut answers on an open question", async () => {
    const res = makeRes();
    await call(
      production,
      makeReq(lmsFor({ ...JOB, stage: "cancelled", status: "cancelled", cut_question_pending: true })),
      res,
    );
    expect(res.json.mock.calls[0][0].actions.lab.sort()).toEqual([
      "LENS_CUT_CONFIRMED",
      "LENS_RETURNED_UNUSED",
      "NOTE",
    ]);
    const held = makeRes();
    await call(production, makeReq(lmsFor({ ...JOB, on_hold: true })), held);
    expect(held.json.mock.calls[0][0].actions.ops).toEqual(["RELEASE"]);
  });

  it("does not offer a step the writer would refuse for want of a packet", async () => {
    const res = makeRes();
    await call(production, makeReq(lmsFor({ ...JOB, stage: "ready", status: "pending_rx" })), res);
    const { actions } = res.json.mock.calls[0][0];
    expect(actions.lab.includes("PRINTED")).toBe(false);
    expect([actions.packet, actions.retry]).toEqual([false, true]);

    const blanked = makeRes();
    await call(
      production,
      makeReq(lmsFor({ ...JOB, stage: "delivered", status: "submitted", rx_redacted_at: new Date() })),
      blanked,
    );
    expect(blanked.json.mock.calls[0][0].actions.lab.includes("REMAKE_STARTED")).toBe(false);
    expect(blanked.json.mock.calls[0][0].actions.rx_changed).toBe(false);
    // A provider has that packet, so it cannot be rewritten for a remake.
    expect(blanked.json.mock.calls[0][0].actions.warranty_remake).toBe(false);

    const ours = makeRes();
    await call(
      production,
      makeReq(lmsFor({ ...JOB, stage: "delivered", status: "queued", rx_redacted_at: new Date() })),
      ours,
    );
    expect(ours.json.mock.calls[0][0].actions.warranty_remake).toBe(true);
  });

  it("offers no step on a job that is not in production", async () => {
    const res = makeRes();
    await call(production, makeReq(lmsFor({ ...JOB, stage: null, status: "pending_rx" })), res);
    expect(res.json.mock.calls[0][0].actions).toEqual({
      lab: ["NOTE"],
      ops: [],
      packet: false,
      retry: true,
      rx_changed: false,
      warranty_remake: false,
    });
  });
});

describe("POST /admin/lab-jobs/[id]/warranty-remake", () => {
  const body = {
    action: "REMAKE_STARTED",
    idempotency_key: "screen-key-0001",
    expected_version: 9,
    detail: { cause: "scratched" },
  };
  const post = (b: object, auth: object | null = { actor_id: "user_ops", actor_type: "user" }) => ({
    ...makeReq({}),
    body: b,
    auth_context: auth ?? undefined,
  });

  beforeEach(() => mockRemake.mockReset());

  it("fetches the prescription and starts the remake as the signed-in user", async () => {
    mockRemake.mockResolvedValue({
      outcome: "started",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result: { event: { id: "e1" }, job: { id: "labjob_1", stage: "printed" }, replayed: false } as any,
    });
    const res = makeRes();
    await call(warrantyRemake, post({ ...body, actor: "someone else" }), res);
    expect(mockRemake).toHaveBeenCalledWith(expect.anything(), {
      job_id: "labjob_1",
      idempotency_key: "screen-key-0001",
      expected_version: 9,
      cause: "scratched",
      actor_id: "user_ops",
    });
    expect(res.json.mock.calls[0][0].job.stage).toBe("printed");
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/packet|sph_/);
  });

  it("answers 422 in fixed words when the prescription cannot be fetched", async () => {
    mockRemake.mockResolvedValue({ outcome: "not_built", buildOutcome: "failed" });
    const res = makeRes();
    await call(warrantyRemake, post(body), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json.mock.calls[0][0].message).toMatch(/could not be fetched/);
  });

  it("takes a remake and nothing else, from a person only", async () => {
    for (const action of ["PRINTED", "HOLD", "RX_CHANGED", "PACKET_VIEWED"]) {
      const res = makeRes();
      await call(warrantyRemake, post({ ...body, action }), res);
      expect([action, res.status.mock.calls[0]?.[0]]).toEqual([action, 400]);
    }
    const key = makeRes();
    await call(warrantyRemake, post(body, { actor_id: "apk_1", actor_type: "api-key" }), key);
    expect(key.status).toHaveBeenCalledWith(403);
    const nobody = makeRes();
    await call(warrantyRemake, post(body, null), nobody);
    expect(nobody.status).toHaveBeenCalledWith(401);
    expect(mockRemake).not.toHaveBeenCalled();
  });

  it("refuses a malformed request before a job is read or a prescription fetched", async () => {
    for (const wrong of [
      { ...body, idempotency_key: "short" },
      { ...body, idempotency_key: "k".repeat(201) },
      { ...body, expected_version: undefined },
      { ...body, detail: {} },
      { ...body, detail: { cause: "   " } },
      { ...body, detail: { cause: 5 } },
      { ...body, detail: { cause: "c".repeat(501) } },
      { ...body, detail: undefined },
    ]) {
      const res = makeRes();
      await call(warrantyRemake, post(wrong), res);
      expect([JSON.stringify(wrong).slice(0, 60), res.status.mock.calls[0]?.[0]]).toEqual([
        JSON.stringify(wrong).slice(0, 60),
        400,
      ]);
    }
    expect(mockRemake).not.toHaveBeenCalled();
  });

  it("answers a rule's refusal with its own sentence", async () => {
    mockRemake.mockRejectedValue(
      new ProductionError("not_allowed", "a warranty remake starts from a labelled or delivered job; this one is edged"),
    );
    const res = makeRes();
    await call(warrantyRemake, post(body), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toMatch(/labelled or delivered/);
  });

  it("never echoes an unexpected error's own text", async () => {
    mockRemake.mockRejectedValue(new Error("decrypt: sph_right -2.25 for Somchai"));
    const res = makeRes();
    await call(warrantyRemake, post(body), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/sph_right|Somchai/);
  });
});

describe("GET /admin/lab-reports", () => {
  it("passes the number of weeks asked for, 12 when none or nonsense", async () => {
    const report = { from: "2026-08-31", weeks: [], jobs: [] };
    const lms = { productionReport: jest.fn().mockResolvedValue(report) };
    for (const [query, weeks] of [
      [{}, 12],
      [{ weeks: "4" }, 4],
      [{ weeks: "abc" }, 12],
      [{ weeks: ["3", "9"] }, 12],
      [{ weeks: "4.5" }, 12],
      [{ weeks: "0" }, 1],
      [{ weeks: "52" }, 52],
      [{ weeks: "999" }, 52],
      [{ weeks: "10000" }, 52],
      [{ weeks: "-4" }, 12],
    ] as const) {
      const res = makeRes();
      await call(reports, makeReq(lms, query), res);
      expect(lms.productionReport).toHaveBeenLastCalledWith(weeks);
      expect(res.json).toHaveBeenCalledWith(report);
    }
  });

  it("answers a failure with a fixed sentence, never the error's own text", async () => {
    const lms = {
      productionReport: jest.fn().mockRejectedValue(new Error("select ... LENS-SV-167-M0100 ...")),
    };
    const res = makeRes();
    await call(reports, makeReq(lms), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/LENS-SV/);
    const reported = (captureException as jest.Mock).mock.calls
      .map((c) => `${String(c[0]?.message)}\n${String(c[0]?.stack)}`)
      .join("\n");
    expect(reported).not.toMatch(/LENS-SV/);
  });
});
