import { SKU } from "../../modules/lms/production";
import { StockSyncBadRequest } from "./frame-stock";

/**
 * Contract 5, part 2: the lens snapshot Klear Operations sends the lab
 * system. One figure per lens SKU, on-hand as of the end of the last usage
 * window Operations has applied. SKUs and quantities only.
 */

export type LensSnapshotRequest = {
  as_of: string;
  lenses: Array<{ sku: string; on_hand: number }>;
};

// Klear stocks 277 lens SKUs. 2,000 of them is about 80 KB of JSON, inside
// the request body size Medusa accepts by default.
export const MAX_LENSES = 2000;
const MAX_ON_HAND = 1_000_000;

function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The snapshot, checked. Every SKU has the shape the lab's own lens
 *  steps accept, appears once, and has a whole on-hand from 0. An empty
 *  snapshot is refused: an empty shelf is every SKU at zero. */
export function parseLensSnapshotBody(body: unknown): LensSnapshotRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new StockSyncBadRequest("the body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (!isCalendarDate(b.as_of)) throw new StockSyncBadRequest("as_of must be a date, YYYY-MM-DD");
  if (!Array.isArray(b.lenses) || b.lenses.length === 0 || b.lenses.length > MAX_LENSES) {
    throw new StockSyncBadRequest(`lenses must be a list of 1 to ${MAX_LENSES}`);
  }
  const seen = new Set<string>();
  const lenses = b.lenses.map((l, i) => {
    const lens = (l ?? {}) as Record<string, unknown>;
    if (typeof lens.sku !== "string" || !SKU.test(lens.sku)) {
      throw new StockSyncBadRequest(`lens ${i + 1}: sku is not a SKU (capitals, digits, . _ + -)`);
    }
    if (seen.has(lens.sku)) throw new StockSyncBadRequest(`lens ${i + 1}: the SKU is listed twice`);
    seen.add(lens.sku);
    const onHand = lens.on_hand;
    if (typeof onHand !== "number" || !Number.isInteger(onHand) || onHand < 0 || onHand > MAX_ON_HAND) {
      throw new StockSyncBadRequest(`lens ${i + 1}: on_hand must be a whole number from 0`);
    }
    return { sku: lens.sku, on_hand: onHand };
  });
  return { as_of: b.as_of, lenses };
}
