/**
 * When may the readable prescription in `lab_job.packet_snapshot` be blanked?
 *
 * The snapshot holds the prescription in plain form because the lab needs it
 * to cut the lenses. The canonical copy (Supabase `prescriptions`) is
 * encrypted and deleted after two years; this copy had no end of life at all.
 * It is only needed while the job can still be made or remade, so it is
 * blanked as soon as that is over. A later remake does not need it: the
 * retry path rebuilds the packet from the encrypted record.
 *
 * Pure. No I/O. The `redact-lab-job-rx` scheduled job applies it.
 *
 * What this does NOT guarantee: that the snapshot never outlives the
 * encrypted record. The clock here runs from the job and the order, not from
 * the prescription. A prescription saved long before the order, or erased at
 * the customer's request, can be gone from Supabase while an undelivered
 * job's snapshot still has up to RX_REDACT_MAX_AGE_DAYS to run.
 */

/** Days after delivery before the prescription is blanked. Covers the 30-day
 *  fit guarantee (a remake inside it reads the snapshot) with room to spare. */
export const RX_REDACT_AFTER_DELIVERY_DAYS = 60;

/** Backstop: blank the prescription this long after the job was created,
 *  whatever became of the order. Delivery is promised in 5 to 7 days, so a
 *  job this old with no delivery on record is finished, lost in tracking, or
 *  abandoned. If it turns out to be live, the retry path restores the
 *  prescription from the encrypted record. */
export const RX_REDACT_MAX_AGE_DAYS = 180;

/** A job in `submitting` is being read for the lab right now and is left
 *  alone, but only for this long. `submitting` is meant to last seconds; a
 *  row still in it after a day was orphaned by a crash and must not keep its
 *  prescription for good. */
export const RX_SUBMITTING_GRACE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export type RxRedactionReason = "cancelled" | "delivered" | "max_age";

export interface RxRetentionJob {
  status: string;
  created_at: Date | string;
  updated_at?: Date | string | null;
  rx_redacted_at?: Date | string | null;
}

/** What the order says, as far as retention cares. */
export interface RxRetentionOrderFacts {
  /** When the whole order was delivered; null if it has not been. */
  deliveredAt: Date | null;
  /** The Medusa order was cancelled. */
  cancelled: boolean;
}

export const NO_ORDER_FACTS: RxRetentionOrderFacts = {
  deliveredAt: null,
  cancelled: false,
};

/**
 * Is this job mid-submission right now? True for `submitting` unless the row
 * has sat there past the grace period. A `submitting` row whose `updated_at`
 * cannot be read counts as in flight: never blank what may be on its way to
 * the lab.
 */
export function isSubmissionInFlight(job: RxRetentionJob, now: Date): boolean {
  if (job.status !== "submitting") return false;
  if (!job.updated_at) return true;
  const updatedMs = new Date(job.updated_at).getTime();
  if (!Number.isFinite(updatedMs)) return true;
  return now.getTime() - updatedMs < RX_SUBMITTING_GRACE_HOURS * HOUR_MS;
}

/**
 * The reason this job's prescription should be blanked now, or null to keep it.
 *
 *   cancelled — the lab job or the order was cancelled; it will not be made
 *   delivered — delivered at least RX_REDACT_AFTER_DELIVERY_DAYS ago
 *   max_age   — created at least RX_REDACT_MAX_AGE_DAYS ago
 *
 * Never while a submission is in flight. An unreadable date keeps the
 * prescription (the rule is re-evaluated on every run).
 */
export function rxRedactionReason(
  job: RxRetentionJob,
  order: RxRetentionOrderFacts,
  now: Date,
): RxRedactionReason | null {
  if (job.rx_redacted_at) return null;
  if (isSubmissionInFlight(job, now)) return null;
  // Nothing in the backend moves a lab job to `cancelled` yet, so the order's
  // own cancellation is the signal that actually fires.
  if (job.status === "cancelled" || order.cancelled) return "cancelled";

  const nowMs = now.getTime();
  if (order.deliveredAt) {
    const deliveredMs = order.deliveredAt.getTime();
    if (
      Number.isFinite(deliveredMs) &&
      nowMs - deliveredMs >= RX_REDACT_AFTER_DELIVERY_DAYS * DAY_MS
    ) {
      return "delivered";
    }
  }

  const createdMs = new Date(job.created_at).getTime();
  if (
    Number.isFinite(createdMs) &&
    nowMs - createdMs >= RX_REDACT_MAX_AGE_DAYS * DAY_MS
  ) {
    return "max_age";
  }
  return null;
}

export interface FulfillmentDeliveryRow {
  delivered_at?: Date | string | null;
  canceled_at?: Date | string | null;
}

/**
 * When the whole order was delivered, or null if any part of it has not been.
 *
 * Cancelled fulfillments are ignored (a re-shipped parcel leaves one behind).
 * Every remaining fulfillment must be delivered; the answer is the LATEST of
 * them. This sees fulfillments that exist: an order shipped in parts, with a
 * part not yet created as a fulfillment, would read as delivered once the
 * existing parts arrive. An order is one pair today, sent as one parcel.
 */
export function orderDeliveredAt(
  fulfillments: ReadonlyArray<FulfillmentDeliveryRow> | null | undefined,
): Date | null {
  const live = (fulfillments ?? []).filter((f) => f && !f.canceled_at);
  if (live.length === 0) return null;
  let latest = 0;
  for (const f of live) {
    if (!f.delivered_at) return null;
    const ms = new Date(f.delivered_at).getTime();
    if (!Number.isFinite(ms)) return null;
    if (ms > latest) latest = ms;
  }
  return new Date(latest);
}

export interface OrderRetentionRow {
  canceled_at?: Date | string | null;
  fulfillments?: FulfillmentDeliveryRow[] | null;
}

/** Reduce an order row to the two facts the rule reads. */
export function orderRetentionFacts(order: OrderRetentionRow): RxRetentionOrderFacts {
  return {
    deliveredAt: orderDeliveredAt(order.fulfillments),
    cancelled: Boolean(order.canceled_at),
  };
}
