import { POST as actions } from "../[id]/actions/route";
import { POST as opsActions } from "../[id]/ops-actions/route";
import { POST as rxChanged } from "../[id]/rx-changed/route";
import { POST as packet } from "../[id]/packet/route";
import { GET as production } from "../[id]/production/route";
import { GET as detail } from "../[id]/route";
import { GET as list } from "../route";
import { GET as queue } from "../../lab-queue/route";
import { POST as retry } from "../[id]/retry/route";
import middlewares from "../../../middlewares";
import { buildLabJobPacket } from "../../../../modules/lms/build-packet";
import fs from "fs";
import path from "path";
import { LAB_ACTIONS, OPS_ACTIONS } from "../production-http";
import { ACTIONS, ProductionError, SYSTEM_ONLY_ACTIONS } from "../../../../modules/lms/production";
import {
  LMS_MODULE,
  LabJobNotRebuildableError,
  ProductionWriteError,
} from "../../../../modules/lms/service";
import { applyChangedPrescription } from "../../../../modules/lms/rebuild";
import { captureException } from "../../../../lib/observability/sentry";

jest.mock("../../../../modules/lms/rebuild", () => ({
  ...jest.requireActual("../../../../modules/lms/rebuild"),
  applyChangedPrescription: jest.fn(),
}));
jest.mock("../../../../modules/lms/build-packet", () => ({ buildLabJobPacket: jest.fn() }));
const mockBuild = buildLabJobPacket as jest.MockedFunction<typeof buildLabJobPacket>;
jest.mock("../../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));
const mockRx = applyChangedPrescription as jest.MockedFunction<typeof applyChangedPrescription>;

const JOB = {
  id: "labjob_1",
  order_id: "order_1",
  status: "queued",
  stage: "ready",
  packet_snapshot: { prescription: { sph_right: -2.25 }, customer: { name: "A B" } },
};

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}
function makeReq(
  lms: unknown,
  body: unknown = {},
  opts: { actor?: string | null; query?: object; actorType?: string } = {},
) {
  return {
    params: { id: "labjob_1" },
    body,
    query: opts.query ?? {},
    auth_context:
      opts.actor === null
        ? undefined
        : { actor_id: opts.actor ?? "user_lab", actor_type: opts.actorType ?? "user" },
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
const sent = (res: ReturnType<typeof makeRes>) => JSON.stringify(res.json.mock.calls);
/** Everything handed to Sentry: each error's message and stack, and the context. */
const reported = () =>
  (captureException as jest.Mock).mock.calls
    .map((c) => `${String(c[0]?.message)}\n${String(c[0]?.stack)}\n${JSON.stringify(c[1])}`)
    .join("\n");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("who may record what", () => {
  it("offers every action to exactly one door: the lab, ops, the packet route, or the system", () => {
    const viaPacket = ["PACKET_VIEWED", "PACKET_PRINTED"];
    for (const action of ACTIONS) {
      const doors = [
        LAB_ACTIONS.has(action),
        OPS_ACTIONS.has(action),
        viaPacket.includes(action),
        SYSTEM_ONLY_ACTIONS.has(action),
      ].filter(Boolean);
      expect([action, doors.length]).toEqual([action, 1]);
    }
  });
});

describe("POST /admin/lab-jobs/[id]/actions", () => {
  const ok = { event: { id: "prodevt_1" }, job: { id: "labjob_1", stage: "printed" }, replayed: false };

  it("records the step as the signed-in user, passing only the fields it names", async () => {
    const lms = { applyProductionAction: jest.fn().mockResolvedValue(ok) };
    const res = makeRes();
    await call(
      actions,
      makeReq(lms, {
        action: "PRINTED",
        idempotency_key: "key-0000001",
        expected_version: 1,
        happened_at: "2026-11-20T03:00:00Z",
        detail: { a: 1 },
        actor: { type: "system", id: "forged" },
        job_id: "labjob_other",
      }),
      res,
    );
    expect(lms.applyProductionAction).toHaveBeenCalledWith({
      job_id: "labjob_1",
      action: "PRINTED",
      idempotency_key: "key-0000001",
      expected_version: 1,
      happened_at: new Date("2026-11-20T03:00:00Z"),
      detail: { a: 1 },
      actor: { type: "user", id: "user_lab" },
    });
    expect(res.json).toHaveBeenCalledWith(ok);
  });

  it("refuses a system step, an ops step and a packet view through this door", async () => {
    for (const action of ["LABELLED", "CANCELLED", "RX_CHANGED", "READY", "HOLD", "PACKET_VIEWED", "nonsense"]) {
      const lms = { applyProductionAction: jest.fn() };
      const res = makeRes();
      await call(actions, makeReq(lms, { action, idempotency_key: "key-0000001" }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(lms.applyProductionAction).not.toHaveBeenCalled();
    }
  });

  it("refuses a malformed body without touching the job", async () => {
    for (const body of [
      { action: "PRINTED" },
      { action: "PRINTED", idempotency_key: "key-0000001", expected_version: "1" },
      { action: "PRINTED", idempotency_key: "key-0000001", happened_at: "not a time" },
      { action: "PRINTED", idempotency_key: "key-0000001", detail: ["x"] },
      undefined,
    ]) {
      const lms = { applyProductionAction: jest.fn() };
      const res = makeRes();
      await call(actions, makeReq(lms, body), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(lms.applyProductionAction).not.toHaveBeenCalled();
    }
  });

  it("refuses a caller that is not a person: an API key cannot be 'who did it'", async () => {
    const lms = { applyProductionAction: jest.fn(), viewPacket: jest.fn() };
    for (const handler of [actions, opsActions, packet, rxChanged]) {
      const res = makeRes();
      await call(
        handler,
        makeReq(lms, { action: "PRINTED", idempotency_key: "key-0000001" }, { actor: "apk_01ABC", actorType: "api-key" }),
        res,
      );
      expect(res.status).toHaveBeenCalledWith(403);
    }
    expect(lms.applyProductionAction).not.toHaveBeenCalled();
    expect(lms.viewPacket).not.toHaveBeenCalled();
    expect(mockRx).not.toHaveBeenCalled();
  });

  it("answers 401 with no signed-in user", async () => {
    const lms = { applyProductionAction: jest.fn() };
    const res = makeRes();
    await call(actions, makeReq(lms, { action: "PRINTED", idempotency_key: "key-0000001" }, { actor: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(lms.applyProductionAction).not.toHaveBeenCalled();
  });

  it("answers a rule refusal with its own sentence and the right status", async () => {
    for (const [code, status] of [
      ["not_found", 404],
      ["conflict", 409],
      ["not_allowed", 409],
      ["key_reused", 409],
      ["invalid_detail", 400],
    ] as const) {
      const lms = {
        applyProductionAction: jest.fn().mockRejectedValue(new ProductionError(code, "a plain sentence")),
      };
      const res = makeRes();
      await call(actions, makeReq(lms, { action: "PRINTED", idempotency_key: "key-0000001" }), res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json).toHaveBeenCalledWith({ type: code, message: "a plain sentence" });
    }
  });

  it("never echoes an unexpected error's own text", async () => {
    for (const err of [
      new ProductionWriteError({ code: "55P03" }),
      new Error(`insert into "lab_usage" values ('LENS-SV-167-M0225', 'labjob_1')`),
    ]) {
      const lms = { applyProductionAction: jest.fn().mockRejectedValue(err) };
      const res = makeRes();
      await call(actions, makeReq(lms, { action: "PRINTED", idempotency_key: "key-0000001" }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(sent(res)).not.toMatch(/M0225|insert into/);
      // An Error serialises without its message, so look at it directly.
      expect(reported()).not.toMatch(/M0225|insert into/);
      expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/M0225/);
    }
  });
});

describe("POST /admin/lab-jobs/[id]/ops-actions", () => {
  it("takes hold and release, and nothing else", async () => {
    const lms = { applyProductionAction: jest.fn().mockResolvedValue({}) };
    for (const [action, status] of [
      ["HOLD", undefined],
      ["RELEASE", undefined],
      ["PRINTED", 400],
      ["CANCELLED", 400],
    ] as const) {
      const res = makeRes();
      await call(opsActions, makeReq(lms, { action, idempotency_key: "key-0000001", detail: { reason: "x" } }), res);
      if (status) expect(res.status).toHaveBeenCalledWith(status);
      else expect(res.status).not.toHaveBeenCalled();
    }
    expect(lms.applyProductionAction).toHaveBeenCalledTimes(2);
  });
});

describe("POST /admin/lab-jobs/[id]/rx-changed", () => {
  it("answers each outcome with its own status and never returns the packet", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRx.mockResolvedValue({ outcome: "changed", job: JOB } as any);
    let res = makeRes();
    await call(rxChanged, makeReq({}, { idempotency_key: "key-0000001" }), res);
    expect(mockRx).toHaveBeenCalledWith(expect.anything(), "labjob_1", "key-0000001", "user_lab");
    expect(res.status).not.toHaveBeenCalled();
    expect(sent(res)).not.toMatch(/sph_right|packet_snapshot/);

    // The builder's own reason is free text made from an error; it is not
    // passed on.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRx.mockResolvedValue({ outcome: "not_built", buildOutcome: "failed", reason: "decrypt failed: sph -2.25" } as any);
    res = makeRes();
    await call(rxChanged, makeReq({}, { idempotency_key: "key-0000001" }), res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(sent(res)).not.toMatch(/2\.25|decrypt/);
    expect(res.json.mock.calls[0][0]).toMatchObject({ outcome: "not_built", buildOutcome: "failed" });

    for (const [result, status] of [
      [{ outcome: "not_built", buildOutcome: "pending_rx", reason: "awaiting prescription" }, 422],
      [{ outcome: "not_in_production" }, 409],
      [{ outcome: "too_late", stage: "labelled" }, 409],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRx.mockResolvedValue(result as any);
      res = makeRes();
      await call(rxChanged, makeReq({}, { idempotency_key: "key-0000001" }), res);
      expect(res.status).toHaveBeenCalledWith(status);
    }

    mockRx.mockRejectedValue(new LabJobNotRebuildableError("submitted"));
    res = makeRes();
    await call(rxChanged, makeReq({}, { idempotency_key: "key-0000001" }), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("needs a key and a signed-in user", async () => {
    let res = makeRes();
    await call(rxChanged, makeReq({}, {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    res = makeRes();
    await call(rxChanged, makeReq({}, { idempotency_key: "key-0000001" }, { actor: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(mockRx).not.toHaveBeenCalled();
  });
});

describe("the packet is shown by one route only", () => {
  it("leaves it out of the list, the job, the production view and the queue", async () => {
    const lms = {
      listLabJobs: jest.fn().mockResolvedValue([JOB]),
      listJobsByStatus: jest.fn().mockResolvedValue([JOB]),
      retrieveLabJob: jest.fn().mockResolvedValue(JOB),
      listProductionEventsForJob: jest.fn().mockResolvedValue([]),
      listLabCosts: jest.fn().mockResolvedValue([]),
      listQueue: jest.fn().mockResolvedValue([{ id: "labjob_1", stage: "ready", on_hold: false }]),
    };
    mockBuild.mockResolvedValue({
      outcome: "pending_rx",
      reason: "awaiting prescription",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    });
    Object.assign(lms, {
      updateJobFromBuild: jest.fn().mockResolvedValue(JOB),
      submitJob: jest.fn().mockResolvedValue({ outcome: "queued_no_provider", job: JOB }),
    });
    for (const [handler, query] of [
      [list, {}],
      [list, { status: "queued" }],
      [detail, {}],
      [production, {}],
      [queue, {}],
      // Retry: a rebuild that is still waiting, and (below) one that builds.
      [retry, {}],
    ] as const) {
      const res = makeRes();
      await call(handler, makeReq(lms, {}, { query }), res);
      expect(res.json).toHaveBeenCalledTimes(1);
      expect(sent(res)).toContain("labjob_1");
      expect(sent(res)).not.toMatch(/sph_right|packet_snapshot|"name"/);
    }
  });

  it("leaves it out of Retry's answers, and Retry never echoes an error's own text", async () => {
    const built = {
      retrieveLabJob: jest.fn().mockResolvedValue({ ...JOB, status: "failed" }),
      updateJobFromBuild: jest.fn().mockResolvedValue(JOB),
      submitJob: jest.fn().mockResolvedValue({ outcome: "queued_no_provider", job: JOB }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockBuild.mockResolvedValue({ outcome: "ok", packet: JOB.packet_snapshot } as any);
    let res = makeRes();
    await call(retry, makeReq(built), res);
    expect(sent(res)).toContain("queued_no_provider");
    expect(sent(res)).not.toMatch(/sph_right|packet_snapshot/);

    res = makeRes();
    await call(retry, makeReq({ retrieveLabJob: jest.fn().mockResolvedValue({ ...JOB, status: "submitted" }) }), res);
    expect(sent(res)).toContain("submitted");
    expect(sent(res)).not.toMatch(/sph_right|packet_snapshot/);

    built.updateJobFromBuild.mockRejectedValue(
      new Error(`update "lab_job" set packet = '{"sph_right":-2.25}'`),
    );
    res = makeRes();
    await call(retry, makeReq(built), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(sent(res)).not.toMatch(/2\.25|sph_right/);
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toMatch(/2\.25|sph_right/);
    expect(captureException).toHaveBeenCalled();
    expect(reported()).not.toMatch(/2\.25|sph_right/);

    // The same when the job cannot even be read.
    (captureException as jest.Mock).mockClear();
    res = makeRes();
    await call(
      retry,
      makeReq({
        retrieveLabJob: jest.fn().mockRejectedValue(new Error(`select '{"sph_right":-2.25}'`)),
      }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(captureException).toHaveBeenCalled();
    expect(reported()).not.toMatch(/2\.25|sph_right/);
  });

  it("names a failure's kind only when it looks like a class name or an error code", async () => {
    for (const [err, expected] of [
      [Object.assign(new Error("x"), { name: "LENS-SV-167-M0225" }), /unexpected error/],
      [Object.assign(new Error("x"), { name: "Error", code: "sph_right.-2.25" }), /Error$/],
      [Object.assign(new Error("x"), { name: "DriverException", code: "55P03" }), /DriverException\/55P03/],
      [Object.assign(new Error("x"), { name: "Error", code: "0812345678901234" }), /Error$/],
    ] as const) {
      (console.error as jest.Mock).mockClear();
      const lms = { applyProductionAction: jest.fn().mockRejectedValue(err) };
      const res = makeRes();
      await call(actions, makeReq(lms, { action: "PRINTED", idempotency_key: "key-0000001" }), res);
      expect((console.error as jest.Mock).mock.calls[0][0]).toMatch(expected);
    }
  });

  it("does not show another person's key in a job's history", async () => {
    const lms = {
      retrieveLabJob: jest.fn().mockResolvedValue(JOB),
      listProductionEventsForJob: jest.fn().mockResolvedValue([
        { id: "prodevt_1", seq: 2, action: "PACKET_VIEWED", actor_id: "user_A", idempotency_key: "secret-key-A", request_hash: "abc" },
      ]),
      listLabCosts: jest.fn().mockResolvedValue([]),
    };
    const res = makeRes();
    await call(production, makeReq(lms), res);
    expect(sent(res)).toContain("user_A");
    expect(sent(res)).not.toMatch(/secret-key-A|request_hash|idempotency_key/);
  });

  it("names the right thing when something other than the job is missing", async () => {
    const notFound = Object.assign(new Error("Order with id: order_9 was not found"), { type: "not_found" });
    const lms = {
      retrieveLabJob: jest.fn().mockResolvedValue(JOB),
      listProductionEventsForJob: jest.fn().mockRejectedValue(notFound),
      listLabCosts: jest.fn().mockResolvedValue([]),
    };
    let res = makeRes();
    await call(production, makeReq(lms), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(captureException).toHaveBeenCalledTimes(1);

    const missingJob = Object.assign(new Error("LabJob with id: labjob_1 was not found"), { type: "not_found" });
    res = makeRes();
    await call(production, makeReq({ ...lms, retrieveLabJob: jest.fn().mockRejectedValue(missingJob) }), res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("shows it through the packet route, recorded against the user", async () => {
    const lms = { viewPacket: jest.fn().mockResolvedValue({ packet: JOB.packet_snapshot, job: {} }) };
    let res = makeRes();
    await call(packet, makeReq(lms, { idempotency_key: "key-0000001", printed: true }), res);
    expect(lms.viewPacket).toHaveBeenCalledWith("labjob_1", "user_lab", "key-0000001", true);
    expect(sent(res)).toMatch(/sph_right/);

    res = makeRes();
    await call(packet, makeReq(lms, { idempotency_key: "key-0000001" }, { actor: null }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    res = makeRes();
    await call(packet, makeReq(lms, {}), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(lms.viewPacket).toHaveBeenCalledTimes(1);
  });

  it("counts the queue by column: an open question first, then on hold, then the stage", async () => {
    const lms = {
      listQueue: jest.fn().mockResolvedValue([
        { id: "a", stage: "ready", on_hold: false, cut_question_pending: false },
        { id: "b", stage: "ready", on_hold: true, cut_question_pending: false },
        { id: "c", stage: "cancelled", on_hold: false, cut_question_pending: true },
        { id: "d", stage: "printed", on_hold: true, cut_question_pending: true },
      ]),
    };
    const res = makeRes();
    await call(queue, makeReq(lms), res);
    expect(res.json.mock.calls[0][0].counts).toEqual({ ready: 1, on_hold: 1, question: 2 });
    expect(res.json.mock.calls[0][0].truncated).toBe(false);
  });
});

describe("every lab route declares a permission", () => {
  // Medusa enforces `policies` from middlewares.ts when its role module is
  // on. A lab route with no entry there would then be open to any signed-in
  // admin. This walks the route files on disk and holds them to the list.
  const apiRoot = path.join(__dirname, "..", "..", "..");
  function routeFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return e.name.startsWith("_") ? [] : routeFiles(full);
      return e.name === "route.ts" ? [full] : [];
    });
  }
  const declared = new Map<string, unknown>();
  for (const r of (middlewares as unknown as { routes: Array<{ matcher: string; methods?: string[]; policies?: unknown }> }).routes) {
    // Declared means at least one policy with a resource and an operation.
    const policies = (Array.isArray(r.policies) ? r.policies : r.policies ? [r.policies] : []) as Array<{
      resource?: string;
      operation?: string;
    }>;
    const real = policies.length > 0 && policies.every((p) => p.resource && p.operation);
    for (const m of r.methods ?? []) if (real) declared.set(`${m} ${r.matcher}`, policies);
  }

  it("for each method of each route under admin/lab-jobs and admin/lab-queue", () => {
    const found: string[] = [];
    // Every folder under admin/ whose name starts with "lab-", so a new
    // one is covered without touching this test.
    const labDirs = fs
      .readdirSync(path.join(apiRoot, "admin"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("lab-"))
      .map((e) => path.join(apiRoot, "admin", e.name));
    expect(labDirs.map((d) => path.basename(d)).sort()).toEqual(["lab-jobs", "lab-queue"]);
    for (const file of labDirs.flatMap(routeFiles)) {
      const matcher =
        "/" +
        path
          .relative(apiRoot, path.dirname(file))
          .split(path.sep)
          .map((seg) => seg.replace(/^\[(.+)\]$/, ":$1"))
          .join("/");
      const source = fs.readFileSync(file, "utf8");
      for (const method of ["GET", "POST", "DELETE", "PUT", "PATCH"]) {
        // Any way of exporting a handler: a function, async or not, or a const.
        if (new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`).test(source)) {
          found.push(`${method} ${matcher}`);
        }
      }
    }
    expect(found.length).toBeGreaterThanOrEqual(9);
    for (const route of found) expect([route, declared.has(route)]).toEqual([route, true]);
    // And no entry points at a lab route that does not exist.
    for (const key of declared.keys()) {
      if (key.includes("/admin/lab-")) expect(found).toContain(key);
    }
  });
});
