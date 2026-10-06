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
 */

/** Days after delivery before the prescription is blanked. Covers the 30-day
 *  fit guarantee (a remake inside it reads the snapshot) with room to spare. */
export const RX_REDACT_AFTER_DELIVERY_DAYS = 60;

/** Backstop: blank the prescription this long after the job was created,
 *  whatever state it is in. Matches the two-year life of the encrypted
 *  record, so no readable copy outlives the one the policy describes. */
export const RX_REDACT_MAX_AGE_DAYS = 730;

const DAY_MS = 24 * 60 * 60 * 1000;

export type RxRedactionReason = "cancelled" | "delivered" | "max_age";

export interface RxRetentionJob {
  status: string;
  created_at: Date | string;
  rx_redacted_at?: Date | string | null;
}

/**
 * The reason this job's prescription should be blanked now, or null to keep it.
 *
 *   cancelled — the order will not be made; nothing needs the prescription
 *   delivered — delivered at least RX_REDACT_AFTER_DELIVERY_DAYS ago
 *   max_age   — created at least RX_REDACT_MAX_AGE_DAYS ago
 *
 * Never while `submitting`: that is the moment the packet is being read for
 * the lab. An unreadable date keeps the prescription (fail closed on the
 * side of not destroying what a live job may still need; the backstop is
 * re-evaluated on every run).
 */
export function rxRedactionReason(
  job: RxRetentionJob,
  deliveredAt: Date | null,
  now: Date,
): RxRedactionReason | null {
  if (job.rx_redacted_at) return null;
  if (job.status === "submitting") return null;
  if (job.status === "cancelled") return "cancelled";

  const nowMs = now.getTime();
  if (deliveredAt) {
    const deliveredMs = deliveredAt.getTime();
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
 * them, so the retention clock starts when the customer has everything.
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
