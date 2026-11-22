import { parseCursor, toWholeNumber, type FeedCursor } from "../ops-feed/commerce";

/**
 * Contract 5, part 1, in report-only mode (decision D2, 2026-11-18):
 * Klear Operations sends each frame's on-hand from the stock ledger and the
 * fulfillment cursor that figure reflects (the watermark). Medusa works out
 * what its own stock should be and reports the difference. Nothing is
 * written: a person corrects Medusa from Operations' exception list.
 *
 * The writer mode (set the figure within the guards, the pause switch, the
 * daily cap, the frame allowlist) is not built; it is one decision away and
 * belongs with it.
 */

export class StockSyncBadRequest extends Error {}

export type FrameStockRequest = {
  watermark: FeedCursor | null;
  frames: Array<{ inventory_item_id: string; on_hand: number }>;
};

const ITEM_ID = /^[A-Za-z0-9_]{1,100}$/;
export const MAX_FRAMES = 200;
const MAX_ON_HAND = 1_000_000;

/**
 * The request, checked. `watermark` must be present: a cursor the
 * fulfillments feed returned, or null when the ledger has taken in no
 * fulfillment yet. Per frame: an inventory item id and a whole on-hand
 * figure. Receipt movements, which the contract also sends, are not read:
 * they explain a write, and report-only makes none.
 */
export function parseFrameStockBody(body: unknown): FrameStockRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new StockSyncBadRequest("the body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (!("watermark" in b) || b.watermark === undefined) {
    throw new StockSyncBadRequest("watermark is required (null before the first fulfillment)");
  }
  let watermark: FeedCursor | null = null;
  if (b.watermark !== null) {
    const parsed = parseCursor(b.watermark);
    if (parsed === null || parsed === "invalid") {
      throw new StockSyncBadRequest("watermark must be a cursor the fulfillments feed returned");
    }
    watermark = parsed;
  }
  if (!Array.isArray(b.frames) || b.frames.length === 0 || b.frames.length > MAX_FRAMES) {
    throw new StockSyncBadRequest(`frames must be a list of 1 to ${MAX_FRAMES}`);
  }
  const seen = new Set<string>();
  const frames = b.frames.map((f, i) => {
    const frame = (f ?? {}) as Record<string, unknown>;
    const id = frame.inventory_item_id;
    const onHand = frame.on_hand;
    if (typeof id !== "string" || !ITEM_ID.test(id)) {
      throw new StockSyncBadRequest(`frame ${i + 1}: inventory_item_id is not an id`);
    }
    if (seen.has(id)) throw new StockSyncBadRequest(`frame ${i + 1}: ${id} is listed twice`);
    seen.add(id);
    if (typeof onHand !== "number" || !Number.isInteger(onHand) || onHand < 0 || onHand > MAX_ON_HAND) {
      throw new StockSyncBadRequest(`frame ${i + 1}: on_hand must be a whole number from 0`);
    }
    return { inventory_item_id: id, on_hand: onHand };
  });
  return { watermark, frames };
}

export type FrameResult = {
  inventory_item_id: string;
  known: boolean;
  /** True when everything Medusa did to this item is behind the
   *  watermark, so the ledger's figure is what Medusa should hold. Only a
   *  settled frame carries an `expected` and a `difference`. */
  settled: boolean;
  medusa_stocked: number | null;
  expected: number | null;
  difference: number | null;
  written: false;
};

type Pg = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };
type Inventory = {
  listInventoryItems: (filter: unknown, config?: unknown) => Promise<Array<{ id: string }>>;
  listInventoryLevels: (
    filter: unknown,
    config?: unknown,
  ) => Promise<Array<{ inventory_item_id: string; stocked_quantity: unknown }>>;
};
type Locking = {
  execute: <T>(keys: string[], job: () => Promise<T>, args?: { timeout?: number }) => Promise<T>;
};

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/**
 * Compare every frame in the request, inside the same per-item lock that
 * Medusa's own stock adjustment takes (`adjustInventoryLevelsStep`), so no
 * adjustment lands between reading the stock and reading the fulfillments.
 *
 * The watermark is a position in the fulfillments feed: (updated time, id).
 * The ledger has taken in, in its current state, every order fulfillment at
 * or before that position, and nothing after it. So a frame is SETTLED when
 * none of its order fulfillments is after the watermark, and then Medusa's
 * stock should be exactly the ledger's on-hand: whatever Medusa shipped or
 * took back, the ledger has seen. A frame with any order fulfillment after
 * the watermark is not settled, and no difference is reported for it: the
 * ledger may simply not have read that fulfillment yet, and a person must
 * not "correct" Medusa for it. That also covers a fulfillment created
 * before the watermark's time but updated afterwards, which the feed has
 * not served (comparing created times instead would count it as read).
 *
 * Also not settled: a frame with any fulfillment, linked to an order or
 * not, created or updated within the feed's 60-second hold-back. Medusa
 * takes the stock off (`adjustInventoryLevelsStep`) before it links the
 * fulfillment to its order, so for a moment the stock is gone and no order
 * fulfillment shows it. A fulfillment that is never linked (a return's
 * inbound one) holds a frame back only for those 60 seconds; it is never
 * served, so waiting for the watermark to pass it would hold the frame for
 * good.
 */
export async function reportFrameStock(
  deps: { pg: Pg; inventory: Inventory; locking: Locking },
  request: FrameStockRequest,
): Promise<FrameResult[]> {
  const ids = request.frames.map((f) => f.inventory_item_id);
  const keys = [...ids].sort();
  // Before any fulfillment was taken in: every order fulfillment is after.
  const at = request.watermark?.at ?? "-infinity";
  const id = request.watermark?.id ?? "";

  return await deps.locking.execute(
    keys,
    async () => {
      const known = new Set(
        (await deps.inventory.listInventoryItems({ id: ids }, { select: ["id"], take: null })).map((i) => i.id),
      );
      const stocked = new Map<string, number>();
      const levels = await deps.inventory.listInventoryLevels(
        { inventory_item_id: ids },
        { select: ["inventory_item_id", "stocked_quantity"], take: null },
      );
      for (const level of levels) {
        stocked.set(
          level.inventory_item_id,
          (stocked.get(level.inventory_item_id) ?? 0) + toWholeNumber(level.stocked_quantity),
        );
      }
      const { rows } = await deps.pg.raw(
        `select distinct fi."inventory_item_id"
           from "fulfillment_item" fi
           join "fulfillment" f on f."id" = fi."fulfillment_id" and f."deleted_at" is null
          where (
              (exists (select 1 from "order_fulfillment" l
                        where l."fulfillment_id" = f."id" and l."deleted_at" is null)
               and (f."updated_at", f."id") > (?::timestamptz, ?))
              or f."updated_at" > now() - interval '60 seconds'
              or f."created_at" > now() - interval '60 seconds'
            )
            and fi."deleted_at" is null
            and fi."inventory_item_id" in (${placeholders(ids.length)})`,
        [at, id, ...ids],
      );
      const unsettled = new Set((rows as Array<{ inventory_item_id: string }>).map((r) => r.inventory_item_id));
      return request.frames.map((frame): FrameResult => {
        const isKnown = known.has(frame.inventory_item_id);
        const settled = isKnown && !unsettled.has(frame.inventory_item_id);
        const medusaStocked = isKnown ? stocked.get(frame.inventory_item_id) ?? 0 : null;
        return {
          inventory_item_id: frame.inventory_item_id,
          known: isKnown,
          settled,
          medusa_stocked: medusaStocked,
          expected: settled ? frame.on_hand : null,
          difference: settled && medusaStocked !== null ? medusaStocked - frame.on_hand : null,
          written: false,
        };
      });
    },
    // Seconds. A fulfillment holds the lock for one adjustment; waiting
    // longer than this means something is stuck, and the sync tries again
    // next cycle.
    { timeout: 10 },
  );
}
