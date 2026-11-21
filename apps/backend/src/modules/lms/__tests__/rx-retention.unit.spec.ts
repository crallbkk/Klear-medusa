import {
  NO_ORDER_FACTS,
  RX_REDACT_AFTER_DELIVERY_DAYS,
  RX_REDACT_MAX_AGE_DAYS,
  RX_SUBMITTING_GRACE_HOURS,
  isSubmissionInFlight,
  orderDeliveredAt,
  orderRetentionFacts,
  rxRedactionReason,
} from "../rx-retention";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-10-06T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * HOUR);

const job = (over: Partial<Parameters<typeof rxRedactionReason>[0]> = {}) => ({
  status: "queued",
  created_at: daysAgo(10),
  updated_at: daysAgo(10),
  rx_redacted_at: null,
  ...over,
});
const delivered = (at: Date) => ({ deliveredAt: at, cancelled: false });
const CANCELLED_ORDER = { deliveredAt: null, cancelled: true };

describe("rxRedactionReason — when the readable prescription is blanked", () => {
  it("keeps the prescription on a live, undelivered job", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx"]) {
      expect(rxRedactionReason(job({ status }), NO_ORDER_FACTS, NOW)).toBeNull();
    }
  });

  it("blanks a cancelled lab job straight away, however new", () => {
    expect(
      rxRedactionReason(job({ status: "cancelled", created_at: NOW }), NO_ORDER_FACTS, NOW),
    ).toBe("cancelled");
  });

  it("blanks when the ORDER was cancelled, whatever the lab job says (nothing moves a lab job to cancelled yet)", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx"]) {
      expect(
        rxRedactionReason(job({ status, created_at: NOW }), CANCELLED_ORDER, NOW),
      ).toBe("cancelled");
    }
  });

  it("keeps it through the window after delivery and blanks on the day it ends", () => {
    const j = job();
    expect(
      rxRedactionReason(j, delivered(daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS - 1)), NOW),
    ).toBeNull();
    expect(
      rxRedactionReason(j, delivered(daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS)), NOW),
    ).toBe("delivered");
    // The window must outlast the 30-day fit guarantee, or a remake inside
    // it would find no prescription.
    expect(RX_REDACT_AFTER_DELIVERY_DAYS).toBeGreaterThan(30);
  });

  it("blanks a delivered order whatever the job's status (no lab provider is wired, so jobs stay queued)", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx"]) {
      expect(rxRedactionReason(job({ status }), delivered(daysAgo(90)), NOW)).toBe("delivered");
    }
  });

  it("blanks anything past the age limit, delivered or not", () => {
    expect(
      rxRedactionReason(
        job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS - 1) }),
        NO_ORDER_FACTS,
        NOW,
      ),
    ).toBeNull();
    expect(
      rxRedactionReason(
        job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS) }),
        NO_ORDER_FACTS,
        NOW,
      ),
    ).toBe("max_age");
    expect(
      rxRedactionReason(
        job({ status: "pending_rx", created_at: daysAgo(900) }),
        NO_ORDER_FACTS,
        NOW,
      ),
    ).toBe("max_age");
  });

  it("the age limit is longer than the delivery window and far shorter than the encrypted record's two years", () => {
    expect(RX_REDACT_MAX_AGE_DAYS).toBeGreaterThan(RX_REDACT_AFTER_DELIVERY_DAYS);
    expect(RX_REDACT_MAX_AGE_DAYS).toBeLessThan(730);
  });

  it("never touches a job that went into submission recently, even past every window", () => {
    expect(
      rxRedactionReason(
        job({ status: "submitting", created_at: daysAgo(900), updated_at: hoursAgo(1) }),
        { deliveredAt: daysAgo(400), cancelled: true },
        NOW,
      ),
    ).toBeNull();
  });

  it("a job ORPHANED in submitting (a crash mid-submit) is not exempt for good", () => {
    const orphan = job({
      status: "submitting",
      created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1),
      updated_at: hoursAgo(RX_SUBMITTING_GRACE_HOURS + 1),
    });
    expect(rxRedactionReason(orphan, NO_ORDER_FACTS, NOW)).toBe("max_age");
    expect(rxRedactionReason(orphan, CANCELLED_ORDER, NOW)).toBe("cancelled");
  });

  it("does nothing for a job already blanked", () => {
    expect(
      rxRedactionReason(
        job({ status: "cancelled", rx_redacted_at: daysAgo(1) }),
        delivered(daysAgo(400)),
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps the prescription when a date cannot be read", () => {
    expect(
      rxRedactionReason(job({ created_at: "not a date" }), delivered(new Date("nope")), NOW),
    ).toBeNull();
  });

  it("accepts ISO strings as well as Date objects", () => {
    expect(
      rxRedactionReason(
        job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1).toISOString() }),
        NO_ORDER_FACTS,
        NOW,
      ),
    ).toBe("max_age");
  });
});

describe("isSubmissionInFlight", () => {
  it("is false for every status but submitting", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx", "cancelled"]) {
      expect(isSubmissionInFlight(job({ status, updated_at: NOW }), NOW)).toBe(false);
    }
  });

  it("is true inside the grace period and false once it has passed", () => {
    const at = (h: number) => job({ status: "submitting", updated_at: hoursAgo(h) });
    expect(isSubmissionInFlight(at(0), NOW)).toBe(true);
    expect(isSubmissionInFlight(at(RX_SUBMITTING_GRACE_HOURS - 1), NOW)).toBe(true);
    expect(isSubmissionInFlight(at(RX_SUBMITTING_GRACE_HOURS), NOW)).toBe(false);
  });

  it("treats a submitting row with no readable updated_at as in flight", () => {
    expect(isSubmissionInFlight(job({ status: "submitting", updated_at: null }), NOW)).toBe(true);
    expect(isSubmissionInFlight(job({ status: "submitting", updated_at: "x" }), NOW)).toBe(true);
  });
});

describe("orderDeliveredAt", () => {
  it("is null with no fulfillments, or none that are live", () => {
    expect(orderDeliveredAt(null)).toBeNull();
    expect(orderDeliveredAt([])).toBeNull();
    expect(
      orderDeliveredAt([{ delivered_at: daysAgo(5), canceled_at: daysAgo(6) }]),
    ).toBeNull();
  });

  it("is null while any live fulfillment is undelivered", () => {
    expect(
      orderDeliveredAt([{ delivered_at: daysAgo(70) }, { delivered_at: null }]),
    ).toBeNull();
  });

  it("is the LATEST delivery when everything has arrived", () => {
    const at = orderDeliveredAt([
      { delivered_at: daysAgo(70).toISOString() },
      { delivered_at: daysAgo(20) },
    ]);
    expect(at?.getTime()).toBe(daysAgo(20).getTime());
  });

  it("ignores a cancelled fulfillment left behind by a re-ship", () => {
    const at = orderDeliveredAt([
      { delivered_at: null, canceled_at: daysAgo(80) },
      { delivered_at: daysAgo(65) },
    ]);
    expect(at?.getTime()).toBe(daysAgo(65).getTime());
  });

  it("is null when a delivery date cannot be read", () => {
    expect(orderDeliveredAt([{ delivered_at: "garbage" }])).toBeNull();
  });
});

describe("orderRetentionFacts", () => {
  it("reads cancellation from the order and delivery from its fulfillments", () => {
    expect(orderRetentionFacts({ canceled_at: null, fulfillments: [] })).toEqual(NO_ORDER_FACTS);
    expect(orderRetentionFacts({ canceled_at: daysAgo(1), fulfillments: null })).toEqual({
      deliveredAt: null,
      cancelled: true,
    });
    const facts = orderRetentionFacts({ fulfillments: [{ delivered_at: daysAgo(3) }] });
    expect(facts.cancelled).toBe(false);
    expect(facts.deliveredAt?.getTime()).toBe(daysAgo(3).getTime());
  });
});

describe("rxRedactionReason: a prescription put back for a warranty remake", () => {
  // The writer stamps `rx_restored_at` when it puts a prescription back to
  // start a warranty remake. Nothing else sets it: not a QC remake, not a
  // rebuild, not a stage move.
  const longAgo = delivered(daysAgo(200));
  const restored = (days: number, over: object = {}) =>
    job({
      created_at: daysAgo(400),
      rx_restored_at: daysAgo(days),
      stage: "printed",
      stage_since: daysAgo(days),
      ...over,
    });

  it("keeps it while the remake is made, whatever the order and the job's age say", () => {
    // By the order alone (delivered 200 days ago) and by age alone (400
    // days) this job would be blanked tonight.
    expect(rxRedactionReason(restored(1), longAgo, NOW)).toBeNull();
    // Also when the order has no delivery on record, or cannot be read.
    expect(rxRedactionReason(restored(1), NO_ORDER_FACTS, NOW)).toBeNull();
    for (const stage of ["ready", "printed", "edged", "qc_failed", "packed", "labelled"]) {
      expect([stage, rxRedactionReason(restored(5, { stage }), longAgo, NOW)]).toEqual([stage, null]);
    }
  });

  it("gives up 60 days after it was put back, however often the job has moved since", () => {
    const moved = { stage_since: daysAgo(1) };
    expect(rxRedactionReason(restored(RX_REDACT_AFTER_DELIVERY_DAYS - 1, moved), longAgo, NOW)).toBeNull();
    expect(rxRedactionReason(restored(RX_REDACT_AFTER_DELIVERY_DAYS, moved), longAgo, NOW)).toBe("delivered");
    expect(rxRedactionReason(restored(RX_REDACT_AFTER_DELIVERY_DAYS, moved), NO_ORDER_FACTS, NOW)).toBe(
      "delivered",
    );
  });

  it("counts 60 days from the remake's own delivery once it is delivered again", () => {
    const again = (deliveredDays: number) =>
      restored(100, { stage: "delivered", stage_since: daysAgo(deliveredDays) });
    expect(rxRedactionReason(again(RX_REDACT_AFTER_DELIVERY_DAYS - 1), longAgo, NOW)).toBeNull();
    expect(rxRedactionReason(again(RX_REDACT_AFTER_DELIVERY_DAYS), longAgo, NOW)).toBe("delivered");
    expect(rxRedactionReason(again(RX_REDACT_AFTER_DELIVERY_DAYS), NO_ORDER_FACTS, NOW)).toBe("delivered");
  });

  it("still blanks a cancelled job or order at once", () => {
    expect(rxRedactionReason(restored(1, { status: "cancelled" }), longAgo, NOW)).toBe("cancelled");
    expect(rxRedactionReason(restored(1), { deliveredAt: null, cancelled: true }, NOW)).toBe("cancelled");
    // A remake cancelled in the lab: back to the ordinary rules.
    expect(rxRedactionReason(restored(1, { stage: "cancelled" }), longAgo, NOW)).toBe("delivered");
  });

  it("falls back to the ordinary rules when the stamp cannot be read", () => {
    expect(rxRedactionReason(restored(1, { rx_restored_at: "nonsense" }), longAgo, NOW)).toBe("delivered");
  });

  it("changes nothing for a job that was never restored, remade at QC or not", () => {
    // What the rule said before production fields existed, for the same job.
    const plain = (over: object) => job({ created_at: daysAgo(10), ...over });
    const cases: Array<[object, ReturnType<typeof delivered> | typeof NO_ORDER_FACTS]> = [
      // QC-remade, stage never moved on, order delivered since.
      [{ remake_count: 1, stage: "qc_passed", stage_since: daysAgo(110) }, delivered(daysAgo(100))],
      // QC-remade, paper-log steps entered after delivery.
      [{ remake_count: 1, stage: "packed", stage_since: daysAgo(10) }, delivered(daysAgo(70))],
      // QC-remade, delivered once, old.
      [{ remake_count: 2, stage: "delivered", stage_since: daysAgo(15), created_at: daysAgo(185) }, NO_ORDER_FACTS],
      // QC-remade, delivery event recorded late.
      [{ remake_count: 1, stage: "delivered", stage_since: daysAgo(30) }, delivered(daysAgo(100))],
      // Never delivered, moved yesterday, very old.
      [{ remake_count: 1, stage: "edged", stage_since: daysAgo(1), created_at: daysAgo(400) }, NO_ORDER_FACTS],
      // Young and undelivered.
      [{ remake_count: 1, stage: "edged", stage_since: daysAgo(1) }, NO_ORDER_FACTS],
    ];
    for (const [fields, order] of cases) {
      const withProduction = rxRedactionReason(plain(fields), order, NOW);
      const { stage: _s, stage_since: _ss, remake_count: _r, ...bare } = plain(fields) as Record<string, unknown>;
      const before = rxRedactionReason(bare as never, order, NOW);
      expect([JSON.stringify(fields), withProduction]).toEqual([JSON.stringify(fields), before]);
    }
  });
});
