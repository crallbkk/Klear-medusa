import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { GET as getOrders } from "../orders/route";
import { GET as getFulfillments } from "../fulfillments/route";
import { captureException } from "../../../lib/observability/sentry";
import { ORDER_ROW, SECRETS, leakyOrderDetail } from "./fixtures";

jest.mock("../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

const SECRET = "f".repeat(40);
const HORIZON = "2026-11-23T09:59:00.000000Z";

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

/** A stand-in for Medusa's pg connection (knex): answers by what the SQL
 *  reads, and records every statement and its bindings. */
type Tables = {
  orders?: unknown[];
  fulfillments?: unknown[];
  lines?: unknown[];
  details?: Record<string, ReturnType<typeof leakyOrderDetail>>;
};

/** The rows Medusa's tables would give for an order's version-1 details,
 *  each with extra columns (metadata, codes) that must not reach a record. */
function detailRows(details: NonNullable<Tables["details"]>) {
  const out = { carts: [] as unknown[], items: [] as unknown[], itemTax: [] as unknown[], itemAdj: [] as unknown[], ship: [] as unknown[], shipTax: [] as unknown[], shipAdj: [] as unknown[] };
  for (const [orderId, d] of Object.entries(details)) {
    out.carts.push({ order_id: orderId, cart_id: d.cart_id });
    for (const i of d.items as Array<Record<string, unknown>>) {
      out.items.push({ ...i, order_id: orderId, tax_lines: undefined, adjustments: undefined });
      for (const t of (i.tax_lines as unknown[]) ?? []) out.itemTax.push({ ...(t as object), item_id: i.id });
      for (const a of (i.adjustments as unknown[]) ?? []) out.itemAdj.push({ ...(a as object), item_id: i.id });
    }
    for (const m of d.shipping_methods as Array<Record<string, unknown>>) {
      out.ship.push({ ...m, order_id: orderId, tax_lines: undefined, adjustments: undefined });
      for (const t of (m.tax_lines as unknown[]) ?? []) out.shipTax.push({ ...(t as object), shipping_method_id: m.id });
      for (const a of (m.adjustments as unknown[]) ?? []) out.shipAdj.push({ ...(a as object), shipping_method_id: m.id });
    }
  }
  return out;
}

function fakePg(tables: Tables, fail?: Error) {
  const calls: Array<{ sql: string; bindings: unknown[] }> = [];
  const d = detailRows(tables.details ?? {});
  const raw = jest.fn(async (sql: string, bindings: unknown[] = []) => {
    calls.push({ sql, bindings });
    if (fail) throw fail;
    if (/now\(\)/.test(sql)) return { rows: [{ horizon: HORIZON }] };
    if (/from "fulfillment" f/.test(sql)) return { rows: tables.fulfillments ?? [] };
    if (/from "fulfillment_item"/.test(sql)) return { rows: tables.lines ?? [] };
    if (/from "order" o/.test(sql)) return { rows: tables.orders ?? [] };
    if (/from "order_cart"/.test(sql)) return { rows: d.carts };
    if (/from "order_item"/.test(sql)) return { rows: d.items };
    if (/from "order_line_item_tax_line"/.test(sql)) return { rows: d.itemTax };
    if (/from "order_line_item_adjustment"/.test(sql)) return { rows: d.itemAdj };
    if (/from "order_shipping" s/.test(sql)) return { rows: d.ship };
    if (/from "order_shipping_method_tax_line"/.test(sql)) return { rows: d.shipTax };
    if (/from "order_shipping_method_adjustment"/.test(sql)) return { rows: d.shipAdj };
    throw new Error(`unexpected SQL ${sql}`);
  });
  return { raw, calls };
}

function makeReq(opts: { auth?: string; query?: Record<string, unknown>; pg?: unknown }) {
  return {
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    query: opts.query ?? {},
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return opts.pg;
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (fn: any, req: unknown, res: unknown) => fn(req as any, res as any);

const ROUTES: Array<[string, unknown]> = [
  ["orders", getOrders],
  ["fulfillments", getFulfillments],
];

describe.each(ROUTES)("GET /ops-feed/%s", (_name, route) => {
  const saved = process.env.KLEAR_OPS_FEED_SECRET;
  beforeEach(() => {
    process.env.KLEAR_OPS_FEED_SECRET = SECRET;
    (captureException as jest.Mock).mockClear();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.KLEAR_OPS_FEED_SECRET;
    else process.env.KLEAR_OPS_FEED_SECRET = saved;
  });

  it("is closed when the secret is unset or too short to be one", async () => {
    for (const value of [undefined, "", "short", " ".repeat(40)]) {
      if (value === undefined) delete process.env.KLEAR_OPS_FEED_SECRET;
      else process.env.KLEAR_OPS_FEED_SECRET = value;
      const pg = fakePg({});
      const res = makeRes();
      await call(route, makeReq({ auth: `Bearer ${value ?? ""}`, pg }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(pg.raw).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing, malformed or wrong secret, and any other credential, without reading", async () => {
    for (const auth of [
      undefined,
      "",
      SECRET,
      `Basic ${SECRET}`,
      `bearer ${SECRET}`,
      `Bearer ${SECRET}x`,
      // What an admin session or a customer sends: a JWT.
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJhY3Rvcl9pZCI6InVzZXJfMSJ9.x",
    ]) {
      const pg = fakePg({});
      const res = makeRes();
      await call(route, makeReq({ auth, pg }), res);
      expect([auth, res.status.mock.calls[0]?.[0]]).toEqual([auth, 401]);
      expect(pg.raw).not.toHaveBeenCalled();
    }
  });

  it("refuses a bad cursor and any parameter it does not know, such as a field list", async () => {
    for (const query of [
      { after: "yesterday" },
      { after: ["2026-11-20T00:00:00Z|x"] },
      { fields: "email,*shipping_address" },
      { after: "2026-11-20T00:00:00Z|x", expand: "metadata" },
    ]) {
      const pg = fakePg({});
      const res = makeRes();
      await call(route, makeReq({ auth: `Bearer ${SECRET}`, query, pg }), res);
      expect([query, res.status.mock.calls[0]?.[0]]).toEqual([query, 400]);
      expect(pg.raw).not.toHaveBeenCalled();
    }
  });

  it("answers a database failure with a fixed sentence, and passes on none of its text", async () => {
    const failure = Object.assign(
      new Error(`select ... where "id" = 'order_A' -- ${SECRETS.join(" ")}`),
      { code: "57014" },
    );
    const pg = fakePg({}, failure);
    const res = makeRes();
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await call(route, makeReq({ auth: `Bearer ${SECRET}`, pg }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      const said = JSON.stringify([
        res.json.mock.calls,
        logged.mock.calls,
        (captureException as jest.Mock).mock.calls.map((c) => [String(c[0]?.message), c[1]]),
      ]);
      expect(said).not.toMatch(/order_A|select|SECRET|Secret|example\.test|\+668/);
      expect(said).toMatch(/57014/);
      expect(captureException).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("GET /ops-feed/orders, the page", () => {
  beforeEach(() => {
    process.env.KLEAR_OPS_FEED_SECRET = SECRET;
  });

  it("reads after the cursor, withholds the last 60 seconds, and serves the allow-listed record", async () => {
    const pg = fakePg({ orders: [ORDER_ROW], details: { order_A: leakyOrderDetail() } });
    const res = makeRes();
    await call(
      getOrders,
      makeReq({ auth: `Bearer ${SECRET}`, query: { after: "2026-11-20T00:00:00.000001Z|order_0", limit: "2" }, pg }),
      res,
    );
    expect(res.status).not.toHaveBeenCalled();
    const page = pg.calls.find((c) => /from "order" o/.test(c.sql))!;
    // The horizon, then the cursor, then one more than the page size.
    expect(page.bindings).toEqual([HORIZON, "2026-11-20T00:00:00.000001Z", "order_0", 3]);
    expect(page.sql).toMatch(/\(o\."updated_at", o\."id"\) > \(\?::timestamptz, \?\)/);
    expect(page.sql).toMatch(/order by o\."updated_at", o\."id"/);
    // The order as placed: every versioned table is read at version 1.
    for (const table of ["order_item", "order_line_item_adjustment", "order_shipping", "order_shipping_method_adjustment"]) {
      const q = pg.calls.find((c) => new RegExp(`from "${table}"( |$|\\n)`).test(c.sql))!;
      expect([table, /"version" = 1/.test(q.sql)]).toEqual([table, true]);
    }
    // No statement selects a whole row or a metadata column.
    for (const c of pg.calls) expect(c.sql).not.toMatch(/\*|metadata|email|address/);

    const body = res.json.mock.calls[0][0];
    expect(body.orders).toEqual([
      expect.objectContaining({ id: "order_A", cart_id: "cart_A", version: 3, total_satang: 154000 }),
    ]);
    expect(body.next_after).toBe("2026-11-20T03:05:00.654321Z|order_A");
    expect(body.has_more).toBe(false);
    expect(body.polled_through).toBe(HORIZON);
    const text = JSON.stringify(body);
    for (const s of SECRETS) expect([s, text.includes(s)]).toEqual([s, false]);
  });

  it("says there is more, and gives no polled-through time, when the page is full", async () => {
    const pg = fakePg({
      orders: [ORDER_ROW, { ...ORDER_ROW, id: "order_B" }, { ...ORDER_ROW, id: "order_C" }],
      details: { order_A: leakyOrderDetail(), order_B: leakyOrderDetail() },
    });
    const res = makeRes();
    await call(getOrders, makeReq({ auth: `Bearer ${SECRET}`, query: { limit: "2" }, pg }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.orders.map((o: { id: string }) => o.id)).toEqual(["order_A", "order_B"]);
    // Each order gets only its own lines.
    expect(body.orders.map((o: { lines: unknown[] }) => o.lines.length)).toEqual([2, 2]);
    expect(body.has_more).toBe(true);
    expect(body.polled_through).toBeNull();
    expect(body.next_after).toBe("2026-11-20T03:05:00.654321Z|order_B");
    const page = pg.calls.find((c) => /from "order" o/.test(c.sql))!;
    expect(page.bindings).toEqual([HORIZON, 3]);
  });

  it("keeps the caller's cursor when there is nothing new, and reads nothing more", async () => {
    const pg = fakePg({ orders: [] });
    const res = makeRes();
    const after = "2026-11-20T00:00:00.000001Z|order_0";
    await call(getOrders, makeReq({ auth: `Bearer ${SECRET}`, query: { after }, pg }), res);
    expect(pg.calls.map((c) => c.sql).some((q) => /order_item/.test(q))).toBe(false);
    expect(res.json).toHaveBeenCalledWith({ orders: [], next_after: after, has_more: false, polled_through: HORIZON });
  });

  it("says which order it cannot serve, by its id only, and answers the fixed sentence", async () => {
    const bad = leakyOrderDetail();
    (bad.items[0] as Record<string, unknown>).quantity = "1.5";
    const pg = fakePg({ orders: [ORDER_ROW], details: { order_A: bad } });
    const res = makeRes();
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    (captureException as jest.Mock).mockClear();
    try {
      await call(getOrders, makeReq({ auth: `Bearer ${SECRET}`, pg }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(JSON.stringify(res.json.mock.calls)).not.toContain("order_A");
      const log = JSON.stringify(logged.mock.calls);
      expect(log).toContain("order_A");
      const sent = (captureException as jest.Mock).mock.calls[0];
      expect(sent[1].extra).toEqual({ record_id: "order_A" });
      const said = JSON.stringify([log, String(sent[0].message), sent[1]]);
      for (const s of SECRETS) expect([s, said.includes(s)]).toEqual([s, false]);
      expect(said).not.toMatch(/1\.5|KLR-F1|Klear Frame|cart_A/);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("GET /ops-feed/fulfillments, the page", () => {
  beforeEach(() => {
    process.env.KLEAR_OPS_FEED_SECRET = SECRET;
  });

  it("serves each fulfillment with its lines, and only the listed fields", async () => {
    const pg = fakePg({
      fulfillments: [
        {
          id: "ful_1",
          order_id: "order_A",
          created_at: "2026-11-21T01:00:00.000001Z",
          canceled_at: null,
          delivered_at: null,
          updated_at: "2026-11-21T01:00:00.000001Z",
          cost_thb: "45",
          is_replacement: false,
          data: { courier_tracking_code: "SECRET-COURIER-TH999" },
        },
      ],
      lines: [
        { fulfillment_id: "ful_1", line_item_id: "ordli_1", sku: "KLR-F1", quantity: "1" },
        { fulfillment_id: "ful_1", line_item_id: "ordli_2", sku: "KLR-LENS-SV167", quantity: "1" },
        { fulfillment_id: "ful_OTHER", line_item_id: "ordli_9", sku: "X", quantity: "1" },
      ],
    });
    const res = makeRes();
    await call(
      getFulfillments,
      makeReq({ auth: `Bearer ${SECRET}`, query: { after: "2026-11-21T00:00:00Z|" }, pg }),
      res,
    );
    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body).toEqual({
      fulfillments: [
        {
          id: "ful_1",
          order_id: "order_A",
          created_at: "2026-11-21T01:00:00.000001Z",
          kind: "original",
          quoted_shipping_satang: 4500,
          canceled_at: null,
          delivered_at: null,
          updated_at: "2026-11-21T01:00:00.000001Z",
          lines: [
            { line_item_id: "ordli_1", sku: "KLR-F1", quantity: 1 },
            { line_item_id: "ordli_2", sku: "KLR-LENS-SV167", quantity: 1 },
          ],
        },
      ],
      next_after: "2026-11-21T01:00:00.000001Z|ful_1",
      has_more: false,
      polled_through: HORIZON,
    });
    const page = pg.calls.find((c) => /from "fulfillment" f/.test(c.sql))!;
    expect(page.bindings).toEqual([HORIZON, "2026-11-21T00:00:00Z", "", 101]);
    // Only fulfillments of an order: a return's inbound fulfillment is not
    // a shipment and is linked to the return, not to the order.
    expect(page.sql).toMatch(/"order_fulfillment"/);
    // Nothing of the provider's data but the quoted cost is read.
    expect(page.sql).not.toMatch(/f\."data"\s*(,|from)/);
  });
});
