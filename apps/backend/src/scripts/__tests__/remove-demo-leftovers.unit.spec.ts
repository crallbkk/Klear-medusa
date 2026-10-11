import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import {
  deleteStockLocationsWorkflow,
  deleteStoresWorkflow,
} from "@medusajs/medusa/core-flows";
import removeDemoLeftovers, {
  applyDemoLeftoverRemoval,
  planDemoLeftoverRemoval,
  toQuantity,
  verifyDemoLeftoversRemoved,
  type DemoLeftoverPlan,
} from "../remove-demo-leftovers";

jest.mock("@medusajs/medusa/core-flows", () => ({
  deleteStockLocationsWorkflow: jest.fn(),
  deleteStoresWorkflow: jest.fn(),
}));

const mockDeleteLocations = deleteStockLocationsWorkflow as unknown as jest.Mock;
const mockDeleteStores = deleteStoresWorkflow as unknown as jest.Mock;

const EU = "sloc_eu";
const BKK = "sloc_bkk";
const DUPS = ["store_02", "store_03"];
const CONFIRM_ENV = ["APPLY", "CONFIRM_LOCATION_ID", "CONFIRM_STORE_IDS"];

interface FakeStore {
  id: string;
  name: string;
  supported_currencies: Array<{ currency_code: string }> | null;
  default_sales_channel_id: string | null;
  default_region_id: string | null;
  default_location_id: string | null;
}

interface World {
  locations: Array<{ id: string; name: string }>;
  links: Record<
    string,
    {
      sales_channels?: Array<{ id: string } | null> | null;
      fulfillment_sets?: Array<{ id: string } | null> | null;
    }
  >;
  levels: Array<{
    id: string;
    location_id: string;
    stocked_quantity: unknown;
    incoming_quantity: unknown;
    reserved_quantity: unknown;
  }>;
  reservations: Array<{ id: string; location_id: string }>;
  fulfillments: Array<{ id: string; location_id: string }>;
  returns: Array<{ id: string; location_id: string | null }>;
  stores: FakeStore[];
}

const store = (id: string, currencies: string[], over: Partial<FakeStore> = {}): FakeStore => ({
  id,
  name: "Default Store",
  supported_currencies: currencies.map((currency_code) => ({ currency_code })),
  default_sales_channel_id: "sc_1",
  default_region_id: null,
  default_location_id: null,
  ...over,
});

/** Production as found on 2026-10-11 (ids shortened). */
function demoWorld(): World {
  return {
    locations: [
      { id: EU, name: "European Warehouse" },
      { id: BKK, name: "Bangkok Warehouse" },
    ],
    links: {
      [EU]: { sales_channels: [], fulfillment_sets: [] },
      [BKK]: { sales_channels: [{ id: "sc_1" }], fulfillment_sets: [{ id: "fuset_th" }] },
    },
    levels: [
      { id: "iloc_eu_1", location_id: EU, stocked_quantity: 0, incoming_quantity: 0, reserved_quantity: 9 },
      { id: "iloc_eu_2", location_id: EU, stocked_quantity: 0, incoming_quantity: 0, reserved_quantity: 7 },
      { id: "iloc_eu_3", location_id: EU, stocked_quantity: 0, incoming_quantity: 0, reserved_quantity: 0 },
      { id: "iloc_bkk_1", location_id: BKK, stocked_quantity: 100, incoming_quantity: 0, reserved_quantity: 3 },
    ],
    reservations: [{ id: "resitem_1", location_id: BKK }],
    fulfillments: [{ id: "ful_1", location_id: BKK }],
    returns: [{ id: "ret_bkk", location_id: BKK }, { id: "ret_none", location_id: null }],
    stores: [
      store("store_01", ["thb"]),
      store("store_02", ["eur", "usd"]),
      store("store_03", ["eur", "usd"]),
    ],
  };
}

/** Rejects a filter the real service does not have, so a wrong key cannot pass. */
function byLocation<T extends { location_id: string | null }>(rows: () => T[]) {
  return jest.fn(async (filters: Record<string, unknown>) => {
    const keys = Object.keys(filters);
    if (keys.length !== 1 || keys[0] !== "location_id") {
      throw new Error(`unexpected filter keys: ${keys.join(",")}`);
    }
    return rows().filter((r) => r.location_id === filters.location_id);
  });
}

/**
 * A fake container over a mutable world. Deletes change the world, so what
 * the script reads after applying is the result of what it did.
 */
function makeContainer(world: World) {
  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const inventory = {
    listReservationItems: byLocation(() => world.reservations),
    listInventoryLevels: byLocation(() => world.levels),
    deleteInventoryItemLevelByLocationId: jest.fn(async (locationId: string) => {
      world.levels = world.levels.filter((l) => l.location_id !== locationId);
    }),
  };
  const graph = jest.fn(
    async (args: { entity: string; fields: string[]; filters?: unknown }) => {
      if (args.entity !== "stock_location") throw new Error(`unexpected entity ${args.entity}`);
      // Like the real graph: a field that was not asked for is not returned.
      return {
        data: world.locations
          .filter((l) => world.links[l.id])
          .map((l) => {
            const row: Record<string, unknown> = { id: l.id };
            if (args.fields.includes("sales_channels.id")) row.sales_channels = world.links[l.id].sales_channels;
            if (args.fields.includes("fulfillment_sets.id")) row.fulfillment_sets = world.links[l.id].fulfillment_sets;
            return row;
          }),
      };
    },
  );
  const stockLocation = { listStockLocations: jest.fn(async () => world.locations) };
  const fulfillment = { listFulfillments: byLocation(() => world.fulfillments) };
  const order = { listReturns: jest.fn(async () => world.returns) };
  const storeModule = {
    // Like the real service: a relation that was not asked for is not loaded,
    // and rows come back in no promised order (here: reversed).
    listStores: jest.fn(async (_f: unknown, config?: { relations?: string[] }) =>
      [...world.stores].reverse().map((s) =>
        config?.relations?.includes("supported_currencies")
          ? s
          : { ...s, supported_currencies: undefined },
      ),
    ),
  };
  const services: Record<string, unknown> = {
    [ContainerRegistrationKeys.LOGGER]: logger,
    [ContainerRegistrationKeys.QUERY]: { graph },
    [Modules.STOCK_LOCATION]: stockLocation,
    [Modules.INVENTORY]: inventory,
    [Modules.FULFILLMENT]: fulfillment,
    [Modules.ORDER]: order,
    [Modules.STORE]: storeModule,
  };
  const container = {
    resolve: jest.fn((key: string) => {
      if (!(key in services)) throw new Error(`unexpected resolve(${key})`);
      return services[key];
    }),
  };

  const runDeleteLocations = jest.fn(async ({ input }: { input: { ids: string[] } }) => {
    world.locations = world.locations.filter((l) => !input.ids.includes(l.id));
  });
  const runDeleteStores = jest.fn(async ({ input }: { input: { ids: string[] } }) => {
    world.stores = world.stores.filter((s) => !input.ids.includes(s.id));
  });
  mockDeleteLocations.mockReturnValue({ run: runDeleteLocations });
  mockDeleteStores.mockReturnValue({ run: runDeleteStores });

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    container: container as any,
    logger, inventory, graph, stockLocation, fulfillment, order, storeModule,
    runDeleteLocations, runDeleteStores,
  };
}
type Harness = ReturnType<typeof makeContainer>;

function confirm(location: string | null = EU, stores: string[] = DUPS) {
  process.env.APPLY = "true";
  if (location) process.env.CONFIRM_LOCATION_ID = location;
  if (stores.length) process.env.CONFIRM_STORE_IDS = stores.join(",");
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of CONFIRM_ENV) delete process.env[k];
});
afterAll(() => {
  for (const k of CONFIRM_ENV) delete process.env[k];
});

function expectNothingDeleted(h: Harness) {
  expect(h.inventory.deleteInventoryItemLevelByLocationId).not.toHaveBeenCalled();
  expect(h.runDeleteLocations).not.toHaveBeenCalled();
  expect(h.runDeleteStores).not.toHaveBeenCalled();
}
const logged = (h: Harness) => h.logger.info.mock.calls.map((c) => String(c[0])).join("\n");

describe("remove-demo-leftovers: what it deletes", () => {
  it("with APPLY and matching ids: the demo location's levels, then the location, then only the non-THB stores", async () => {
    const world = demoWorld();
    const h = makeContainer(world);
    confirm();

    await removeDemoLeftovers({ container: h.container });

    expect(h.inventory.deleteInventoryItemLevelByLocationId).toHaveBeenCalledTimes(1);
    expect(h.inventory.deleteInventoryItemLevelByLocationId).toHaveBeenCalledWith(EU);
    expect(h.runDeleteLocations).toHaveBeenCalledTimes(1);
    expect(h.runDeleteLocations).toHaveBeenCalledWith({ input: { ids: [EU] } });
    expect(h.runDeleteStores).toHaveBeenCalledTimes(1);
    expect(h.runDeleteStores).toHaveBeenCalledWith({ input: { ids: DUPS } });
    // Levels go before the location, or they are left pointing at nothing.
    expect(
      h.inventory.deleteInventoryItemLevelByLocationId.mock.invocationCallOrder[0],
    ).toBeLessThan(h.runDeleteLocations.mock.invocationCallOrder[0]);

    // The Bangkok location, its stock and the THB store are untouched.
    expect(world.locations).toEqual([{ id: BKK, name: "Bangkok Warehouse" }]);
    expect(world.levels.map((l) => l.id)).toEqual(["iloc_bkk_1"]);
    expect(world.stores.map((s) => s.id)).toEqual(["store_01"]);
  });

  it("removes the location when there are no duplicate stores", async () => {
    const world = demoWorld();
    world.stores = [world.stores[0]];
    const h = makeContainer(world);
    confirm(EU, []);

    await removeDemoLeftovers({ container: h.container });

    expect(h.runDeleteLocations).toHaveBeenCalledWith({ input: { ids: [EU] } });
    expect(h.runDeleteStores).not.toHaveBeenCalled();
    expect(world.levels.map((l) => l.id)).toEqual(["iloc_bkk_1"]);
  });

  it("removes the duplicate stores when there is no demo location", async () => {
    const world = demoWorld();
    world.locations = [{ id: BKK, name: "Bangkok Warehouse" }];
    const h = makeContainer(world);
    confirm(null, DUPS);

    await removeDemoLeftovers({ container: h.container });

    expect(h.runDeleteStores).toHaveBeenCalledWith({ input: { ids: DUPS } });
    expect(h.inventory.deleteInventoryItemLevelByLocationId).not.toHaveBeenCalled();
    expect(h.runDeleteLocations).not.toHaveBeenCalled();
    expect(logged(h)).not.toContain("Nothing to remove");
  });

  it("removes a demo location that has no levels left (the state after a half-finished run)", async () => {
    const world = demoWorld();
    world.levels = world.levels.filter((l) => l.location_id !== EU);
    world.stores = [world.stores[0]];
    const h = makeContainer(world);
    confirm(EU, []);

    await removeDemoLeftovers({ container: h.container });

    expect(h.runDeleteLocations).toHaveBeenCalledWith({ input: { ids: [EU] } });
    expect(world.locations.map((l) => l.id)).toEqual([BKK]);
  });

  it("a second run finds nothing and deletes nothing", async () => {
    const world = demoWorld();
    confirm();
    await removeDemoLeftovers({ container: makeContainer(world).container });

    const h = makeContainer(world);
    await removeDemoLeftovers({ container: h.container });

    expectNothingDeleted(h);
    expect(h.logger.info).toHaveBeenCalledWith("Nothing to remove");
  });

  it("recovers on re-run when the location workflow fails after the levels were removed", async () => {
    const world = demoWorld();
    const first = makeContainer(world);
    first.runDeleteLocations.mockRejectedValueOnce(new Error("workflow failed"));
    confirm();
    await expect(removeDemoLeftovers({ container: first.container })).rejects.toThrow("workflow failed");
    // Levels are gone, the location and the duplicate stores are not.
    expect(world.levels.map((l) => l.id)).toEqual(["iloc_bkk_1"]);
    expect(world.locations).toHaveLength(2);
    expect(first.runDeleteStores).not.toHaveBeenCalled();

    const second = makeContainer(world);
    await removeDemoLeftovers({ container: second.container });
    expect(world.locations.map((l) => l.id)).toEqual([BKK]);
    expect(world.stores.map((s) => s.id)).toEqual(["store_01"]);
  });
});

describe("remove-demo-leftovers: it only applies when told exactly what to remove", () => {
  it("is a dry run by default: prints what it found and the line to run, deletes nothing", async () => {
    const world = demoWorld();
    const h = makeContainer(world);

    await removeDemoLeftovers({ container: h.container });

    expectNothingDeleted(h);
    expect(world).toEqual(demoWorld());
    const out = logged(h);
    expect(out).toContain("Dry run: nothing was changed");
    expect(out).toContain(`Stock location "European Warehouse" ${EU}: 3 inventory level(s), reserved count 16, reservation rows 0`);
    expect(out).toContain("level iloc_eu_1: reserved 9");
    expect(out).toContain("level iloc_eu_2: reserved 7");
    expect(out).toContain("level iloc_eu_3: reserved 0");
    expect(out).toContain('Store store_01 [KEEP] "Default Store" currencies=thb');
    expect(out).toContain('Store store_02 [REMOVE] "Default Store" currencies=eur/usd');
    expect(out).toContain(`run this script again with: APPLY=true CONFIRM_LOCATION_ID=${EU} CONFIRM_STORE_IDS=store_02,store_03`);
  });

  it.each(["false", "0", "TRUE", "1", "yes", " true", ""])("APPLY=%p is a dry run even with matching ids", async (value) => {
    const world = demoWorld();
    const h = makeContainer(world);
    confirm();
    process.env.APPLY = value;

    await removeDemoLeftovers({ container: h.container });

    expectNothingDeleted(h);
    expect(world).toEqual(demoWorld());
    expect(logged(h)).toContain("Dry run");
  });

  const mismatches: Array<[string, () => void]> = [
    ["no ids are given", () => { process.env.APPLY = "true"; }],
    ["the location id is missing", () => { confirm(null, DUPS); }],
    ["the location id is a different location", () => { confirm(BKK, DUPS); }],
    ["the store ids are missing", () => { confirm(EU, []); }],
    ["a store id is missing from the list", () => { confirm(EU, ["store_02"]); }],
    ["the list names the store to keep", () => { confirm(EU, [...DUPS, "store_01"]); }],
    ["the list names a different store", () => { confirm(EU, ["store_02", "store_99"]); }],
  ];
  it.each(mismatches)("refuses with APPLY=true when %s", async (_name, setEnv) => {
    const world = demoWorld();
    const h = makeContainer(world);
    setEnv();

    await expect(removeDemoLeftovers({ container: h.container })).rejects.toThrow(
      /confirmation does not match[\s\S]*Expected: APPLY=true CONFIRM_LOCATION_ID=sloc_eu CONFIRM_STORE_IDS=store_02,store_03$/,
    );
    expectNothingDeleted(h);
    expect(world).toEqual(demoWorld());
  });

  it("accepts the ids in any order and with spaces around them", async () => {
    const world = demoWorld();
    const h = makeContainer(world);
    confirm();
    process.env.CONFIRM_LOCATION_ID = ` ${EU} `;
    process.env.CONFIRM_STORE_IDS = " store_03 , store_02 ";
    await removeDemoLeftovers({ container: h.container });
    expect(world.stores.map((s) => s.id)).toEqual(["store_01"]);
  });

  it("refuses a location id when this run found no demo location", async () => {
    const world = demoWorld();
    world.locations = [{ id: BKK, name: "Bangkok Warehouse" }];
    const h = makeContainer(world);
    confirm(BKK, DUPS);
    await expect(removeDemoLeftovers({ container: h.container })).rejects.toThrow(
      /confirmation does not match/,
    );
    expectNothingDeleted(h);
  });
});

describe("remove-demo-leftovers: what makes it refuse, even when confirmed", () => {
  const cases: Array<[string, (w: World) => void, RegExp]> = [
    ["a reservation exists at the demo location (its reserved stock is real)",
      (w) => w.reservations.push({ id: "resitem_eu", location_id: EU }), /1 reservation\(s\) exist/],
    ["a level there has stock", (w) => { w.levels[0].stocked_quantity = 2; }, /stocked quantity 2/],
    ["a level there has negative stock", (w) => { w.levels[0].stocked_quantity = -1; }, /stocked quantity -1/],
    ["a level's stock is null", (w) => { w.levels[0].stocked_quantity = null; }, /stocked quantity null/],
    ["a level's stock is an empty string", (w) => { w.levels[0].stocked_quantity = ""; }, /stocked quantity /],
    ["a level's stock is not a number", (w) => { w.levels[0].stocked_quantity = "n/a"; }, /stocked quantity n\/a/],
    ["a level there has incoming stock", (w) => { w.levels[1].incoming_quantity = 5; }, /incoming quantity 5/],
    ["a level there has negative incoming stock", (w) => { w.levels[1].incoming_quantity = -5; }, /incoming quantity -5/],
    ["a level's incoming stock is missing", (w) => { w.levels[1].incoming_quantity = undefined; }, /incoming quantity undefined/],
    ["a level's reserved count is unreadable", (w) => { w.levels[0].reserved_quantity = {}; }, /reserved quantity \[object Object\]/],
    ["a level's reserved count is negative", (w) => { w.levels[0].reserved_quantity = -3; }, /reserved quantity -3/],
    ["the location is linked to a sales channel",
      (w) => { w.links[EU].sales_channels = [{ id: "sc_1" }]; }, /linked to 1 sales channel/],
    ["the location still has a fulfillment set",
      (w) => { w.links[EU].fulfillment_sets = [{ id: "fuset_eu" }]; }, /1 fulfillment set/],
    ["no other location shows a sales channel (the check proves nothing)",
      (w) => { w.links[BKK].sales_channels = []; }, /sales-channel check .* cannot be trusted/],
    ["no other location shows a fulfillment set (the check proves nothing)",
      (w) => { w.links[BKK].fulfillment_sets = null; }, /fulfillment-set check .* cannot be trusted/],
    ["an order was fulfilled from the location",
      (w) => w.fulfillments.push({ id: "ful_eu", location_id: EU }), /1 fulfillment\(s\) shipped from/],
    ["a return was received at the location",
      (w) => w.returns.push({ id: "ret_eu", location_id: EU }), /1 return\(s\) were received/],
    ["it is the only stock location",
      (w) => { w.locations = w.locations.filter((l) => l.id === EU); }, /only stock location/],
    ["two locations carry the demo name",
      (w) => w.locations.push({ id: "sloc_eu_2", name: "European Warehouse" }), /2 stock locations are named/],
    ["its links cannot be read", (w) => { delete w.links[EU]; }, /could not read the links/],
    ["no store supports THB, so there is no store to keep",
      (w) => { w.stores = w.stores.slice(1); }, /0 of 2 stores support THB/],
    ["two stores support THB, so it is unclear which to keep",
      (w) => w.stores[1].supported_currencies?.push({ currency_code: "THB" }), /2 of 3 stores support THB/],
    ["a non-THB store is not a demo duplicate by name",
      (w) => { w.stores[2].name = "Klear US"; }, /named "Klear US", not "Default Store"/],
    ["a duplicate has a different default sales channel (it may be the store in use)",
      (w) => { w.stores[2].default_sales_channel_id = "sc_other"; },
      /store store_03 has a different default sales channel or region/],
    ["a duplicate has a different default region",
      (w) => { w.stores[1].default_region_id = "reg_eu"; },
      /store store_02 has a different default sales channel or region/],
    ["the demo location has a sales channel and no OTHER location does",
      (w) => { w.links[EU].sales_channels = [{ id: "sc_1" }]; w.links[BKK].sales_channels = []; },
      /sales-channel check .* cannot be trusted/],
    ["the demo location has a fulfillment set and no OTHER location does",
      (w) => { w.links[EU].fulfillment_sets = [{ id: "fuset_eu" }]; w.links[BKK].fulfillment_sets = []; },
      /fulfillment-set check .* cannot be trusted/],
    ["the kept store's default location is the demo location",
      (w) => { w.stores[0].default_location_id = EU; }, /as its default location/],
  ];

  it.each(cases)("refuses when %s", async (_name, mutate, message) => {
    const world = demoWorld();
    mutate(world);
    const snapshot = JSON.parse(JSON.stringify(world));
    const h = makeContainer(world);
    // Confirm with whatever ids this world would print, so only the blocker stops it.
    const plan = await planDemoLeftoverRemoval(h.container);
    confirm(plan.location?.id ?? null, plan.duplicate_store_ids);
    jest.clearAllMocks();
    mockDeleteLocations.mockReturnValue({ run: h.runDeleteLocations });
    mockDeleteStores.mockReturnValue({ run: h.runDeleteStores });

    await expect(removeDemoLeftovers({ container: h.container })).rejects.toThrow(
      /Nothing was changed/,
    );

    // One blocker anywhere stops everything, including the unrelated half.
    expectNothingDeleted(h);
    expect(JSON.parse(JSON.stringify(world))).toEqual(snapshot);
    expect(h.logger.error).toHaveBeenCalledWith(expect.stringMatching(message));
  });

  it("a duplicate that sorts before the kept store is still a duplicate, and the ids come out sorted", async () => {
    const world = demoWorld();
    world.stores[1].id = "store_00";
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.blockers).toEqual([]);
    expect(plan.kept_store_id).toBe("store_01");
    expect(plan.duplicate_store_ids).toEqual(["store_00", "store_03"]);
  });

  it("a duplicate whose default location is the demo location does not block: it is going too", async () => {
    const world = demoWorld();
    world.stores[1].default_location_id = EU;
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.blockers).toEqual([]);
  });

  it("returns at other locations, or at none, do not block", async () => {
    const world = demoWorld();
    world.returns.push({ id: "ret_bkk_2", location_id: BKK });
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.blockers).toEqual([]);
  });

  it("an unreadable reserved count is left out of the total it reports", async () => {
    const world = demoWorld();
    world.levels[0].reserved_quantity = {};
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.location?.reserved_total).toBe(7);
    expect(plan.blockers).toHaveLength(1);
  });

  it("ignores null entries in a link list instead of counting them", async () => {
    const world = demoWorld();
    world.links[EU].sales_channels = [null];
    world.links[EU].fulfillment_sets = [null, null];
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.blockers).toEqual([]);
  });

  it("reports the reservation rows next to the reserved count, so the two can be compared", async () => {
    const world = demoWorld();
    world.reservations.push({ id: "resitem_eu", location_id: EU });
    const h = makeContainer(world);
    await expect(removeDemoLeftovers({ container: h.container })).rejects.toThrow();
    expect(logged(h)).toContain("reserved count 16, reservation rows 1");
  });

});

describe("remove-demo-leftovers: the pieces", () => {
  it("plans nothing when there is one store and no demo location", async () => {
    const world = demoWorld();
    world.locations = [{ id: BKK, name: "Bangkok Warehouse" }];
    world.stores = [world.stores[0]];
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.location).toBeNull();
    expect(plan.kept_store_id).toBe("store_01");
    expect(plan.duplicate_store_ids).toEqual([]);
    expect(plan.blockers).toEqual([]);
  });

  it("a lone store is never removed, whatever its currency", async () => {
    const world = demoWorld();
    world.stores = [world.stores[1]];
    const plan = await planDemoLeftoverRemoval(makeContainer(world).container);
    expect(plan.duplicate_store_ids).toEqual([]);
    expect(plan.kept_store_id).toBeNull();
    expect(plan.blockers).toEqual([]);
  });

  it("asks for both link fields on the stock_location entity, unfiltered", async () => {
    const h = makeContainer(demoWorld());
    await planDemoLeftoverRemoval(h.container);
    expect(h.graph).toHaveBeenCalledTimes(1);
    expect(h.graph).toHaveBeenCalledWith({
      entity: "stock_location",
      fields: ["id", "sales_channels.id", "fulfillment_sets.id"],
    });
  });

  it("reads every list with an explicit large page size, and stores with their currencies", async () => {
    const h = makeContainer(demoWorld());
    await planDemoLeftoverRemoval(h.container);
    const big = expect.objectContaining({ take: 10000 });
    expect(h.stockLocation.listStockLocations).toHaveBeenCalledWith({}, big);
    expect(h.inventory.listInventoryLevels).toHaveBeenCalledWith({ location_id: EU }, big);
    expect(h.inventory.listReservationItems).toHaveBeenCalledWith({ location_id: EU }, big);
    expect(h.fulfillment.listFulfillments).toHaveBeenCalledWith({ location_id: EU }, big);
    expect(h.order.listReturns).toHaveBeenCalledWith({}, big);
    expect(h.storeModule.listStores).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ take: 10000, relations: ["supported_currencies"] }),
    );
  });

  it("toQuantity reads numbers and numeric strings, and nothing else", () => {
    expect(toQuantity(0)).toBe(0);
    expect(toQuantity(16)).toBe(16);
    expect(toQuantity("0")).toBe(0);
    expect(toQuantity("0.00")).toBe(0);
    expect(toQuantity(" 7 ")).toBe(7);
    expect(toQuantity(-2)).toBe(-2);
    for (const bad of [null, undefined, "", " ", [], {}, true, false, "n/a", "1e3", NaN, Infinity]) {
      expect(toQuantity(bad)).toBeNaN();
    }
  });

  const basePlan = (over: Partial<DemoLeftoverPlan>): DemoLeftoverPlan => ({
    location: null,
    stores: [],
    kept_store_id: "store_01",
    duplicate_store_ids: [],
    blockers: [],
    ...over,
  });
  const euPlan = { id: EU, name: "European Warehouse", levels: [], reserved_total: 0, reservation_count: 0 };

  it("apply refuses a plan that carries blockers, and deletes nothing", async () => {
    const h = makeContainer(demoWorld());
    await expect(
      applyDemoLeftoverRemoval(h.container, basePlan({ location: euPlan, duplicate_store_ids: ["store_02"], blockers: ["something is off"] })),
    ).rejects.toThrow(/Refusing to remove demo leftovers/);
    expectNothingDeleted(h);
  });

  it.each([
    ["the kept store is among the stores to delete", "store_01", ["store_02", "store_01"]],
    ["no store is marked to keep", null, ["store_02"]],
  ])("apply refuses before deleting ANYTHING when %s", async (_n, kept, dups) => {
    const h = makeContainer(demoWorld());
    await expect(
      applyDemoLeftoverRemoval(h.container, basePlan({ location: euPlan, kept_store_id: kept, duplicate_store_ids: dups })),
    ).rejects.toThrow(/store to keep/);
    // Including the location half, which comes first.
    expectNothingDeleted(h);
  });

  it("the run fails if the levels are still there afterwards", async () => {
    const world = demoWorld();
    const h = makeContainer(world);
    h.inventory.deleteInventoryItemLevelByLocationId.mockImplementation(async () => {});
    confirm();
    await expect(removeDemoLeftovers({ container: h.container })).rejects.toThrow(
      /3 inventory level\(s\) still exist/,
    );
  });

  it("verify reports a location, a store or the kept store in the wrong state", async () => {
    const world = demoWorld();
    const h = makeContainer(world);
    await expect(
      verifyDemoLeftoversRemoved(h.container, basePlan({ location: { ...euPlan }, duplicate_store_ids: DUPS })),
    ).rejects.toThrow(
      /3 inventory level\(s\) still exist at sloc_eu[\s\S]*stock location sloc_eu still exists[\s\S]*store\(s\) still exist: (store_02, store_03|store_03, store_02)/,
    );

    world.stores = [];
    await expect(
      verifyDemoLeftoversRemoved(h.container, basePlan({ duplicate_store_ids: DUPS })),
    ).rejects.toThrow(/the kept store store_01 is missing/);
  });
});
