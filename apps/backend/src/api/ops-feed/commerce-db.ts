import {
  formatCursor,
  fulfillmentRecord,
  orderRecord,
  type FeedCursor,
  type FulfillmentLineRow,
  type FulfillmentRecord,
  type FulfillmentRow,
  type OrderDetail,
  type OrderRecord,
  type OrderRow,
} from "./commerce";

/**
 * The database side of the commerce feed (contract 1).
 *
 * Everything is read by SQL on Medusa's own tables. The page (which
 * records, in what order, up to where) needs what Medusa's query cannot
 * give: a tuple comparison on (updated_at, id), to the microsecond. An
 * order's contents are read at version 1, as placed: Medusa writes every
 * later change as a new version and keeps the version-1 rows as they were
 * (checked against the real server; see the README). The amounts are then
 * worked out in `orderRecord`, never taken from Medusa's totals.
 *
 * Every column is named. No `*`, no metadata, no address, no customer, and
 * of a fulfillment's provider data only the quoted cost.
 */

// What `req.scope` gives: Medusa's knex connection.
export type Pg = { raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: unknown[] }> };

export type FeedPage<T> = {
  records: T[];
  /** The cursor to send next time: the last record looked at, or the one
   *  sent when nothing was. */
  next_after: string | null;
  /** True when the page was full and more records are waiting now. */
  has_more: boolean;
  /** Medusa's own clock less 60 seconds: every record updated up to this
   *  moment has been served. Only when `has_more` is false; null otherwise,
   *  because a full page has not reached it. (Design 11.1 item 3.) */
  polled_through: string | null;
};

// UTC, microseconds, a "Z": the cursor's text. `at time zone 'UTC'` turns
// a timestamptz into the wall clock in UTC.
// The parentheses matter: `at time zone` binds tighter than `-`.
const ISO = (col: string) => `to_char((${col}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// Records younger than this are held back, so a transaction that wrote an
// earlier updated time but committed late is still read (contract 1,
// "Ordering and cursor", item 3).
const WITHHOLD = "60 seconds";

async function horizon(pg: Pg): Promise<string> {
  const { rows } = await pg.raw(`select ${ISO(`now() - interval '${WITHHOLD}'`)} as "horizon"`);
  return String((rows[0] as { horizon: string }).horizon);
}

/** The shared shape of both streams: rows after the cursor, up to the
 *  horizon, one more than the page to know whether there is more. */
function pageClause(alias: string, after: FeedCursor | null): { sql: string; bindings: unknown[] } {
  const base = `${alias}."deleted_at" is null and ${alias}."updated_at" <= ?::timestamptz`;
  if (!after) return { sql: base, bindings: [] };
  return {
    sql: `${base} and (${alias}."updated_at", ${alias}."id") > (?::timestamptz, ?)`,
    bindings: [after.at, after.id],
  };
}

function finish<T>(
  records: T[],
  lastSeen: { updated_at: string; id: string } | undefined,
  after: FeedCursor | null,
  hasMore: boolean,
  through: string,
): FeedPage<T> {
  return {
    records,
    next_after: lastSeen ? formatCursor({ at: lastSeen.updated_at, id: lastSeen.id }) : after ? formatCursor(after) : null,
    has_more: hasMore,
    polled_through: hasMore ? null : through,
  };
}

const placeholders = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** Orders after `after`, by (updated_at, id). Draft orders are not sales
 *  until converted (which updates them, so they appear then); a deleted
 *  order is left to Operations' nightly comparison (contract 1, behaviour
 *  item 6). */
export async function readOrdersPage(
  deps: { pg: Pg },
  after: FeedCursor | null,
  limit: number,
): Promise<FeedPage<OrderRecord>> {
  const through = await horizon(deps.pg);
  const where = pageClause("o", after);
  const { rows } = await deps.pg.raw(
    `select o."id", o."display_id", o."currency_code", o."sales_channel_id", o."version",
            ${ISO(`o."created_at"`)} as "placed_at",
            ${ISO(`o."canceled_at"`)} as "canceled_at",
            ${ISO(`o."updated_at"`)} as "updated_at"
       from "order" o
      where o."is_draft_order" = false and ${where.sql}
      order by o."updated_at", o."id"
      limit ?`,
    [through, ...where.bindings, limit + 1],
  );
  const page = (rows as OrderRow[]).slice(0, limit);
  const hasMore = rows.length > limit;
  if (page.length === 0) return finish([], undefined, after, false, through);

  const details = await readPlacedOrders(deps.pg, page.map((r) => r.id));
  const records = page.map((r) => orderRecord(r, details.get(r.id) ?? {}));
  return finish(records, page[page.length - 1], after, hasMore, through);
}

/**
 * The orders' contents as placed: their version-1 lines, quantities, unit
 * prices, adjustments and shipping methods. Each column is named; no row is
 * read whole, and nothing of metadata, the customer or an address.
 *
 * A unit price is on the order's item for the version when an edit set
 * one, else on the line itself (Medusa's own rule); version 1 is read.
 * Tax lines are not versioned and are read as they are now; they are only
 * used to tell a tax-inclusive price, and to refuse tax on top of a price.
 */
async function readPlacedOrders(pg: Pg, orderIds: string[]): Promise<Map<string, OrderDetail>> {
  const q = (list: unknown[]) => placeholders(list.length);
  const query = async <T>(sql: string, bindings: unknown[]) => (await pg.raw(sql, bindings)).rows as T[];

  const carts = await query<{ order_id: string; cart_id: string }>(
    `select l."order_id", l."cart_id" from "order_cart" l
      where l."order_id" in (${q(orderIds)}) and l."deleted_at" is null`,
    orderIds,
  );
  const items = await query<{
    order_id: string;
    id: string;
    title: string | null;
    subtitle: string | null;
    variant_sku: string | null;
    quantity: string;
    unit_price: string | null;
    is_tax_inclusive: boolean;
  }>(
    `select oi."order_id", li."id", li."title", li."subtitle", li."variant_sku",
            oi."quantity"::text as "quantity",
            coalesce(oi."unit_price", li."unit_price")::text as "unit_price",
            li."is_tax_inclusive"
       from "order_item" oi
       join "order_line_item" li on li."id" = oi."item_id" and li."deleted_at" is null
      where oi."order_id" in (${q(orderIds)}) and oi."version" = 1 and oi."deleted_at" is null
      order by oi."order_id", li."id"`,
    orderIds,
  );
  const itemIds = items.map((i) => i.id);
  const itemTax = itemIds.length
    ? await query<{ item_id: string; rate: string }>(
        `select t."item_id", t."rate"::text as "rate" from "order_line_item_tax_line" t
          where t."item_id" in (${q(itemIds)}) and t."deleted_at" is null`,
        itemIds,
      )
    : [];
  const itemAdj = itemIds.length
    ? await query<{ item_id: string; amount: string; is_tax_inclusive: boolean }>(
        `select a."item_id", a."amount"::text as "amount", a."is_tax_inclusive" from "order_line_item_adjustment" a
          where a."item_id" in (${q(itemIds)}) and a."version" = 1 and a."deleted_at" is null`,
        itemIds,
      )
    : [];
  const ship = await query<{ order_id: string; id: string; amount: string; is_tax_inclusive: boolean }>(
    `select s."order_id", m."id", m."amount"::text as "amount", m."is_tax_inclusive"
       from "order_shipping" s
       join "order_shipping_method" m on m."id" = s."shipping_method_id" and m."deleted_at" is null
      where s."order_id" in (${q(orderIds)}) and s."version" = 1 and s."deleted_at" is null
      order by s."order_id", m."id"`,
    orderIds,
  );
  const shipIds = ship.map((m) => m.id);
  const shipTax = shipIds.length
    ? await query<{ shipping_method_id: string; rate: string }>(
        `select t."shipping_method_id", t."rate"::text as "rate" from "order_shipping_method_tax_line" t
          where t."shipping_method_id" in (${q(shipIds)}) and t."deleted_at" is null`,
        shipIds,
      )
    : [];
  const shipAdj = shipIds.length
    ? await query<{ shipping_method_id: string; amount: string }>(
        `select a."shipping_method_id", a."amount"::text as "amount" from "order_shipping_method_adjustment" a
          where a."shipping_method_id" in (${q(shipIds)}) and a."version" = 1 and a."deleted_at" is null`,
        shipIds,
      )
    : [];

  const out = new Map<string, OrderDetail>();
  for (const id of orderIds) out.set(id, { cart_id: null, items: [], shipping_methods: [] });
  for (const c of carts) out.get(c.order_id)!.cart_id = c.cart_id;
  for (const i of items) {
    out.get(i.order_id)!.items!.push({
      id: i.id,
      title: i.title,
      subtitle: i.subtitle,
      variant_sku: i.variant_sku,
      quantity: i.quantity,
      unit_price: i.unit_price,
      is_tax_inclusive: i.is_tax_inclusive,
      tax_lines: itemTax.filter((t) => t.item_id === i.id).map((t) => ({ rate: t.rate })),
      adjustments: itemAdj
        .filter((a) => a.item_id === i.id)
        .map((a) => ({ amount: a.amount, is_tax_inclusive: a.is_tax_inclusive })),
    });
  }
  for (const m of ship) {
    out.get(m.order_id)!.shipping_methods!.push({
      id: m.id,
      amount: m.amount,
      is_tax_inclusive: m.is_tax_inclusive,
      tax_lines: shipTax.filter((t) => t.shipping_method_id === m.id).map((t) => ({ rate: t.rate })),
      adjustments: shipAdj.filter((a) => a.shipping_method_id === m.id).map((a) => ({ amount: a.amount })),
    });
  }
  return out;
}

/** Fulfillments of orders after `after`, by (updated_at, id). Only a
 *  fulfillment linked to an order: a return's inbound fulfillment is linked
 *  to the return, ships nothing and consumes no stock. */
export async function readFulfillmentsPage(
  deps: { pg: Pg },
  after: FeedCursor | null,
  limit: number,
): Promise<FeedPage<FulfillmentRecord>> {
  const through = await horizon(deps.pg);
  const where = pageClause("f", after);
  const { rows } = await deps.pg.raw(
    `select f."id", l."order_id",
            ${ISO(`f."created_at"`)} as "created_at",
            ${ISO(`f."canceled_at"`)} as "canceled_at",
            ${ISO(`f."delivered_at"`)} as "delivered_at",
            ${ISO(`f."updated_at"`)} as "updated_at",
            (f."data" ->> 'cost_thb') as "cost_thb",
            -- A replacement ships an item a claim or an exchange added to
            -- the order (Medusa 2.14 records that only on the change
            -- action that added the line), added BEFORE this fulfillment
            -- was made. A claim can add more of an existing line; that must
            -- not turn the line's earlier, original shipment into a
            -- replacement after the fact. Both times are fixed, so a
            -- fulfillment's kind never changes once served.
            exists (
              select 1
                from "fulfillment_item" fi
                join "order_change_action" a
                  on a."order_id" = l."order_id"
                 and (a."details" ->> 'reference_id') = fi."line_item_id"
               where fi."fulfillment_id" = f."id"
                 and fi."deleted_at" is null
                 and a."deleted_at" is null
                 and a."action" = 'ITEM_ADD'
                 and (a."claim_id" is not null or a."exchange_id" is not null)
                 and a."created_at" <= f."created_at"
            ) as "is_replacement"
       from "fulfillment" f
       join "order_fulfillment" l
         on l."fulfillment_id" = f."id" and l."deleted_at" is null
      where ${where.sql}
      order by f."updated_at", f."id"
      limit ?`,
    [through, ...where.bindings, limit + 1],
  );
  const page = (rows as FulfillmentRow[]).slice(0, limit);
  const hasMore = rows.length > limit;
  if (page.length === 0) return finish([], undefined, after, false, through);

  const ids = page.map((r) => r.id);
  const { rows: lines } = await deps.pg.raw(
    `select fi."fulfillment_id", fi."line_item_id", fi."sku", fi."quantity"::text as "quantity"
       from "fulfillment_item" fi
      where fi."fulfillment_id" in (${placeholders(ids.length)}) and fi."deleted_at" is null
      order by fi."fulfillment_id", fi."id"`,
    ids,
  );
  const records = page.map((r) => fulfillmentRecord(r, lines as FulfillmentLineRow[]));
  return finish(records, page[page.length - 1], after, hasMore, through);
}
