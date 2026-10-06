import {
  RX_REDACT_AFTER_DELIVERY_DAYS,
  RX_REDACT_MAX_AGE_DAYS,
  orderDeliveredAt,
  rxRedactionReason,
} from "../rx-retention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-06T00:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const job = (over: Partial<Parameters<typeof rxRedactionReason>[0]> = {}) => ({
  status: "queued",
  created_at: daysAgo(10),
  rx_redacted_at: null,
  ...over,
});

describe("rxRedactionReason — when the readable prescription is blanked", () => {
  it("keeps the prescription on a live, undelivered job", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx"]) {
      expect(rxRedactionReason(job({ status }), null, NOW)).toBeNull();
    }
  });

  it("blanks a cancelled job straight away, however new", () => {
    expect(
      rxRedactionReason(job({ status: "cancelled", created_at: NOW }), null, NOW),
    ).toBe("cancelled");
  });

  it("keeps it through the window after delivery and blanks on the day it ends", () => {
    const j = job();
    expect(
      rxRedactionReason(j, daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS - 1), NOW),
    ).toBeNull();
    expect(
      rxRedactionReason(j, daysAgo(RX_REDACT_AFTER_DELIVERY_DAYS), NOW),
    ).toBe("delivered");
    // The window must outlast the 30-day fit guarantee, or a remake inside
    // it would find no prescription.
    expect(RX_REDACT_AFTER_DELIVERY_DAYS).toBeGreaterThan(30);
  });

  it("blanks a delivered order whatever the job's status (nothing is wired to the lab yet, so jobs stay queued)", () => {
    for (const status of ["queued", "submitted", "failed", "pending_rx"]) {
      expect(rxRedactionReason(job({ status }), daysAgo(90), NOW)).toBe("delivered");
    }
  });

  it("blanks anything two years old, delivered or not", () => {
    expect(
      rxRedactionReason(job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS - 1) }), null, NOW),
    ).toBeNull();
    expect(
      rxRedactionReason(job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS) }), null, NOW),
    ).toBe("max_age");
    expect(
      rxRedactionReason(
        job({ status: "pending_rx", created_at: daysAgo(900) }),
        null,
        NOW,
      ),
    ).toBe("max_age");
  });

  it("never touches a job mid-submission, even past every window", () => {
    expect(
      rxRedactionReason(
        job({ status: "submitting", created_at: daysAgo(900) }),
        daysAgo(400),
        NOW,
      ),
    ).toBeNull();
  });

  it("does nothing for a job already blanked", () => {
    expect(
      rxRedactionReason(
        job({ status: "cancelled", rx_redacted_at: daysAgo(1) }),
        daysAgo(400),
        NOW,
      ),
    ).toBeNull();
  });

  it("keeps the prescription when a date cannot be read", () => {
    expect(
      rxRedactionReason(job({ created_at: "not a date" }), new Date("nope"), NOW),
    ).toBeNull();
  });

  it("accepts ISO strings as well as Date objects", () => {
    expect(
      rxRedactionReason(
        job({ created_at: daysAgo(RX_REDACT_MAX_AGE_DAYS + 1).toISOString() }),
        null,
        NOW,
      ),
    ).toBe("max_age");
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
