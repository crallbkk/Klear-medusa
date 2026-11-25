import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { POST as postFrames } from "../frame-stock/route";
import { POST as postLenses } from "../lens-stock/route";
import { parseFrameStockBody } from "../frame-stock";
import { parseLensSnapshotBody } from "../lens-stock";
import { LMS_MODULE, LensSnapshotRefused } from "../../../modules/lms/service";
import { captureException } from "../../../lib/observability/sentry";

jest.mock("../../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

const SYNC = "y".repeat(40);
const LENS = "z".repeat(40);

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (fn: any, req: unknown, res: unknown) => fn(req as any, res as any);

describe("the frame request", () => {
  const ok = { watermark: "2026-11-21T01:00:00.000001Z|ful_1", frames: [{ inventory_item_id: "iitem_1", on_hand: 4 }] };

  it("is taken as sent when well formed", () => {
    expect(parseFrameStockBody(ok)).toEqual({
      watermark: { at: "2026-11-21T01:00:00.000001Z", id: "ful_1" },
      frames: [{ inventory_item_id: "iitem_1", on_hand: 4 }],
    });
    expect(parseFrameStockBody({ ...ok, watermark: null }).watermark).toBeNull();
  });

  it("ignores receipt movements: they only matter to a writer, which is not built", () => {
    const body = { ...ok, frames: [{ ...ok.frames[0], receipt_movements: [{ id: "m1", qty: 30 }] }] };
    expect(parseFrameStockBody(body).frames).toEqual([{ inventory_item_id: "iitem_1", on_hand: 4 }]);
  });

  it("refuses anything malformed", () => {
    for (const bad of [
      null,
      [],
      {},
      { ...ok, watermark: "yesterday" },
      { ...ok, watermark: undefined },
      { ...ok, frames: [] },
      { ...ok, frames: "iitem_1" },
      { ...ok, frames: [{ inventory_item_id: "iitem_1", on_hand: 1.5 }] },
      { ...ok, frames: [{ inventory_item_id: "iitem_1", on_hand: -1 }] },
      { ...ok, frames: [{ inventory_item_id: "iitem_1", on_hand: "4" }] },
      { ...ok, frames: [{ inventory_item_id: "iitem 1", on_hand: 4 }] },
      { ...ok, frames: [{ inventory_item_id: "iitem_1", on_hand: 4 }, { inventory_item_id: "iitem_1", on_hand: 5 }] },
      { ...ok, frames: Array.from({ length: 201 }, (_, i) => ({ inventory_item_id: `iitem_${i}`, on_hand: 1 })) },
    ]) {
      expect(() => parseFrameStockBody(bad)).toThrow();
    }
  });
});

describe("the lens snapshot request", () => {
  it("is taken as sent when well formed", () => {
    expect(
      parseLensSnapshotBody({ as_of: "2026-11-08", lenses: [{ sku: "LENS-SV-150-M200", on_hand: 6 }] }),
    ).toEqual({ as_of: "2026-11-08", lenses: [{ sku: "LENS-SV-150-M200", on_hand: 6 }] });
  });

  it("refuses an empty snapshot: an empty shelf is every SKU at zero", () => {
    // A snapshot replaces the whole table, and its date lives on its rows.
    // An empty one would wipe the lab's view and leave no date to refuse
    // an older snapshot against.
    expect(() => parseLensSnapshotBody({ as_of: "2026-11-08", lenses: [] })).toThrow();
  });

  it("refuses anything malformed", () => {
    const lens = { sku: "LENS-A", on_hand: 1 };
    for (const bad of [
      null,
      { lenses: [lens] },
      { as_of: "8 Nov", lenses: [lens] },
      { as_of: "2026-02-30", lenses: [lens] },
      { as_of: "2026-11-08" },
      { as_of: "2026-11-08", lenses: [{ sku: "lens-a", on_hand: 1 }] },
      { as_of: "2026-11-08", lenses: [{ sku: "LENS-A", on_hand: -2 }] },
      { as_of: "2026-11-08", lenses: [{ sku: "LENS-A", on_hand: 2.5 }] },
      { as_of: "2026-11-08", lenses: [lens, lens] },
      { as_of: "2026-11-08", lenses: Array.from({ length: 5001 }, (_, i) => ({ sku: `L${i}A`, on_hand: 1 })) },
    ]) {
      expect(() => parseLensSnapshotBody(bad)).toThrow();
    }
  });
});

function frameReq(opts: {
  auth?: string;
  body?: unknown;
  inventory?: unknown;
  pg?: unknown;
  locking?: unknown;
}) {
  return {
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    query: {},
    body: opts.body,
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === Modules.INVENTORY) return opts.inventory;
        if (key === Modules.LOCKING) return opts.locking;
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return opts.pg;
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}

describe("POST /ops-sync/frame-stock", () => {
  const body = {
    watermark: "2026-11-21T01:00:00.000001Z|ful_1",
    frames: [
      { inventory_item_id: "iitem_1", on_hand: 10 },
      { inventory_item_id: "iitem_busy", on_hand: 5 },
      { inventory_item_id: "iitem_missing", on_hand: 3 },
    ],
  };
  const saved = { sync: process.env.KLEAR_STOCK_SYNC_SECRET, feed: process.env.KLEAR_OPS_FEED_SECRET };
  beforeEach(() => {
    process.env.KLEAR_STOCK_SYNC_SECRET = SYNC;
    process.env.KLEAR_OPS_FEED_SECRET = "f".repeat(40);
    (captureException as jest.Mock).mockClear();
  });
  afterAll(() => {
    for (const [k, v] of [
      ["KLEAR_STOCK_SYNC_SECRET", saved.sync],
      ["KLEAR_OPS_FEED_SECRET", saved.feed],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function deps() {
    const inventory = {
      listInventoryItems: jest.fn().mockResolvedValue([{ id: "iitem_1" }, { id: "iitem_busy" }]),
      listInventoryLevels: jest.fn().mockResolvedValue([
        { inventory_item_id: "iitem_1", stocked_quantity: 6 },
        { inventory_item_id: "iitem_1", stocked_quantity: { numeric: 2, raw: { value: "2" } } },
        { inventory_item_id: "iitem_busy", stocked_quantity: 4 },
      ]),
      updateInventoryLevels: jest.fn(),
      adjustInventory: jest.fn(),
    };
    const pg = {
      raw: jest.fn().mockResolvedValue({
        // The frames with a fulfillment the ledger cannot have taken in yet.
        rows: [{ inventory_item_id: "iitem_busy" }],
      }),
    };
    const locked: string[][] = [];
    const locking = {
      execute: jest.fn(async (keys: string[], job: () => Promise<unknown>) => {
        locked.push(keys);
        return await job();
      }),
    };
    return { inventory, pg, locking, locked };
  }

  it("is closed without its own secret, and the feed's secret does not open it", async () => {
    delete process.env.KLEAR_STOCK_SYNC_SECRET;
    let d = deps();
    let res = makeRes();
    await call(postFrames, frameReq({ auth: `Bearer ${SYNC}`, body, ...d }), res);
    expect(res.status).toHaveBeenCalledWith(503);

    process.env.KLEAR_STOCK_SYNC_SECRET = SYNC;
    for (const auth of [undefined, `Bearer ${"f".repeat(40)}`, `Bearer ${LENS}`, `Bearer ${SYNC} `]) {
      d = deps();
      res = makeRes();
      await call(postFrames, frameReq({ auth, body, ...d }), res);
      expect([auth, res.status.mock.calls[0]?.[0]]).toEqual([auth, 401]);
      expect(d.locking.execute).not.toHaveBeenCalled();
      expect(d.pg.raw).not.toHaveBeenCalled();
    }
  });

  it("compares under the inventory lock, reports a difference only for a settled frame, and writes nothing", async () => {
    const d = deps();
    const res = makeRes();
    await call(postFrames, frameReq({ auth: `Bearer ${SYNC}`, body, ...d }), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(d.locked).toEqual([["iitem_1", "iitem_busy", "iitem_missing"]]);
    expect(res.json).toHaveBeenCalledWith({
      mode: "report_only",
      frames: [
        {
          // Everything Medusa did to it is behind the watermark: the
          // ledger's figure is what Medusa should hold.
          inventory_item_id: "iitem_1",
          known: true,
          settled: true,
          medusa_stocked: 8,
          expected: 10,
          difference: -2,
          written: false,
        },
        {
          // A fulfillment the ledger has not taken in: no difference.
          inventory_item_id: "iitem_busy",
          known: true,
          settled: false,
          medusa_stocked: 4,
          expected: null,
          difference: null,
          written: false,
        },
        {
          inventory_item_id: "iitem_missing",
          known: false,
          settled: false,
          medusa_stocked: null,
          expected: null,
          difference: null,
          written: false,
        },
      ],
    });
    expect(d.inventory.updateInventoryLevels).not.toHaveBeenCalled();
    expect(d.inventory.adjustInventory).not.toHaveBeenCalled();
    const [sql, bindings] = d.pg.raw.mock.calls[0];
    expect(sql).not.toMatch(/\b(update|insert|delete)\b/i);
    // Settled is judged on the same (updated_at, id) the watermark is a
    // position in, plus the 60-second hold-back on Medusa's clock.
    expect(sql).toMatch(/\(f\."updated_at", f\."id"\) > \(\?::timestamptz, \?\)/);
    expect(sql).toMatch(/60 seconds/);
    expect(bindings).toEqual(["2026-11-21T01:00:00.000001Z", "ful_1", "iitem_1", "iitem_busy", "iitem_missing"]);
  });

  it("before any fulfillment was taken in, compares against the very start", async () => {
    const d = deps();
    const res = makeRes();
    await call(postFrames, frameReq({ auth: `Bearer ${SYNC}`, body: { ...body, watermark: null }, ...d }), res);
    expect(d.pg.raw.mock.calls[0][1].slice(0, 2)).toEqual(["-infinity", ""]);
  });

  it("refuses a malformed request before taking any lock", async () => {
    const d = deps();
    const res = makeRes();
    await call(postFrames, frameReq({ auth: `Bearer ${SYNC}`, body: { frames: [] }, ...d }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(d.locking.execute).not.toHaveBeenCalled();
  });

  it("answers a failure with a fixed sentence and passes on none of its text", async () => {
    const d = deps();
    d.pg.raw.mockRejectedValue(Object.assign(new Error("select ... 'iitem_1' SECRET"), { code: "40P01" }));
    const res = makeRes();
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await call(postFrames, frameReq({ auth: `Bearer ${SYNC}`, body, ...d }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      const said = JSON.stringify([
        res.json.mock.calls,
        logged.mock.calls,
        (captureException as jest.Mock).mock.calls.map((c) => [String(c[0]?.message), c[1]]),
      ]);
      expect(said).not.toMatch(/SECRET|select|iitem_1/);
      expect(said).toMatch(/40P01/);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("POST /ops-sync/lens-stock", () => {
  const body = { as_of: "2026-11-08", lenses: [{ sku: "LENS-A", on_hand: 4 }] };
  beforeEach(() => {
    process.env.KLEAR_LENS_SNAPSHOT_SECRET = LENS;
    process.env.KLEAR_STOCK_SYNC_SECRET = SYNC;
    (captureException as jest.Mock).mockClear();
  });
  afterAll(() => {
    delete process.env.KLEAR_LENS_SNAPSHOT_SECRET;
  });

  function lensReq(auth: string | undefined, b: unknown, lms: unknown) {
    return {
      headers: auth === undefined ? {} : { authorization: auth },
      query: {},
      body: b,
      scope: {
        resolve: jest.fn((key: string) => {
          if (key === LMS_MODULE) return lms;
          throw new Error(`unexpected resolve(${key})`);
        }),
      },
    };
  }

  it("is closed without its own secret, and no other secret opens it", async () => {
    delete process.env.KLEAR_LENS_SNAPSHOT_SECRET;
    const lms = { replaceLensSnapshot: jest.fn() };
    let res = makeRes();
    await call(postLenses, lensReq(`Bearer ${LENS}`, body, lms), res);
    expect(res.status).toHaveBeenCalledWith(503);
    process.env.KLEAR_LENS_SNAPSHOT_SECRET = LENS;
    for (const auth of [undefined, `Bearer ${SYNC}`, `Bearer ${"f".repeat(40)}`]) {
      res = makeRes();
      await call(postLenses, lensReq(auth, body, lms), res);
      expect(res.status).toHaveBeenCalledWith(401);
    }
    expect(lms.replaceLensSnapshot).not.toHaveBeenCalled();
  });

  it("stores the snapshot and says how many SKUs it holds", async () => {
    const lms = { replaceLensSnapshot: jest.fn().mockResolvedValue(1) };
    const res = makeRes();
    await call(postLenses, lensReq(`Bearer ${LENS}`, body, lms), res);
    expect(lms.replaceLensSnapshot).toHaveBeenCalledWith("2026-11-08", [{ sku: "LENS-A", on_hand: 4 }]);
    expect(res.json).toHaveBeenCalledWith({ as_of: "2026-11-08", stored: 1 });
  });

  it("answers a refusal with its own words", async () => {
    for (const [code, status] of [
      ["older_than_stored", 409],
      ["not_a_release", 422],
      ["not_yet_closed", 422],
    ] as const) {
      const lms = { replaceLensSnapshot: jest.fn().mockRejectedValue(new LensSnapshotRefused(code)) };
      const res = makeRes();
      await call(postLenses, lensReq(`Bearer ${LENS}`, body, lms), res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.json.mock.calls[0][0].type).toBe(code);
    }
  });

  it("refuses a malformed snapshot without touching the module", async () => {
    const lms = { replaceLensSnapshot: jest.fn() };
    const res = makeRes();
    await call(postLenses, lensReq(`Bearer ${LENS}`, { as_of: "2026-11-08", lenses: [{ sku: "x" }] }, lms), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(lms.replaceLensSnapshot).not.toHaveBeenCalled();
  });

  it("answers a database failure with a fixed sentence and passes on none of its text", async () => {
    const lms = {
      replaceLensSnapshot: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error("insert ... 'LENS-A' 4 SECRET"), { code: "23505" })),
    };
    const res = makeRes();
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await call(postLenses, lensReq(`Bearer ${LENS}`, body, lms), res);
      expect(res.status).toHaveBeenCalledWith(500);
      const said = JSON.stringify([
        res.json.mock.calls,
        logged.mock.calls,
        (captureException as jest.Mock).mock.calls.map((c) => [String(c[0]?.message), c[1]]),
      ]);
      expect(said).not.toMatch(/SECRET|insert|LENS-A/);
      expect(said).toMatch(/23505/);
    } finally {
      logged.mockRestore();
    }
  });
});
