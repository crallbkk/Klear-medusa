import { MedusaContainer } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils";
import {
  deleteStockLocationsWorkflow,
  deleteStoresWorkflow,
} from "@medusajs/medusa/core-flows";

// One-off removal of two leftovers from Medusa's demo seed that the admin
// API cannot remove:
//
//   1. The "European Warehouse" stock location. Its inventory levels show 0
//      stocked but a reserved count that no reservation backs. Admin refuses
//      to delete a level whose reserved count is non-zero, and deleting the
//      location alone would orphan the levels. This removes the levels, then
//      the location.
//   2. Duplicate "Default Store" rows (EUR/USD). The admin API has no store
//      delete. The one store that supports THB is kept.
//
// A plain run is a DRY RUN: it prints what it found and changes nothing.
//
// To remove, three env vars are needed. The dry run prints the exact line:
//   APPLY=true                      (exactly "true")
//   CONFIRM_LOCATION_ID=<id>        the location id the dry run printed
//   CONFIRM_STORE_IDS=<id>,<id>     the duplicate store ids it printed
// The ids must match what the script finds at that moment, so it can only
// remove what an operator has seen. Leave a var out when that half has
// nothing to remove.
//
// It changes nothing if anything is not as expected (every check adds to
// `blockers`; one blocker stops both halves). It can be re-run after a
// failure: do a plain run again first, because the confirmation line
// changes once one half is gone.
//
// What it does NOT check: carts. A cart is tied to a region and sales
// channel, not to a stock location or a store row.
//
// Every delete sets `deleted_at` (soft delete). To undo, with the ids from
// the log: `restoreInventoryLevels(levelIds)`, `restoreStockLocations([id])`,
// `restoreStores(ids)`. Restoring the location does not restore the link
// rows the workflow removed (its fulfillment provider link).
//
// Invocation, from the source tree:
//   npx medusa exec ./src/scripts/remove-demo-leftovers.ts
// On the deployed server (railway ssh) only the build exists, so the file
// is the compiled one:
//   npx medusa exec ./src/scripts/remove-demo-leftovers.js

export const DEMO_LOCATION_NAME = "European Warehouse";
/** The name every store row carries on production, kept and duplicate. */
export const DEMO_STORE_NAME = "Default Store";
export const KEPT_CURRENCY = "thb";

// The lists below must be complete: a guard that only saw the first page
// would pass on data it never read.
const ALL = { take: 10000 };

export interface DemoLocationPlan {
  id: string;
  name: string;
  levels: Array<{ id: string; reserved: number }>;
  /** Sum of the levels' reserved counts. */
  reserved_total: number;
  /** Reservation rows at this location. Must be 0 for the count to be stale. */
  reservation_count: number;
}

export interface StoreSummary {
  id: string;
  name: string;
  currencies: string[];
  default_sales_channel_id: string | null;
  default_region_id: string | null;
  default_location_id: string | null;
}

export interface DemoLeftoverPlan {
  location: DemoLocationPlan | null;
  stores: StoreSummary[];
  kept_store_id: string | null;
  duplicate_store_ids: string[];
  /** Any entry here means nothing may be changed. */
  blockers: string[];
}

/**
 * A quantity as a number, or NaN when it is anything but a finite number or
 * a plain numeric string. null, "", [], true and objects are NaN on purpose:
 * `Number()` turns several of them into 0, which would read as "no stock".
 */
export function toQuantity(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) {
    return Number(v);
  }
  return NaN;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

/** Read-only. Works out what would be removed and why it might not be safe. */
export async function planDemoLeftoverRemoval(
  container: MedusaContainer,
): Promise<DemoLeftoverPlan> {
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
  const inventoryModule = container.resolve(Modules.INVENTORY);
  const fulfillmentModule = container.resolve(Modules.FULFILLMENT);
  const orderModule = container.resolve(Modules.ORDER);
  const storeModule = container.resolve(Modules.STORE);

  const blockers: string[] = [];
  let location: DemoLocationPlan | null = null;

  // 1. The demo stock location.
  const allLocations = await stockLocationModule.listStockLocations({}, ALL);
  const demoLocations = allLocations.filter(
    (l) => l.name === DEMO_LOCATION_NAME,
  );
  if (demoLocations.length > 1) {
    blockers.push(
      `${demoLocations.length} stock locations are named "${DEMO_LOCATION_NAME}" (${demoLocations.map((l) => l.id).join(", ")}); expected at most one`,
    );
  } else if (demoLocations.length === 1) {
    const demo = demoLocations[0];

    if (allLocations.length < 2) {
      blockers.push(
        `"${DEMO_LOCATION_NAME}" is the only stock location; removing it would leave none`,
      );
    }

    // Links, read for EVERY location in one call. Another location that does
    // show a sales channel and a fulfillment set proves the two fields
    // resolve; without that proof "no links" could just mean "not read".
    const { data: linkRows } = await query.graph({
      entity: "stock_location",
      fields: ["id", "sales_channels.id", "fulfillment_sets.id"],
    });
    type LinkRow = {
      id: string;
      sales_channels?: Array<{ id: string } | null> | null;
      fulfillment_sets?: Array<{ id: string } | null> | null;
    };
    const rows = linkRows as LinkRow[];
    const count = (list: LinkRow["sales_channels"]) =>
      (list ?? []).filter(Boolean).length;
    const others = rows.filter((r) => r.id !== demo.id);
    const demoRow = rows.find((r) => r.id === demo.id);
    if (!demoRow) {
      blockers.push(
        `could not read the links of "${DEMO_LOCATION_NAME}" (${demo.id})`,
      );
    }
    if (!others.some((r) => count(r.sales_channels) > 0)) {
      blockers.push(
        `no other stock location shows a sales channel, so the sales-channel check on "${DEMO_LOCATION_NAME}" cannot be trusted`,
      );
    }
    if (!others.some((r) => count(r.fulfillment_sets) > 0)) {
      blockers.push(
        `no other stock location shows a fulfillment set, so the fulfillment-set check on "${DEMO_LOCATION_NAME}" cannot be trusted`,
      );
    }
    if (count(demoRow?.sales_channels) > 0) {
      blockers.push(
        `"${DEMO_LOCATION_NAME}" is linked to ${count(demoRow?.sales_channels)} sales channel(s); it may be in use`,
      );
    }
    if (count(demoRow?.fulfillment_sets) > 0) {
      blockers.push(
        `"${DEMO_LOCATION_NAME}" still has ${count(demoRow?.fulfillment_sets)} fulfillment set(s); remove them in Admin first`,
      );
    }

    const reservations = await inventoryModule.listReservationItems(
      { location_id: demo.id },
      ALL,
    );
    if (reservations.length) {
      blockers.push(
        `${reservations.length} reservation(s) exist at "${DEMO_LOCATION_NAME}"; its reserved stock is real`,
      );
    }

    const fulfillments = await fulfillmentModule.listFulfillments(
      { location_id: demo.id },
      ALL,
    );
    if (fulfillments.length) {
      blockers.push(
        `${fulfillments.length} fulfillment(s) shipped from "${DEMO_LOCATION_NAME}"`,
      );
    }

    const returns = await orderModule.listReturns({}, ALL);
    const returnsHere = returns.filter(
      (r) => (r as { location_id?: string | null }).location_id === demo.id,
    );
    if (returnsHere.length) {
      blockers.push(
        `${returnsHere.length} return(s) were received at "${DEMO_LOCATION_NAME}"`,
      );
    }

    const levels = await inventoryModule.listInventoryLevels(
      { location_id: demo.id },
      ALL,
    );
    const planned: DemoLocationPlan["levels"] = [];
    for (const level of levels) {
      const stocked = toQuantity(level.stocked_quantity);
      const incoming = toQuantity(level.incoming_quantity);
      const reserved = toQuantity(level.reserved_quantity);
      // `!(x === 0)`, not `x > 0`: NaN and negatives block too.
      if (!(stocked === 0)) {
        blockers.push(
          `inventory level ${level.id} at "${DEMO_LOCATION_NAME}" has stocked quantity ${String(level.stocked_quantity)}`,
        );
      }
      if (!(incoming === 0)) {
        blockers.push(
          `inventory level ${level.id} at "${DEMO_LOCATION_NAME}" has incoming quantity ${String(level.incoming_quantity)}`,
        );
      }
      if (!(reserved >= 0)) {
        blockers.push(
          `inventory level ${level.id} at "${DEMO_LOCATION_NAME}" has reserved quantity ${String(level.reserved_quantity)}`,
        );
      }
      planned.push({ id: level.id, reserved });
    }

    location = {
      id: demo.id,
      name: demo.name,
      levels: planned,
      reserved_total: planned.reduce(
        (sum, l) => sum + (Number.isFinite(l.reserved) ? l.reserved : 0),
        0,
      ),
      reservation_count: reservations.length,
    };
  }

  // 2. Duplicate stores. Keep the one store that supports THB.
  const rawStores = await storeModule.listStores(
    {},
    { relations: ["supported_currencies"], ...ALL },
  );
  const stores: StoreSummary[] = rawStores
    .map((s) => ({
      id: s.id,
      name: s.name,
      currencies: (s.supported_currencies ?? []).map((c) =>
        String(c.currency_code ?? "").toLowerCase(),
      ),
      default_sales_channel_id: s.default_sales_channel_id ?? null,
      default_region_id: s.default_region_id ?? null,
      default_location_id: s.default_location_id ?? null,
    }))
    // Sorted only so the log and the confirmation line are stable.
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const keepers = stores.filter((s) => s.currencies.includes(KEPT_CURRENCY));
  let keptStoreId: string | null = null;
  let duplicateStoreIds: string[] = [];
  if (stores.length > 1) {
    if (keepers.length !== 1) {
      blockers.push(
        `${keepers.length} of ${stores.length} stores support ${KEPT_CURRENCY.toUpperCase()}; expected exactly one, so it is unclear which store to keep`,
      );
    } else {
      const kept = keepers[0];
      const duplicates = stores.filter((s) => s.id !== kept.id);
      keptStoreId = kept.id;
      duplicateStoreIds = duplicates.map((s) => s.id);

      for (const d of duplicates) {
        if (d.name !== DEMO_STORE_NAME) {
          blockers.push(
            `store ${d.id} is named "${d.name}", not "${DEMO_STORE_NAME}"; it does not look like a demo duplicate`,
          );
        }
      }
      // Where Medusa needs "the" store it takes whichever row the database
      // returns first, with no ordering. So any duplicate may be the one in
      // use today: if its defaults differ from the kept store's, removing
      // it changes the sales channel or region a cart falls back to.
      for (const d of duplicates) {
        if (
          d.default_sales_channel_id !== kept.default_sales_channel_id ||
          d.default_region_id !== kept.default_region_id
        ) {
          blockers.push(
            `store ${d.id} has a different default sales channel or region from the kept store ${kept.id}; removing it could change cart defaults`,
          );
        }
      }
    }
  } else if (keepers.length === 1) {
    keptStoreId = keepers[0].id;
  }

  if (location) {
    for (const s of stores) {
      if (
        s.default_location_id === location.id &&
        !duplicateStoreIds.includes(s.id)
      ) {
        blockers.push(
          `store ${s.id} has "${DEMO_LOCATION_NAME}" as its default location; change that in Admin first`,
        );
      }
    }
  }

  return {
    location,
    stores,
    kept_store_id: keptStoreId,
    duplicate_store_ids: duplicateStoreIds,
    blockers,
  };
}

/** Removes what the plan lists. Throws, changing nothing, if it must not. */
export async function applyDemoLeftoverRemoval(
  container: MedusaContainer,
  plan: DemoLeftoverPlan,
): Promise<void> {
  // Every refusal comes before the first delete.
  if (plan.blockers.length) {
    throw new Error(
      `Refusing to remove demo leftovers:\n- ${plan.blockers.join("\n- ")}`,
    );
  }
  if (
    plan.duplicate_store_ids.length &&
    (!plan.kept_store_id ||
      plan.duplicate_store_ids.includes(plan.kept_store_id))
  ) {
    throw new Error(
      "Refusing to remove stores: the store to keep is missing from the plan or listed as a duplicate",
    );
  }
  const inventoryModule = container.resolve(Modules.INVENTORY);

  if (plan.location) {
    // Levels first: the location workflow does not remove them, and they
    // would be left pointing at a deleted location.
    await inventoryModule.deleteInventoryItemLevelByLocationId(
      plan.location.id,
    );
    await deleteStockLocationsWorkflow(container).run({
      input: { ids: [plan.location.id] },
    });
  }

  if (plan.duplicate_store_ids.length) {
    await deleteStoresWorkflow(container).run({
      input: { ids: plan.duplicate_store_ids },
    });
  }
}

/** Throws unless everything the plan listed is really gone. */
export async function verifyDemoLeftoversRemoved(
  container: MedusaContainer,
  plan: DemoLeftoverPlan,
): Promise<void> {
  const problems: string[] = [];
  if (plan.location) {
    const levels = await container
      .resolve(Modules.INVENTORY)
      .listInventoryLevels({ location_id: plan.location.id }, ALL);
    if (levels.length) {
      problems.push(
        `${levels.length} inventory level(s) still exist at ${plan.location.id}`,
      );
    }
    const locations = await container
      .resolve(Modules.STOCK_LOCATION)
      .listStockLocations({}, ALL);
    if (locations.some((l) => l.id === plan.location?.id)) {
      problems.push(`stock location ${plan.location.id} still exists`);
    }
  }
  if (plan.duplicate_store_ids.length) {
    const stores = await container.resolve(Modules.STORE).listStores({}, ALL);
    const left = stores.filter((s) => plan.duplicate_store_ids.includes(s.id));
    if (left.length) {
      problems.push(
        `store(s) still exist: ${left.map((s) => s.id).join(", ")}`,
      );
    }
    if (!stores.some((s) => s.id === plan.kept_store_id)) {
      problems.push(`the kept store ${plan.kept_store_id} is missing`);
    }
  }
  if (problems.length) {
    throw new Error(
      `Removal ran but did not finish:\n- ${problems.join("\n- ")}`,
    );
  }
}

function parseIds(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export default async function remove_demo_leftovers({
  container,
}: {
  container: MedusaContainer;
}) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const plan = await planDemoLeftoverRemoval(container);

  // Say what was found, without claiming anything a blocker may contradict.
  if (plan.location) {
    const l = plan.location;
    logger.info(
      `Stock location "${l.name}" ${l.id}: ${l.levels.length} inventory level(s), reserved count ${l.reserved_total}, reservation rows ${l.reservation_count}`,
    );
    for (const level of l.levels) {
      logger.info(`  level ${level.id}: reserved ${level.reserved}`);
    }
  }
  for (const s of plan.stores) {
    const role =
      s.id === plan.kept_store_id
        ? "KEEP"
        : plan.duplicate_store_ids.includes(s.id)
          ? "REMOVE"
          : "leave";
    logger.info(
      `Store ${s.id} [${role}] "${s.name}" currencies=${s.currencies.join("/") || "none"} default_sales_channel=${s.default_sales_channel_id} default_region=${s.default_region_id} default_location=${s.default_location_id}`,
    );
  }

  if (plan.blockers.length) {
    for (const b of plan.blockers) logger.error(`Blocked: ${b}`);
    throw new Error(
      `Nothing was changed: ${plan.blockers.length} blocker(s), listed above`,
    );
  }

  if (!plan.location && !plan.duplicate_store_ids.length) {
    logger.info("Nothing to remove");
    return;
  }

  const confirmLine = [
    "APPLY=true",
    plan.location ? `CONFIRM_LOCATION_ID=${plan.location.id}` : "",
    plan.duplicate_store_ids.length
      ? `CONFIRM_STORE_IDS=${plan.duplicate_store_ids.join(",")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (process.env.APPLY !== "true") {
    logger.info(
      process.env.APPLY
        ? `Dry run: APPLY is "${process.env.APPLY}", and only exactly "true" applies. Nothing was changed`
        : "Dry run: nothing was changed",
    );
    logger.info(
      `To remove the above, run this script again with: ${confirmLine}`,
    );
    return;
  }

  // Applying: the operator must name exactly what this run found.
  const confirmedLocation = (process.env.CONFIRM_LOCATION_ID ?? "").trim();
  const confirmedStores = parseIds(process.env.CONFIRM_STORE_IDS);
  const mismatches: string[] = [];
  if ((plan.location?.id ?? "") !== confirmedLocation) {
    mismatches.push(
      `CONFIRM_LOCATION_ID is "${confirmedLocation}" but this run found "${plan.location?.id ?? ""}"`,
    );
  }
  if (!sameIds(plan.duplicate_store_ids, confirmedStores)) {
    mismatches.push(
      `CONFIRM_STORE_IDS is "${confirmedStores.join(",")}" but this run found "${plan.duplicate_store_ids.join(",")}"`,
    );
  }
  if (mismatches.length) {
    for (const m of mismatches) logger.error(`Not confirmed: ${m}`);
    throw new Error(
      `Nothing was changed: the confirmation does not match what was found. Expected: ${confirmLine}`,
    );
  }

  await applyDemoLeftoverRemoval(container, plan);
  await verifyDemoLeftoversRemoved(container, plan);
  logger.info(
    "Removed. A plain re-run should now report nothing to remove",
  );
}
