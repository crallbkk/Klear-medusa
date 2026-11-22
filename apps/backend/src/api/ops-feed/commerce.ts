/**
 * The commerce feed to Klear Operations (contract 1): the orders stream and
 * the fulfillments stream. Pure parts only: the cursor, money, and the two
 * records, each built from an explicit list of fields. The database reads
 * are in `commerce-db.ts`; the routes are `orders/route.ts` and
 * `fulfillments/route.ts`.
 *
 * What must never appear in a record (contract 1, "Must never cross"):
 * order or line metadata (it carries the prescription id and the lens
 * configuration), the packet, prescription ids, the customer and their
 * name, addresses, email and phone, catalog attributes, and tracking
 * numbers. A record is never made by copying an object and removing
 * fields; each field below is named and read on its own.
 */

/** Where a page ends: the record's updated time, to the microsecond as
 *  Postgres keeps it, and its id. Records are served by (at, id). */
export type FeedCursor = { at: string; id: string };

// A UTC timestamp with up to six fraction digits, as `formatCursor` writes
// it. Microseconds matter: Postgres keeps them, and a cursor cut to
// milliseconds would serve its own last record again on every page.
const CURSOR_AT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?Z$/;
// Medusa ids are letters, digits and underscores. Empty is allowed: it
// sorts before every id, so "<time>|" means "from that moment".
const CURSOR_ID = /^[A-Za-z0-9_]{0,100}$/;

/** `null` for "from the start", `"invalid"` for anything malformed. */
export function parseCursor(raw: unknown): FeedCursor | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return "invalid";
  const bar = raw.indexOf("|");
  if (bar < 0) return "invalid";
  const at = raw.slice(0, bar);
  const id = raw.slice(bar + 1);
  const m = CURSOR_AT.exec(at);
  if (!m || !CURSOR_ID.test(id)) return "invalid";
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Refuses 2026-13-45 and 25:00, which Date would quietly roll over.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return "invalid";
  }
  return { at, id };
}

export function formatCursor(c: FeedCursor): string {
  return `${c.at}|${c.id}`;
}

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

/** A whole number of records per page, kept between 1 and the maximum.
 *  Anything that is not a plain number is the default. */
export function parseLimit(raw: unknown): number {
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Number(raw), 1), MAX_LIMIT);
}

/**
 * A value Medusa handed over that the feed cannot serve as the contract
 * says (a missing total, a fractional quantity). Its message is one of a
 * few fixed phrases and, from `orderRecord` and `fulfillmentRecord`, the
 * name of the field: never the value itself. So it may be logged.
 */
export class FeedValueError extends Error {
  /** The Medusa id of the order or fulfillment that could not be served,
   *  once known. Only an id, and only if it has the shape of one. */
  readonly record_id: string | null;
  constructor(message: string, recordId: string | null = null) {
    super(message);
    this.name = "FeedValueError";
    this.record_id = recordId;
  }
}

const RECORD_ID = /^[A-Za-z0-9_]{1,100}$/;

/** Build a record; if it cannot be built, say which one by its id. */
function named<T>(kind: "order" | "fulfillment", id: unknown, build: () => T): T {
  try {
    return build();
  } catch (err) {
    if (err instanceof FeedValueError) {
      const safe = typeof id === "string" && RECORD_ID.test(id) ? id : null;
      throw new FeedValueError(`${kind} ${safe ?? "(id not shown)"}: ${err.message}`, safe);
    }
    throw err;
  }
}

/** Read one field, and name it if it cannot be read. */
function field<T>(name: string, read: () => T): T {
  try {
    return read();
  } catch (err) {
    if (err instanceof FeedValueError) throw new FeedValueError(`${name}: ${err.message}`);
    throw err;
  }
}

/**
 * The exact decimal text of an amount as Medusa hands it over: a number, a
 * numeric string, Medusa's BigNumber (exact text in `bigNumber.toFixed()`
 * or `raw.value`), or a raw `{ value }`.
 */
function decimalText(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FeedValueError("not an amount");
    // The shortest text that reads back as this number: 0.29 is "0.29",
    // not 0.28999999999999998.
    return String(value);
  }
  if (typeof value === "string") return value.trim();
  if (value !== null && typeof value === "object") {
    const v = value as {
      bigNumber?: { toFixed?: () => string };
      raw?: { value?: unknown };
      value?: unknown;
    };
    if (v.bigNumber && typeof v.bigNumber.toFixed === "function") return v.bigNumber.toFixed();
    if (v.raw && (typeof v.raw.value === "string" || typeof v.raw.value === "number")) {
      return decimalText(v.raw.value);
    }
    if (typeof v.value === "string" || typeof v.value === "number") return decimalText(v.value);
  }
  // The kind of thing it was, never the thing: a type and a class name.
  const ctor = (value as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  const cls = typeof ctor === "string" && /^[A-Za-z]{1,40}$/.test(ctor) ? ` ${ctor}` : "";
  throw new FeedValueError(`not an amount (${value === null ? "null" : typeof value}${cls})`);
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/;

/** An exact decimal: `coef` times ten to the power `exp`. */
type Dec = { coef: bigint; exp: number };

const TEN = BigInt(10);
const pow10 = (n: number) => TEN ** BigInt(n);

/** An amount Medusa handed over, exactly. A missing amount is an error,
 *  never zero: a field Medusa did not fill must not cross as free. */
function decimalOf(value: unknown): Dec {
  if (value === null || value === undefined) throw new FeedValueError("amount missing");
  const m = DECIMAL.exec(decimalText(value));
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new FeedValueError("not an amount");
  const frac = m[3] ?? "";
  return {
    coef: BigInt(`${m[1] === "-" ? "-" : ""}${m[2] || "0"}${frac}`),
    exp: Number(m[4] ?? 0) - frac.length,
  };
}

function addDec(a: Dec, b: Dec): Dec {
  const exp = Math.min(a.exp, b.exp);
  return { coef: a.coef * pow10(a.exp - exp) + b.coef * pow10(b.exp - exp), exp };
}

const mulDec = (a: Dec, b: Dec): Dec => ({ coef: a.coef * b.coef, exp: a.exp + b.exp });
const ZERO: Dec = { coef: BigInt(0), exp: 0 };
const sumDec = (values: Dec[]) => values.reduce(addDec, ZERO);

/** Whole satang (hundredths of a baht), a fraction of one rounded half
 *  away from zero. */
function satangOf(d: Dec): number {
  const shift = d.exp + 2;
  const negative = d.coef < BigInt(0);
  const abs = negative ? -d.coef : d.coef;
  let whole: bigint;
  if (shift >= 0) {
    whole = abs * pow10(shift);
  } else {
    const div = pow10(-shift);
    whole = abs / div + (BigInt(2) * (abs % div) >= div ? BigInt(1) : BigInt(0));
  }
  const n = Number(negative ? -whole : whole);
  if (!Number.isSafeInteger(n)) throw new FeedValueError("amount out of range");
  return n === 0 ? 0 : n;
}

/**
 * An amount in baht as an exact number of satang, by integer arithmetic:
 * no floating point touches the value. A fraction of a satang is rounded
 * half away from zero.
 */
export function toSatang(value: unknown): number {
  return satangOf(decimalOf(value));
}

/** A quantity, which must be whole. */
export function toWholeNumber(value: unknown): number {
  const text = decimalText(value);
  if (!/^[+-]?\d+(\.0*)?$/.test(text)) throw new FeedValueError("not a whole number");
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new FeedValueError("quantity out of range");
  return n;
}

/** The columns `commerce-db.ts` reads from Medusa's "order" table. Times
 *  are UTC text to the microsecond. */
export type OrderRow = {
  id: string;
  display_id: number | string | null;
  currency_code: string;
  sales_channel_id: string | null;
  placed_at: string;
  canceled_at: string | null;
  updated_at: string;
  version: number | string;
};

export type OrderLine = {
  id: string;
  sku: string | null;
  description: string;
  quantity: number;
  gross_satang: number;
  discount_satang: number;
};

export type OrderRecord = {
  id: string;
  display_id: number | null;
  cart_id: string | null;
  placed_at: string;
  currency_code: string;
  item_total_satang: number;
  discount_total_satang: number;
  shipping_total_satang: number;
  total_satang: number;
  canceled_at: string | null;
  sales_channel_id: string | null;
  /** Medusa's current version of the order. Rises with every later change
   *  (a fulfillment, a return, a claim, an edit); the amounts do not. An
   *  addition to contract 1 (see the README). */
  version: number;
  updated_at: string;
  lines: OrderLine[];
};

/** What `commerce-db.ts` reads for one order AS PLACED: the order's
 *  version-1 rows. Only these fields are read from it. */
export type OrderDetail = {
  cart_id?: string | null;
  items?: Array<{
    id: string;
    title?: string | null;
    subtitle?: string | null;
    variant_sku?: string | null;
    quantity: unknown;
    unit_price: unknown;
    is_tax_inclusive?: boolean | null;
    tax_lines?: Array<{ rate: unknown }>;
    adjustments?: Array<{ amount: unknown; is_tax_inclusive?: boolean | null }>;
  }>;
  shipping_methods?: Array<{
    id: string;
    amount: unknown;
    is_tax_inclusive?: boolean | null;
    tax_lines?: Array<{ rate: unknown }>;
    adjustments?: Array<{ amount: unknown; is_tax_inclusive?: boolean | null }>;
  }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const HUNDRED: Dec = { coef: BigInt(1), exp: 2 };
const ONE: Dec = { coef: BigInt(1), exp: 0 };

/**
 * The tax rate on a line or a shipping method, as a fraction (7 % is
 * 0.07), and whether its amounts are what the customer paid.
 *
 * Klear is not VAT-registered and the store's rate is 0, but orders placed
 * before 2026-10-11 can carry a 7 % tax line. Those prices were
 * tax-inclusive: the unit price is what the customer paid, so such a line is
 * served at its price, whatever the rate. A non-zero rate on a
 * tax-EXCLUSIVE line or method would put tax on top of the price, which the
 * contract does not carry, so that order is refused rather than served
 * short.
 */
function taxOf(thing: Loose, what: string): Dec {
  const rate = sumDec((Array.isArray(thing?.tax_lines) ? thing.tax_lines : []).map((t: Loose) => decimalOf(t?.rate ?? 0)));
  if (rate.coef !== BigInt(0) && thing?.is_tax_inclusive !== true) {
    throw new FeedValueError(`${what} carries tax on top of its price; Klear's figures assume none`);
  }
  // Percent to a fraction, exactly.
  return { coef: rate.coef, exp: rate.exp - HUNDRED.exp };
}

/** A line's or a method's discounts in what the customer paid. Medusa
 *  counts a tax-inclusive adjustment as it is and adds the tax to one that
 *  is not (`calculateAdjustmentTotal`); with no tax both are the amount. */
function discountOf(thing: Loose, rate: Dec): Dec {
  const adjustments: Loose[] = Array.isArray(thing?.adjustments) ? thing.adjustments : [];
  return sumDec(
    adjustments.map((adj) => {
      const amount = decimalOf(adj?.amount);
      return adj?.is_tax_inclusive === true ? amount : mulDec(amount, addDec(ONE, rate));
    }),
  );
}

/** Exact satang as a fraction `units / 10^k`, for allocation. */
function asSatangUnits(d: Dec, k: number): bigint {
  // satang = coef * 10^(exp + 2); scaled by 10^k it must be whole.
  const shift = d.exp + 2 + k;
  return shift >= 0 ? d.coef * pow10(shift) : d.coef / pow10(-shift);
}

const floorDiv = (n: bigint, d: bigint) => {
  const q = n / d;
  return n % d !== BigInt(0) && n < BigInt(0) ? q - BigInt(1) : q;
};

/**
 * Whole satang for each exact value, so that they add up exactly to the
 * rounded exact sum (rounded once, half away from zero). Each value gets
 * its floor; the satang still owed go to the largest remainders, ties by
 * key, so the result does not depend on the order Medusa listed them in.
 * A 100 THB discount spread over three lines (33.333... each) is
 * 3334 + 3333 + 3333 = 10000, never 9999.
 */
export function allocateSatang(values: Array<{ key: string; amount: Dec }>): Map<string, number> {
  const out = new Map<string, number>();
  if (values.length === 0) return out;
  // A common scale fine enough to hold every value exactly.
  const k = Math.max(0, ...values.map((v) => -(v.amount.exp + 2)));
  const scale = pow10(k);
  const units = values.map((v) => ({ key: v.key, units: asSatangUnits(v.amount, k) }));
  const total = units.reduce((acc, u) => acc + u.units, BigInt(0));
  const target = satangOf({ coef: total, exp: -2 - k });
  const parts = units.map((u) => {
    const floor = floorDiv(u.units, scale);
    return { key: u.key, floor, rem: u.units - floor * scale };
  });
  let owed = BigInt(target) - parts.reduce((acc, p) => acc + p.floor, BigInt(0));
  const byRemainder = [...parts].sort((x, y) =>
    x.rem === y.rem ? (x.key < y.key ? -1 : x.key > y.key ? 1 : 0) : x.rem > y.rem ? -1 : 1,
  );
  const extra = new Map<string, bigint>();
  // `owed` is between 0 and the number of values; the loop also handles a
  // negative sum rounded away from zero.
  for (let i = 0; owed > BigInt(0); i = (i + 1) % byRemainder.length, owed -= BigInt(1)) {
    extra.set(byRemainder[i].key, (extra.get(byRemainder[i].key) ?? BigInt(0)) + BigInt(1));
  }
  for (let i = byRemainder.length - 1; owed < BigInt(0); i = (i - 1 + byRemainder.length) % byRemainder.length, owed += BigInt(1)) {
    extra.set(byRemainder[i].key, (extra.get(byRemainder[i].key) ?? BigInt(0)) - BigInt(1));
  }
  for (const p of parts) {
    const n = Number(p.floor + (extra.get(p.key) ?? BigInt(0)));
    if (!Number.isSafeInteger(n)) throw new FeedValueError("amount out of range");
    out.set(p.key, n === 0 ? 0 : n);
  }
  return out;
}

const sum = (ns: number[]) => ns.reduce((a, n) => a + n, 0);

/**
 * One order as it crosses: the order AS PLACED, read from its version-1
 * rows (`commerce-db.ts`). Medusa keeps those rows unchanged when a later
 * change (a fulfillment, a return, a claim, an exchange, an edit, a
 * refreshed promotion) writes the next version, so none of that moves an
 * amount here; `version` says that something changed.
 *
 * Amounts are whole satang. Each family of figures (lines' gross, lines'
 * discounts, shipping amounts, shipping discounts) is rounded ONCE, on its
 * exact sum, and the satang are then shared out to the lines by largest
 * remainder (`allocateSatang`). So, exactly, for every record:
 *
 * 1. a line's `gross_satang` is its unit price times its quantity;
 * 2. its `discount_satang` is its adjustments, in what the customer paid;
 * 3. `item_total` is the lines' gross less their discounts;
 * 4. `shipping_total` is the shipping amounts less their discounts;
 * 5. `discount_total` is the lines' and the shipping's discounts;
 * 6. `total` is `item_total` plus `shipping_total`.
 *
 * Medusa's own totals are never read. Credit lines (store credit, a gift
 * card) are not subtracted. Medusa's tax figure is not carried.
 */
export function orderRecord(row: OrderRow, detail: OrderDetail | Loose): OrderRecord {
  return named("order", row?.id, () => {
    const items: Loose[] = Array.isArray(detail?.items) ? detail.items : [];
    const methods: Loose[] = Array.isArray(detail?.shipping_methods) ? detail.shipping_methods : [];

    const lineFacts = items.map((item) => {
      const rate = taxOf(item, "a line");
      const quantity = field("line quantity", () => toWholeNumber(item?.quantity));
      return {
        item,
        key: String(item.id),
        quantity,
        gross: field("line unit price", () => mulDec(decimalOf(item?.unit_price), { coef: BigInt(quantity), exp: 0 })),
        discount: field("line adjustments", () => discountOf(item, rate)),
      };
    });
    const shippingFacts = methods.map((m) => {
      const rate = taxOf(m, "a shipping method");
      return {
        key: String(m.id),
        amount: field("shipping amount", () => decimalOf(m?.amount)),
        discount: field("shipping adjustments", () => discountOf(m, rate)),
      };
    });

    const gross = allocateSatang(lineFacts.map((l) => ({ key: l.key, amount: l.gross })));
    const discount = allocateSatang(lineFacts.map((l) => ({ key: l.key, amount: l.discount })));
    const shipAmount = allocateSatang(shippingFacts.map((m) => ({ key: m.key, amount: m.amount })));
    const shipDiscount = allocateSatang(shippingFacts.map((m) => ({ key: m.key, amount: m.discount })));

    const lines: OrderLine[] = lineFacts.map((l) => {
      const title = typeof l.item?.title === "string" ? l.item.title : "";
      const subtitle = typeof l.item?.subtitle === "string" && l.item.subtitle !== "" ? l.item.subtitle : null;
      return {
        id: l.key,
        sku: typeof l.item?.variant_sku === "string" ? l.item.variant_sku : null,
        // What the line was called when it was sold: the product's title
        // and, when there is one, the variant's (for a lens line, its tier).
        description: subtitle ? `${title} / ${subtitle}` : title,
        quantity: l.quantity,
        gross_satang: gross.get(l.key) ?? 0,
        discount_satang: discount.get(l.key) ?? 0,
      };
    });
    const itemTotal = sum(lines.map((l) => l.gross_satang - l.discount_satang));
    const shipDiscountTotal = sum([...shipDiscount.values()]);
    const shippingTotal = sum([...shipAmount.values()]) - shipDiscountTotal;
    return {
      id: String(row.id),
      display_id: row.display_id === null || row.display_id === undefined ? null : Number(row.display_id),
      cart_id: typeof detail?.cart_id === "string" ? detail.cart_id : null,
      placed_at: row.placed_at,
      currency_code: String(row.currency_code),
      item_total_satang: itemTotal,
      discount_total_satang: sum(lines.map((l) => l.discount_satang)) + shipDiscountTotal,
      shipping_total_satang: shippingTotal,
      total_satang: itemTotal + shippingTotal,
      canceled_at: row.canceled_at ?? null,
      sales_channel_id: row.sales_channel_id ?? null,
      version: field("version", () => toWholeNumber(row.version)),
      updated_at: row.updated_at,
      lines,
    };
  });
}

/** The columns `commerce-db.ts` reads for a fulfillment. Times are UTC
 *  text to the microsecond. `cost_thb` is the one value taken out of the
 *  provider's data; the rest of it (tracking codes) is never selected. */
export type FulfillmentRow = {
  id: string;
  order_id: string;
  created_at: string;
  canceled_at: string | null;
  delivered_at: string | null;
  updated_at: string;
  cost_thb: unknown;
  is_replacement: boolean;
};

export type FulfillmentLineRow = {
  fulfillment_id: string;
  line_item_id: string | null;
  sku: string | null;
  quantity: unknown;
};

export type FulfillmentRecord = {
  id: string;
  order_id: string;
  created_at: string;
  kind: "original" | "replacement";
  quoted_shipping_satang: number | null;
  canceled_at: string | null;
  delivered_at: string | null;
  updated_at: string;
  lines: Array<{ line_item_id: string | null; sku: string | null; quantity: number }>;
};

/** One fulfillment as it crosses, with its own lines (`lines` may hold
 *  other fulfillments' lines; only this one's are taken). */
export function fulfillmentRecord(row: FulfillmentRow, lines: FulfillmentLineRow[]): FulfillmentRecord {
  return named("fulfillment", row?.id, () => ({
    id: String(row.id),
    order_id: String(row.order_id),
    created_at: row.created_at,
    kind: row.is_replacement ? "replacement" : "original",
    quoted_shipping_satang: quotedCost(row.cost_thb),
    canceled_at: row.canceled_at ?? null,
    delivered_at: row.delivered_at ?? null,
    updated_at: row.updated_at,
    lines: lines
      .filter((l) => l.fulfillment_id === row.id)
      .map((l) => ({
        line_item_id: l.line_item_id ?? null,
        sku: l.sku ?? null,
        quantity: field("fulfillment line quantity", () => toWholeNumber(l.quantity)),
      })),
  }));
}

/** The Shippop price at booking, stored by the Shippop adapter since this
 *  feed was built. Absent on older fulfillments and on any not booked
 *  through Shippop. Provider data is not ours to trust, so a value that is
 *  not an amount is "no quoted cost", not a failed page. */
function quotedCost(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    return toSatang(value);
  } catch {
    return null;
  }
}
