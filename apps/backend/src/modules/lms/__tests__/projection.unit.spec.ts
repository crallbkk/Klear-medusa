// Contract 6 (order status projection), the lab's side: which Website state
// each production stage shows, what is sent, and which answers count as
// received. Checked against the contract's fixture file, which the Website's
// tests read too (`apps/backend/contracts/order-status-projection-v1.json`).

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import {
  PROJECTION_PATH,
  isAcknowledged,
  projectedState,
  projectionMessage,
} from "../projection";
import { deliverProjection, resendUnacknowledgedProjections } from "../projection-sender";
import type { ProductionAction, Stage } from "../production";
import { captureMessage } from "../../../lib/observability/sentry";

jest.mock("../../../lib/observability/sentry", () => ({ captureMessage: jest.fn(), captureException: jest.fn() }));

const FIXTURE_FILE = path.join(__dirname, "..", "..", "..", "..", "contracts", "order-status-projection-v1.json");
const raw = fs.readFileSync(FIXTURE_FILE, "utf8");
const fixture = JSON.parse(raw) as {
  request: { path: string; fields: string[] };
  mapping: Array<{ stage: Stage; via: ProductionAction | null; warranty?: boolean; state: string }>;
  not_projected: Stage[];
  valid_messages: Array<{ name: string; body: Record<string, unknown> }>;
  responses: Array<{ name: string; status: number; body: unknown; acknowledged: boolean }>;
};

// The same bytes on both sides: the Website pins the same digest.
const FIXTURE_SHA256 = "f1e93b670a857dc4a1728ba6c5cec8e2a6f199d4eb38c98e2e2e5994e9395dd9";

describe("the fixture", () => {
  it("is the one the Website tests against", () => {
    const digest = createHash("sha256").update(JSON.stringify(JSON.parse(raw))).digest("hex");
    expect(digest).toBe(FIXTURE_SHA256);
  });
  it("names the route this side posts to", () => {
    expect(PROJECTION_PATH).toBe(fixture.request.path);
  });
});

describe("which Website state a stage shows", () => {
  it("follows the contract's table", () => {
    for (const row of fixture.mapping) {
      // A stage reached by any other action shows the same as `via: null`.
      const via = row.via ?? "PRINTED";
      const warranty = row.warranty ?? false;
      expect([row.stage, row.via, warranty, projectedState(row.stage, via, warranty)]).toEqual([
        row.stage,
        row.via,
        warranty,
        row.state,
      ]);
    }
  });
  it("sends nothing for a label, a delivery or a cancel: those come from elsewhere", () => {
    for (const stage of fixture.not_projected) {
      for (const via of ["LABELLED", "DELIVERED", "CANCELLED", "LABEL_CANCELLED"] as ProductionAction[]) {
        expect(projectedState(stage, via, false)).toBeNull();
      }
    }
  });
});

describe("what is sent", () => {
  const job = {
    order_id: "order_01KFIXTUREPROJECTION0001",
    projection_state: "in_production",
    projection_seq: 3,
    projection_at: new Date("2026-11-25T03:00:00.000Z"),
    warranty_remakes: 0,
  };

  it("is the order, the state, its sequence, its own time and the warranty cycle, and nothing else", () => {
    const message = projectionMessage(job);
    expect(message).toEqual(fixture.valid_messages.find((m) => m.name === "in production")!.body);
    expect(Object.keys(message!).sort()).toEqual([...fixture.request.fields].sort());
  });

  it("carries the warranty cycle of a remake after delivery", () => {
    const message = projectionMessage({
      ...job,
      projection_state: "remake_required",
      projection_seq: 10,
      projection_at: new Date("2026-12-20T02:00:00.000Z"),
      warranty_remakes: 1,
    });
    expect(message).toEqual(fixture.valid_messages.find((m) => m.name === "warranty remake after delivery")!.body);
  });

  it("is nothing for a job that has never had a state to show", () => {
    expect(projectionMessage({ ...job, projection_state: null, projection_seq: 0, projection_at: null })).toBeNull();
  });
});

describe("which answers count as received", () => {
  it("follows the contract: applied and ignored are received; anything else is sent again", () => {
    for (const r of fixture.responses) {
      expect([r.name, isAcknowledged(r.status, r.body)]).toEqual([r.name, r.acknowledged]);
    }
  });
  it("does not take a 200 that says something else as received", () => {
    expect(isAcknowledged(200, { ok: true })).toBe(false);
    expect(isAcknowledged(200, "ok")).toBe(false);
    expect(isAcknowledged(200, { ok: false, outcome: "applied" })).toBe(false);
  });
});

describe("sending", () => {
  const SECRET = "p".repeat(40);
  const env = { KLEAR_STOREFRONT_URL: "https://web.test/", KLEAR_PROJECTION_SECRET: SECRET };
  const row = {
    id: "labjob_1",
    order_id: "order_01KFIXTUREPROJECTION0001",
    projection_state: "assembled",
    projection_seq: 7,
    projection_at: new Date("2026-11-25T06:00:00.000Z"),
    projection_sent_seq: 3,
    warranty_remakes: 0,
  };
  function lms(over: Partial<typeof row> = {}) {
    return {
      getProjection: jest.fn().mockResolvedValue({ ...row, ...over }),
      markProjectionDelivered: jest.fn().mockResolvedValue(undefined),
      markProjectionAttempt: jest.fn().mockResolvedValue(undefined),
      giveUpProjections: jest.fn().mockResolvedValue([]),
      listUnsentProjections: jest.fn().mockResolvedValue([{ id: "labjob_1" }, { id: "labjob_2" }]),
    };
  }
  const answer = (status: number, body: unknown) =>
    jest.fn().mockResolvedValue({ status, json: async () => body, text: async () => JSON.stringify(body) });
  const log = { warn: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    log.warn.mockReset();
    log.error.mockReset();
  });

  it("posts the latest state to the Website with its own secret, and records it as received", async () => {
    const fetch = answer(200, { ok: true, outcome: "applied" });
    const store = lms();
    expect(await deliverProjection(store as never, "labjob_1", { env, fetch, log })).toBe("acknowledged");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://web.test/api/webhooks/order-projection");
    expect(init.method).toBe("POST");
    // A redirect is never followed: the secret goes to the configured host only.
    expect(init.redirect).toBe("error");
    expect(init.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual(fixture.valid_messages.find((m) => m.name === "boxed")!.body);
    expect(store.markProjectionDelivered).toHaveBeenCalledWith("labjob_1", 7);
  });

  it("leaves it to be sent again when the Website cannot apply it yet, or is down", async () => {
    for (const fetch of [
      answer(409, { ok: false, outcome: "not_ready" }),
      answer(503, { ok: false, error: "service unavailable" }),
      jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    ]) {
      const store = lms();
      expect(await deliverProjection(store as never, "labjob_1", { env, fetch, log })).toBe("not_acknowledged");
      expect(store.markProjectionDelivered).not.toHaveBeenCalled();
    }
  });

  it("sends nothing when everything was received already", async () => {
    const fetch = answer(200, { ok: true, outcome: "applied" });
    const store = lms({ projection_sent_seq: 7 });
    expect(await deliverProjection(store as never, "labjob_1", { env, fetch, log })).toBe("nothing_to_send");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends nothing until the URL and a real secret are set, or while the secret is another one's", async () => {
    for (const bad of [
      {},
      { KLEAR_STOREFRONT_URL: "https://web.test" },
      { KLEAR_STOREFRONT_URL: "https://web.test", KLEAR_PROJECTION_SECRET: "short" },
      { ...env, KLEAR_CARRIER_WEBHOOK_SECRET: SECRET },
      { ...env, KLEAR_ORDER_CANCEL_SECRET: SECRET },
    ]) {
      const fetch = answer(200, { ok: true, outcome: "applied" });
      const store = lms();
      expect(await deliverProjection(store as never, "labjob_1", { env: bad, fetch, log })).toBe("not_configured");
      expect(fetch).not.toHaveBeenCalled();
      expect(store.getProjection).not.toHaveBeenCalled();
    }
  });

  it("never throws, whatever fails", async () => {
    const store = lms();
    store.getProjection.mockRejectedValue(new Error("db down"));
    const fetch = answer(200, { ok: true, outcome: "applied" });
    expect(await deliverProjection(store as never, "labjob_1", { env, fetch, log })).toBe("failed");
    store.getProjection.mockResolvedValue(row);
    store.markProjectionDelivered.mockRejectedValue(new Error("db down"));
    expect(await deliverProjection(store as never, "labjob_1", { env, fetch, log })).toBe("failed");
  });

  it("sends again whatever was not received, job by job", async () => {
    const fetch = answer(200, { ok: true, outcome: "ignored", reason: "stale" });
    const store = lms();
    expect(await resendUnacknowledgedProjections(store as never, { env, fetch, log })).toEqual({
      tried: 2,
      acknowledged: 2,
      not_acknowledged: 0,
      gave_up: 0,
    });
    expect(store.listUnsentProjections).toHaveBeenCalled();
  });

  it("does not read the jobs when sending is not set up", async () => {
    const store = lms();
    expect(await resendUnacknowledgedProjections(store as never, { env: {}, fetch: jest.fn(), log })).toEqual({
      tried: 0,
      acknowledged: 0,
      not_acknowledged: 0,
      gave_up: 0,
    });
    expect(store.listUnsentProjections).not.toHaveBeenCalled();
  });
});

describe("sending, round 2", () => {
  const SECRET = "p".repeat(40);
  const row = {
    id: "labjob_1",
    order_id: "order_01KFIXTUREPROJECTION0001",
    projection_state: "assembled",
    projection_seq: 7,
    projection_at: new Date("2026-11-25T06:00:00.000Z"),
    projection_sent_seq: 3,
    warranty_remakes: 0,
  };
  const store = () => ({
    getProjection: jest.fn().mockResolvedValue(row),
    markProjectionDelivered: jest.fn().mockResolvedValue(undefined),
    markProjectionAttempt: jest.fn().mockResolvedValue(undefined),
    listUnsentProjections: jest.fn().mockResolvedValue([{ id: "labjob_1" }, { id: "labjob_2" }, { id: "labjob_3" }]),
    giveUpProjections: jest.fn().mockResolvedValue([]),
  });
  const answer = (status: number, body: unknown) => jest.fn().mockResolvedValue({ status, json: async () => body });
  const log = { warn: jest.fn(), error: jest.fn() };

  it("sends only to an https Website, or to this machine", async () => {
    for (const [url, ok] of [
      ["http://web.test", false],
      ["ftp://web.test", false],
      ["https://web.test", true],
      ["http://127.0.0.1:3000", true],
      ["http://localhost:3000", true],
    ] as const) {
      const fetch = answer(200, { ok: true, outcome: "applied" });
      const env = { KLEAR_STOREFRONT_URL: url, KLEAR_PROJECTION_SECRET: SECRET };
      const out = await deliverProjection(store() as never, "labjob_1", { env, fetch, log });
      expect([url, out]).toEqual([url, ok ? "acknowledged" : "not_configured"]);
    }
  });

  it("records each attempt the Website did not take, saying when it was not ready", async () => {
    const env = { KLEAR_STOREFRONT_URL: "https://web.test", KLEAR_PROJECTION_SECRET: SECRET };
    const s1 = store();
    await deliverProjection(s1 as never, "labjob_1", { env, fetch: answer(409, { ok: false, outcome: "not_ready" }), log });
    expect(s1.markProjectionAttempt).toHaveBeenCalledWith("labjob_1", true);
    const s2 = store();
    await deliverProjection(s2 as never, "labjob_1", { env, fetch: answer(503, { ok: false }), log });
    expect(s2.markProjectionAttempt).toHaveBeenCalledWith("labjob_1", false);
    const s3 = store();
    await deliverProjection(s3 as never, "labjob_1", { env, fetch: answer(200, { ok: true, outcome: "applied" }), log });
    expect(s3.markProjectionAttempt).not.toHaveBeenCalled();
  });

  it("stops when its time is spent, and reports what it gave up on", async () => {
    const env = { KLEAR_STOREFRONT_URL: "https://web.test", KLEAR_PROJECTION_SECRET: SECRET };
    const s = store();
    s.giveUpProjections.mockResolvedValue([{ id: "labjob_9", order_id: "order_9" }]);
    let t = 0;
    const now = () => (t += 40_000);
    const result = await resendUnacknowledgedProjections(s as never, {
      env,
      fetch: answer(200, { ok: true, outcome: "applied" }),
      log,
      now,
      budgetMs: 100_000,
    });
    expect(result.tried).toBeLessThan(3);
    expect(result.gave_up).toBe(1);
    expect(captureMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "projection_given_up" }) }),
    );
  });
});
