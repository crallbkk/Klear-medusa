import {
  FeedValueError,
  allocateSatang,
  formatCursor,
  fulfillmentRecord,
  orderRecord,
  parseCursor,
  parseLimit,
  toSatang,
  toWholeNumber,
} from "../commerce";
import { ORDER_ROW, SECRETS, leakyOrderDetail } from "./fixtures";

/** An exact decimal in the shape `allocateSatang` takes. */
function decimal(text: string): { coef: bigint; exp: number } {
  const [whole, frac = ""] = text.split(".");
  return { coef: BigInt(whole + frac), exp: -frac.length };
}

describe("the feed cursor", () => {
  it("round-trips a timestamp to the microsecond and an id", () => {
    const c = { at: "2026-11-20T03:05:00.654321Z", id: "order_01JABC" };
    expect(parseCursor(formatCursor(c))).toEqual(c);
    expect(formatCursor(c)).toBe("2026-11-20T03:05:00.654321Z|order_01JABC");
  });

  it("means the start when absent or empty", () => {
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor("")).toBeNull();
  });

  it("accepts an empty id, so a run can re-read from a moment", () => {
    expect(parseCursor("2026-11-20T02:55:00.000000Z|")).toEqual({
      at: "2026-11-20T02:55:00.000000Z",
      id: "",
    });
  });

  it("accepts fewer than six fraction digits and none", () => {
    expect(parseCursor("2026-11-20T02:55:00Z|order_1")).toEqual({ at: "2026-11-20T02:55:00Z", id: "order_1" });
    expect(parseCursor("2026-11-20T02:55:00.5Z|x")).toEqual({ at: "2026-11-20T02:55:00.5Z", id: "x" });
  });

  it("refuses anything else", () => {
    for (const raw of [
      "2026-11-20T02:55:00.000000Z",
      "2026-11-20 02:55:00|order_1",
      "2026-13-45T02:55:00Z|order_1",
      "2026-11-20T02:55:00.0000001Z|order_1",
      "2026-11-20T02:55:00Z|order_1'; drop table \"order\"; --",
      "2026-11-20T02:55:00Z|order 1",
      `2026-11-20T02:55:00Z|${"a".repeat(101)}`,
      ["2026-11-20T02:55:00Z|order_1"],
      { at: "x" },
      42,
    ]) {
      expect([raw, parseCursor(raw)]).toEqual([raw, "invalid"]);
    }
  });
});

describe("the page size", () => {
  it("defaults, and stays between 1 and the maximum", () => {
    expect(parseLimit(undefined)).toBe(100);
    expect(parseLimit("10")).toBe(10);
    expect(parseLimit("0")).toBe(1);
    expect(parseLimit("100000")).toBe(500);
    expect(parseLimit("abc")).toBe(100);
    expect(parseLimit(["5"])).toBe(100);
    expect(parseLimit("-3")).toBe(100);
  });
});

describe("money in whole satang", () => {
  it("converts Medusa's major units exactly, without floating point", () => {
    expect(toSatang(1290)).toBe(129000);
    expect(toSatang("1290")).toBe(129000);
    expect(toSatang("0.1")).toBe(10);
    expect(toSatang("0.29")).toBe(29);
    // 0.29 * 100 in floating point is 28.999999999999996.
    expect(toSatang(0.29)).toBe(29);
    expect(toSatang(1.005)).toBe(101);
    expect(toSatang({ numeric: 59.9, raw: { value: "59.9", precision: 20 } })).toBe(5990);
    expect(toSatang({ value: "12.34" })).toBe(1234);
    expect(toSatang("-5.5")).toBe(-550);
    expect(toSatang(0)).toBe(0);
  });

  it("refuses a missing amount rather than read it as zero", () => {
    // A field Medusa did not compute (a misspelt field name) must fail
    // loudly, not cross as a free order.
    expect(() => toSatang(null)).toThrow();
    expect(() => toSatang(undefined)).toThrow();
  });

  it("rounds a fraction of a satang half away from zero", () => {
    expect(toSatang("33.333333333333333333")).toBe(3333);
    expect(toSatang("33.335")).toBe(3334);
    expect(toSatang("33.334999")).toBe(3333);
    expect(toSatang("-33.335")).toBe(-3334);
    expect(toSatang("0.005")).toBe(1);
    expect(toSatang("0.00499")).toBe(0);
  });

  it("reads BigNumber.js-style objects through their exact decimal text", () => {
    const big = { toFixed: () => "100.125" };
    expect(toSatang({ bigNumber: big })).toBe(10013);
    expect(toSatang({ raw: { value: "1e2" } })).toBe(10000);
    expect(toSatang("1.5e1")).toBe(1500);
    expect(toSatang("1E-2")).toBe(1);
  });

  it("refuses what is not an amount", () => {
    for (const bad of ["abc", "1,000", "", NaN, Infinity, "9".repeat(30), { foo: 1 }, true]) {
      expect(() => toSatang(bad)).toThrow();
    }
  });

  it("whole numbers are whole", () => {
    expect(toWholeNumber(2)).toBe(2);
    expect(toWholeNumber("3")).toBe(3);
    expect(toWholeNumber({ numeric: 4, raw: { value: "4" } })).toBe(4);
    expect(() => toWholeNumber("1.5")).toThrow();
    expect(() => toWholeNumber("x")).toThrow();
  });
});

describe("an order record", () => {
  it("carries exactly the contract's fields, from an explicit list", () => {
    const rec = orderRecord(ORDER_ROW, leakyOrderDetail());
    expect(rec).toEqual({
      id: "order_A",
      display_id: 42,
      cart_id: "cart_A",
      placed_at: "2026-11-20T03:00:00.123456Z",
      currency_code: "thb",
      item_total_satang: 149000,
      discount_total_satang: 10000,
      shipping_total_satang: 5000,
      total_satang: 154000,
      canceled_at: null,
      sales_channel_id: "sc_1",
      version: 3,
      updated_at: "2026-11-20T03:05:00.654321Z",
      lines: [
        {
          id: "ordli_1",
          sku: "KLR-F1",
          description: "Klear Frame / Black",
          quantity: 1,
          gross_satang: 100000,
          discount_satang: 10000,
        },
        {
          id: "ordli_2",
          sku: "KLR-LENS-SV167",
          description: "Klear Lenses",
          quantity: 1,
          gross_satang: 59000,
          discount_satang: 0,
        },
      ],
    });
  });

  it("lets none of the values that must not cross through", () => {
    const text = JSON.stringify(orderRecord(ORDER_ROW, leakyOrderDetail()));
    for (const s of SECRETS) expect([s, text.includes(s)]).toEqual([s, false]);
    expect(text).not.toMatch(/metadata|email|address|phone|customer|prescription|tax/i);
  });

  it("has no cart id for an order not made from a cart, and no lines it was not given", () => {
    const detail = { ...leakyOrderDetail(), cart_id: null, items: undefined };
    const rec = orderRecord({ ...ORDER_ROW, canceled_at: "2026-11-21T00:00:00.000000Z" }, detail);
    expect(rec.cart_id).toBeNull();
    expect(rec.lines).toEqual([]);
    expect(rec.canceled_at).toBe("2026-11-21T00:00:00.000000Z");
  });
});

describe("an order as it was placed", () => {
  // The reviewer's numbers: a line of 2 at 1,290 with a 100 discount, one
  // piece received back. Medusa then reports quantity 2, subtotal 1,290 and
  // discount 50 for the line, and shrinks the order's totals with it.
  const afterReturn = () => ({
    id: "order_R",
    cart_id: "cart_R",
    item_total: 1240,
    discount_total: 50,
    shipping_total: 50,
    total: 1290,
    items: [
      {
        id: "ordli_R",
        title: "Klear Frame",
        variant_sku: "KLR-F1",
        quantity: 2,
        unit_price: 1290,
        subtotal: 1290,
        discount_total: 50,
        tax_lines: [],
        adjustments: [{ amount: 100 }],
        detail: { quantity: 2, return_received_quantity: 1, return_dismissed_quantity: 0 },
      },
    ],
    shipping_methods: [{ id: "sm", amount: 50, adjustments: [], tax_lines: [], detail: {} }],
  });
  const ROW_R = { ...ORDER_ROW, id: "order_R" };

  it("serves the full quantity's amounts, not Medusa's return-scaled ones", () => {
    const rec = orderRecord(ROW_R, afterReturn());
    expect(rec.lines).toEqual([
      {
        id: "ordli_R",
        sku: "KLR-F1",
        description: "Klear Frame",
        quantity: 2,
        gross_satang: 258000,
        discount_satang: 10000,
      },
    ]);
    expect(rec).toMatchObject({
      item_total_satang: 248000,
      discount_total_satang: 10000,
      shipping_total_satang: 5000,
      total_satang: 253000,
    });
  });

  it("is the same before and after the return", () => {
    const before = afterReturn();
    before.items[0].detail.return_received_quantity = 0;
    Object.assign(before, { item_total: 2480, discount_total: 100, total: 2530 });
    Object.assign(before.items[0], { subtotal: 2580, discount_total: 100 });
    expect(JSON.stringify(orderRecord(ROW_R, before))).toBe(JSON.stringify(orderRecord(ROW_R, afterReturn())));
  });

  it("rounds each family of figures once, on its exact sum, and shares the satang out to the lines", () => {
    const detail = afterReturn();
    detail.items = [
      { ...detail.items[0], id: "l1", quantity: 3, unit_price: 33.333, adjustments: [{ amount: 3.335 }] },
      { ...detail.items[0], id: "l2", quantity: 1, unit_price: 10.005, adjustments: [{ amount: 0.004 }, { amount: 0.004 }] },
    ] as typeof detail.items;
    const rec = orderRecord(ROW_R, detail);
    // Gross 99.999 + 10.005 = 110.004 -> 11000 satang; floors 9999 + 1000,
    // the satang owed goes to the larger remainder (0.9 > 0.5).
    // Discounts 3.335 + 0.008 = 3.343 -> 334; floors 333 + 0, the one
    // owed goes to the larger remainder (0.8 > 0.5).
    expect(rec.lines.map((l) => [l.gross_satang, l.discount_satang])).toEqual([
      [10000, 333],
      [1000, 1],
    ]);
    expect(rec.item_total_satang).toBe(11000 - 334);
    expect(rec.discount_total_satang).toBe(334);
    expect(rec.total_satang).toBe(rec.item_total_satang + rec.shipping_total_satang);
  });

  it("the reviewer's case: 100 THB off across three 100 THB lines is 100 THB, not 99.99", () => {
    const detail = afterReturn();
    const third = "33.333333333333333333";
    detail.items = ["l_c", "l_a", "l_b"].map((id) => ({
      ...detail.items[0],
      id,
      quantity: 1,
      unit_price: 100,
      adjustments: [{ amount: third }],
    })) as unknown as typeof detail.items;
    detail.shipping_methods = [];
    const rec = orderRecord(ROW_R, detail);
    expect(rec.discount_total_satang).toBe(10000);
    expect(rec.item_total_satang).toBe(20000);
    expect(rec.total_satang).toBe(20000);
    // Equal remainders: the extra satang goes by line id, whatever the order.
    expect(rec.lines.map((l) => [l.id, l.discount_satang])).toEqual([
      ["l_c", 3333],
      ["l_a", 3334],
      ["l_b", 3333],
    ]);
  });

  it("always has lines adding up to the totals, each within a satang of exact (thirds and sevenths)", () => {
    // A fixed pseudo-random sequence, so a failure can be replayed.
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647);
    for (let run = 0; run < 300; run++) {
      const n = 1 + (next() % 6);
      const values = Array.from({ length: n }, (_, i) => {
        const whole = next() % 5000;
        const den = [3, 7, 9, 21][next() % 4];
        const num = next() % den;
        // whole + num/den baht, written to 20 decimals as Medusa does.
        const frac = ((BigInt(num) * BigInt(10) ** BigInt(20)) / BigInt(den)).toString().padStart(20, "0");
        return { key: `k${String(next() % 1000).padStart(3, "0")}_${i}`, text: `${whole}.${frac}` };
      });
      const shares = allocateSatang(values.map((v) => ({ key: v.key, amount: decimal(v.text) })));
      const exactSum = values.reduce((acc, v) => acc + Number(v.text), 0);
      const total = [...shares.values()].reduce((a, b) => a + b, 0);
      expect(Math.abs(total - exactSum * 100)).toBeLessThanOrEqual(0.5000001);
      for (const v of values) {
        expect(Math.abs(shares.get(v.key)! - Number(v.text) * 100)).toBeLessThan(1);
      }
      const detail = afterReturn();
      detail.items = values.map((v) => ({
        ...detail.items[0],
        id: v.key,
        quantity: 1,
        unit_price: 6000,
        adjustments: [{ amount: v.text }],
      })) as unknown as typeof detail.items;
      const rec = orderRecord(ROW_R, detail);
      expect(rec.lines.reduce((a, l) => a + l.discount_satang, 0)).toBe(total);
      expect(rec.item_total_satang).toBe(rec.lines.reduce((a, l) => a + l.gross_satang - l.discount_satang, 0));
      expect(rec.total_satang).toBe(rec.item_total_satang + rec.shipping_total_satang);
      expect(rec.discount_total_satang).toBe(total);
    }
  });

  it("takes the shipping discount off shipping and counts it in the discount total", () => {
    const detail = afterReturn();
    detail.shipping_methods = [{ id: "sm", amount: 50, adjustments: [{ amount: 20 }] as never[], tax_lines: [], detail: {} }];
    const rec = orderRecord(ROW_R, detail);
    expect(rec.shipping_total_satang).toBe(3000);
    expect(rec.discount_total_satang).toBe(12000);
    expect(rec.total_satang).toBe(248000 + 3000);
  });

  it("shares a shipping discount out across more than one method exactly", () => {
    const detail = afterReturn();
    detail.shipping_methods = [
      { id: "s1", amount: 25, adjustments: [{ amount: "3.333333333333333333" }] as never[], tax_lines: [], detail: {} },
      { id: "s2", amount: 25, adjustments: [{ amount: "6.666666666666666667" }] as never[], tax_lines: [], detail: {} },
    ];
    const rec = orderRecord(ROW_R, detail);
    expect(rec.shipping_total_satang).toBe(4000);
    expect(rec.discount_total_satang).toBe(10000 + 1000);
  });

  it("refuses only tax on top of a price, which the figures would leave out", () => {
    const onLine = afterReturn();
    onLine.items[0].tax_lines = [{ rate: 7 }] as never[];
    expect(() => orderRecord(ROW_R, onLine)).toThrow(FeedValueError);
    const onShipping = afterReturn();
    onShipping.shipping_methods[0].tax_lines = [{ rate: "7" }] as never[];
    expect(() => orderRecord(ROW_R, onShipping)).toThrow(FeedValueError);
    // A zero rate, tax-inclusive or not, changes nothing and is served.
    const zero = afterReturn();
    Object.assign(zero.items[0], { is_tax_inclusive: false, tax_lines: [{ rate: 0 }] });
    expect(orderRecord(ROW_R, zero).item_total_satang).toBe(248000);
  });

  it("serves a tax-inclusive line at what the customer paid, whatever the rate", () => {
    // Orders from before 2026-10-11 can carry a 7 % inclusive tax line.
    const old = afterReturn();
    Object.assign(old.items[0], { is_tax_inclusive: true, tax_lines: [{ rate: 7 }] });
    Object.assign(old.shipping_methods[0], { is_tax_inclusive: true, tax_lines: [{ rate: 7 }] });
    // The line's adjustment of 100 is not tax-inclusive: Medusa adds the 7 %
    // to it, so the customer paid 107 less.
    const rec = orderRecord(ROW_R, old);
    expect(rec.lines[0]).toMatchObject({ gross_satang: 258000, discount_satang: 10700 });
    expect(rec).toMatchObject({ item_total_satang: 247300, shipping_total_satang: 5000, total_satang: 252300 });
    // A tax-inclusive adjustment is taken as it is.
    (old.items[0].adjustments as Array<Record<string, unknown>>)[0].is_tax_inclusive = true;
    expect(orderRecord(ROW_R, old).lines[0].discount_satang).toBe(10000);
  });
});

describe("a record that cannot be served", () => {
  it("names the record by its Medusa id, and nothing else of it", () => {
    const detail = leakyOrderDetail();
    (detail.items[0] as Record<string, unknown>).quantity = 1.5;
    let err: unknown;
    try {
      orderRecord(ORDER_ROW, detail);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FeedValueError);
    expect((err as FeedValueError).record_id).toBe("order_A");
    expect((err as Error).message).toContain("order_A");
    for (const s of SECRETS) expect((err as Error).message).not.toContain(s);
    expect((err as Error).message).not.toContain("1.5");
  });

  it("names a fulfillment the same way", () => {
    let err: unknown;
    try {
      fulfillmentRecord(
        { id: "ful_9", order_id: "order_A", created_at: "x", canceled_at: null, delivered_at: null, updated_at: "x", cost_thb: null, is_replacement: false },
        [{ fulfillment_id: "ful_9", line_item_id: "l", sku: "S", quantity: "2.5" }],
      );
    } catch (e) {
      err = e;
    }
    expect((err as FeedValueError).record_id).toBe("ful_9");
    expect((err as Error).message).not.toContain("2.5");
  });
});

describe("a fulfillment record", () => {
  const ROW = {
    id: "ful_1",
    order_id: "order_A",
    created_at: "2026-11-21T01:00:00.000001Z",
    canceled_at: null,
    delivered_at: "2026-11-23T01:00:00.000000Z",
    updated_at: "2026-11-23T01:00:00.000000Z",
    cost_thb: "45.5",
    is_replacement: false,
    // What the table also holds, and must stay behind.
    data: { shippop_tracking_code: "SECRET-TRACKING-SP999", courier_tracking_code: "SECRET-COURIER-TH999" },
    metadata: { x: "SECRET-ORDER-META" },
    delivery_address_id: "fuladdr_1",
  };
  const LINES = [
    { fulfillment_id: "ful_1", line_item_id: "ordli_1", sku: "KLR-F1", quantity: "1", title: "Secretsurname" },
  ];

  it("carries exactly the contract's fields", () => {
    expect(fulfillmentRecord(ROW, LINES)).toEqual({
      id: "ful_1",
      order_id: "order_A",
      created_at: "2026-11-21T01:00:00.000001Z",
      kind: "original",
      quoted_shipping_satang: 4550,
      canceled_at: null,
      delivered_at: "2026-11-23T01:00:00.000000Z",
      updated_at: "2026-11-23T01:00:00.000000Z",
      lines: [{ line_item_id: "ordli_1", sku: "KLR-F1", quantity: 1 }],
    });
    const text = JSON.stringify(fulfillmentRecord(ROW, LINES));
    for (const s of SECRETS) expect([s, text.includes(s)]).toEqual([s, false]);
  });

  it("is a replacement when it ships a claim's or an exchange's new item", () => {
    expect(fulfillmentRecord({ ...ROW, is_replacement: true }, LINES).kind).toBe("replacement");
  });

  it("has no quoted cost when the booking stored none, or stored something that is not an amount", () => {
    for (const cost_thb of [null, undefined, "", "abc"]) {
      expect(fulfillmentRecord({ ...ROW, cost_thb }, LINES).quoted_shipping_satang).toBeNull();
    }
  });
});
