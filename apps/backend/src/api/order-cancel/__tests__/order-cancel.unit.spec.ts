// Contract 7 (order cancel), Medusa's side: the narrow route the Website
// calls before it refunds an order that has not shipped. Checked against
// the contract's fixture file, which the Website's tests read too
// (`apps/backend/contracts/order-cancel-v1.json`, a copy of the one beside
// the contract).

import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { cancelOrderWorkflow } from "@medusajs/medusa/core-flows";
import { POST } from "../[id]/route";
import { ORDER_ID, cancelUnfulfilledOrder } from "../cancel";
import { captureException } from "../../../lib/observability/sentry";

jest.mock("@medusajs/medusa/core-flows", () => ({ cancelOrderWorkflow: jest.fn() }));
jest.mock("../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

const FIXTURE_FILE = path.join(__dirname, "..", "..", "..", "..", "contracts", "order-cancel-v1.json");
const raw = fs.readFileSync(FIXTURE_FILE, "utf8");
const fixture = JSON.parse(raw) as {
  valid_order_ids: string[];
  invalid_order_ids: string[];
  responses: Array<{ name: string; status: number; body: Record<string, string>; website: string }>;
};
const response = (name: string) => {
  const r = fixture.responses.find((x) => x.name === name);
  if (!r) throw new Error(`no fixture response "${name}"`);
  return { status: r.status, body: r.body };
};
const ORDER = "order_01KFIXTURECANCEL0001";

// The same bytes on both sides: the Website pins the same digest. Edit the
// copy beside the contract, copy it to both repositories, and change both.
const FIXTURE_SHA256 = "667dfbb92f69307e8378064781554e4eaac6309f9a38affaddd10c3ffa530254";

const mockWorkflow = cancelOrderWorkflow as unknown as jest.Mock;

type Order = { id: string; status: string; fulfillments?: Array<{ id: string; canceled_at: string | null }> };

/** A container whose query answers with each order in turn (the route
 *  reads the order before cancelling, and again if the cancel fails). */
function container(...reads: Array<Order | null | Error>) {
  const graph = jest.fn();
  for (const r of reads) {
    if (r instanceof Error) graph.mockRejectedValueOnce(r);
    else graph.mockResolvedValueOnce({ data: r ? [r] : [] });
  }
  return {
    graph,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === "query") return { graph };
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}

function workflowThat(run: jest.Mock) {
  mockWorkflow.mockReturnValue({ run });
  return run;
}

beforeEach(() => {
  mockWorkflow.mockReset();
  (captureException as jest.Mock).mockReset();
});

describe("the fixture", () => {
  it("is the one the Website tests against", () => {
    const digest = createHash("sha256").update(JSON.stringify(JSON.parse(raw))).digest("hex");
    expect(digest).toBe(FIXTURE_SHA256);
  });
});

describe("which ids are order ids", () => {
  it("accepts Medusa order ids", () => {
    for (const id of fixture.valid_order_ids) expect(ORDER_ID.test(id)).toBe(true);
  });
  it("refuses anything else, a cart placeholder first of all", () => {
    for (const id of fixture.invalid_order_ids) expect(ORDER_ID.test(id)).toBe(false);
  });
});

describe("cancelling an order", () => {
  it("cancels an order with no fulfillment, without Medusa's own notification", async () => {
    const run = workflowThat(jest.fn().mockResolvedValue({}));
    const c = container({ id: ORDER, status: "pending", fulfillments: [] }, { id: ORDER, status: "canceled", fulfillments: [] });
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("cancelled"));
    expect(run).toHaveBeenCalledWith({
      input: { order_id: ORDER, no_notification: true, canceled_by: "klear-website" },
    });
  });

  it("cancels an order whose only label was cancelled", async () => {
    workflowThat(jest.fn().mockResolvedValue({}));
    const c = container(
      { id: ORDER, status: "pending", fulfillments: [{ id: "ful_1", canceled_at: "2026-11-25T00:00:00Z" }] },
      { id: ORDER, status: "canceled", fulfillments: [{ id: "ful_1", canceled_at: "2026-11-25T00:00:00Z" }] },
    );
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("cancelled"));
  });

  it("reads the order again after cancelling, and refuses if a label was booked meanwhile", async () => {
    workflowThat(jest.fn().mockResolvedValue({}));
    const c = container(
      { id: ORDER, status: "pending", fulfillments: [] },
      { id: ORDER, status: "canceled", fulfillments: [{ id: "ful_late", canceled_at: null }] },
    );
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("refused, a label is booked"));
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ reason: "label_booked_during_cancel" }) }),
    );
  });

  it("answers a plain error when the order cannot be read after cancelling", async () => {
    workflowThat(jest.fn().mockResolvedValue({}));
    const c = container({ id: ORDER, status: "pending", fulfillments: [] }, new Error("db down"));
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("Medusa failed"));
  });

  it("checks fulfillments before reporting a cancel as done, on every call", async () => {
    workflowThat(jest.fn());
    for (let i = 0; i < 2; i++) {
      const c = container({ id: ORDER, status: "canceled", fulfillments: [{ id: "ful_1", canceled_at: null }] });
      expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("refused, a label is booked"));
    }
    const alerts = (captureException as jest.Mock).mock.calls.filter(
      (c) => (c[1] as { tags?: Record<string, string> })?.tags?.reason === "label_booked_during_cancel",
    );
    expect(alerts).toHaveLength(2);
  });

  it("answers success for an order already cancelled, so a retry is safe", async () => {
    const run = workflowThat(jest.fn());
    const c = container({ id: ORDER, status: "canceled", fulfillments: [] });
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("already cancelled"));
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses once a label is booked: that order is now a return", async () => {
    const run = workflowThat(jest.fn());
    const c = container({ id: ORDER, status: "pending", fulfillments: [{ id: "ful_1", canceled_at: null }] });
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("refused, a label is booked"));
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a completed order", async () => {
    workflowThat(jest.fn());
    const c = container({ id: ORDER, status: "completed", fulfillments: [] });
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("refused, the order is completed"));
  });

  it("refuses a draft or archived order", async () => {
    workflowThat(jest.fn());
    for (const status of ["draft", "archived"]) {
      const c = container({ id: ORDER, status, fulfillments: [] });
      expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("refused, another status"));
    }
  });

  it("says so when there is no such order", async () => {
    workflowThat(jest.fn());
    const c = container(null);
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("no such order"));
  });

  it("answers by the order as it now is when the cancel loses a race", async () => {
    workflowThat(jest.fn().mockRejectedValue(new Error("Order with id order_x was canceled")));
    const raced = container(
      { id: ORDER, status: "pending", fulfillments: [] },
      { id: ORDER, status: "canceled", fulfillments: [] },
    );
    expect(await cancelUnfulfilledOrder(raced.scope as never, ORDER)).toEqual(response("already cancelled"));

    workflowThat(jest.fn().mockRejectedValue(new Error("All fulfillments must be canceled")));
    const labelled = container(
      { id: ORDER, status: "pending", fulfillments: [] },
      { id: ORDER, status: "pending", fulfillments: [{ id: "ful_9", canceled_at: null }] },
    );
    expect(await cancelUnfulfilledOrder(labelled.scope as never, ORDER)).toEqual(
      response("refused, a label is booked"),
    );
  });

  it("answers a plain error, with nothing of the failure in the answer, when the cancel fails", async () => {
    workflowThat(jest.fn().mockRejectedValue(new Error("connection lost near Secretsurname")));
    const c = container(
      { id: ORDER, status: "pending", fulfillments: [] },
      { id: ORDER, status: "pending", fulfillments: [] },
    );
    const answer = await cancelUnfulfilledOrder(c.scope as never, ORDER);
    expect(answer).toEqual(response("Medusa failed"));
    expect(JSON.stringify(answer)).not.toContain("Secretsurname");
    expect(captureException).toHaveBeenCalledTimes(1);
    const [err, ctx] = (captureException as jest.Mock).mock.calls[0];
    expect(String((err as Error).message)).not.toContain("Secretsurname");
    expect(ctx).toMatchObject({ extra: { order_id: ORDER } });
  });

  it("answers a plain error when the order cannot be read", async () => {
    workflowThat(jest.fn());
    const c = container(new Error("db down"));
    expect(await cancelUnfulfilledOrder(c.scope as never, ORDER)).toEqual(response("Medusa failed"));
  });
});

describe("the route", () => {
  const SECRET = "c".repeat(40);
  const OTHER = "f".repeat(40);
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function res() {
    const r = { status: jest.fn(), json: jest.fn() };
    r.status.mockReturnValue(r);
    return r;
  }
  const req = (id: string, auth: string | undefined, scope: unknown = container().scope) => ({
    params: { id },
    headers: auth === undefined ? {} : { authorization: auth },
    scope,
  });

  it("is closed while its secret is unset, too short, or the same as another secret", async () => {
    for (const env of [
      {},
      { KLEAR_ORDER_CANCEL_SECRET: "short" },
      { KLEAR_ORDER_CANCEL_SECRET: SECRET, KLEAR_OPS_FEED_SECRET: SECRET },
    ]) {
      process.env = { ...saved };
      delete process.env.KLEAR_ORDER_CANCEL_SECRET;
      delete process.env.KLEAR_OPS_FEED_SECRET;
      Object.assign(process.env, env);
      const r = res();
      await POST(req(ORDER, `Bearer ${SECRET}`) as never, r as never);
      expect(r.status).toHaveBeenCalledWith(response("secret not set on Medusa").status);
      expect(r.json).toHaveBeenCalledWith(response("secret not set on Medusa").body);
    }
  });

  it("refuses a wrong secret, and the read-only feed secret", async () => {
    process.env.KLEAR_ORDER_CANCEL_SECRET = SECRET;
    process.env.KLEAR_OPS_FEED_SECRET = OTHER;
    for (const auth of [undefined, "Bearer nope", `Bearer ${OTHER}`, SECRET]) {
      const r = res();
      await POST(req(ORDER, auth) as never, r as never);
      expect(r.status).toHaveBeenCalledWith(401);
      expect(r.json).toHaveBeenCalledWith(response("wrong secret").body);
    }
  });

  it("refuses what is not an order id before reading anything", async () => {
    process.env.KLEAR_ORDER_CANCEL_SECRET = SECRET;
    const c = container();
    for (const id of fixture.invalid_order_ids) {
      const r = res();
      await POST(req(id, `Bearer ${SECRET}`, c.scope) as never, r as never);
      expect(r.status).toHaveBeenCalledWith(400);
      expect(r.json).toHaveBeenCalledWith(response("not an order id").body);
    }
    expect(c.graph).not.toHaveBeenCalled();
  });

  it("cancels with the right secret, and answers only the order id and the outcome", async () => {
    process.env.KLEAR_ORDER_CANCEL_SECRET = SECRET;
    workflowThat(jest.fn().mockResolvedValue({}));
    const c = container({ id: ORDER, status: "pending", fulfillments: [] }, { id: ORDER, status: "canceled", fulfillments: [] });
    const r = res();
    await POST(req(ORDER, `Bearer ${SECRET}`, c.scope) as never, r as never);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.json).toHaveBeenCalledWith(response("cancelled").body);
    expect(Object.keys(r.json.mock.calls[0][0]).sort()).toEqual(["order_id", "outcome"]);
  });
});
