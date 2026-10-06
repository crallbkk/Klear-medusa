import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { LMS_MODULE } from "../modules/lms/service";
import type LmsModuleService from "../modules/lms/service";
import {
  orderDeliveredAt,
  rxRedactionReason,
  type FulfillmentDeliveryRow,
  type RxRedactionReason,
} from "../modules/lms/rx-retention";
import { captureException } from "../lib/observability/sentry";

/**
 * Scheduled sweep — blank the readable prescription kept on finished lab jobs.
 *
 * `lab_job.packet_snapshot` holds the prescription in plain form because the
 * lab needs it. Nothing used to remove it, while the canonical record in
 * Supabase is encrypted and deleted after two years. This job blanks the
 * snapshot's `prescription` (and stamps `rx_redacted_at`) once the job no
 * longer needs it: the order was cancelled, it was delivered
 * RX_REDACT_AFTER_DELIVERY_DAYS ago, or the job is two years old. The rules
 * are in `modules/lms/rx-retention.ts`.
 *
 * Only the prescription is blanked. The rest of the snapshot (frame, lens,
 * delivery address) stays for the audit trail; the same customer details
 * live on the Medusa order.
 *
 * PDPA: this job never reads, logs or reports a prescription value. It reads
 * ids, status and dates, and the service does the blanking.
 *
 * Idempotent. One order's failure never stops the rest.
 */

interface OrderGraphRow {
  id: string;
  fulfillments?: FulfillmentDeliveryRow[] | null;
}

const ORDER_BATCH = 100;

/** Delivery date per order id. An order missing from the map has no known
 *  delivery (not delivered yet, or the lookup failed for its batch). */
async function loadDeliveredAt(
  container: MedusaContainer,
  orderIds: string[],
): Promise<{ deliveredAt: Map<string, Date>; failedBatches: number }> {
  const deliveredAt = new Map<string, Date>();
  let failedBatches = 0;
  const query = container.resolve(ContainerRegistrationKeys.QUERY);

  for (let i = 0; i < orderIds.length; i += ORDER_BATCH) {
    const batch = orderIds.slice(i, i + ORDER_BATCH);
    try {
      const { data } = await query.graph({
        entity: "order",
        fields: ["id", "fulfillments.delivered_at", "fulfillments.canceled_at"],
        filters: { id: batch },
      });
      for (const row of (data ?? []) as OrderGraphRow[]) {
        const at = orderDeliveredAt(row.fulfillments);
        if (at) deliveredAt.set(row.id, at);
      }
    } catch (err) {
      // Without delivery dates this batch falls back to the cancelled and
      // two-year rules only. Nothing is blanked early; it is retried on the
      // next run.
      failedBatches++;
      console.error(
        `[redact-lab-job-rx] order delivery lookup failed for a batch of ${batch.length}: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      captureException(err, {
        tags: { job: "redact-lab-job-rx", reason: "order_query_failed" },
        extra: { batch_size: batch.length },
      });
    }
  }
  return { deliveredAt, failedBatches };
}

export default async function redactLabJobRxJob(
  container: MedusaContainer,
): Promise<void> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;

  const candidates = await lms.listJobsHoldingRx();
  if (candidates.length === 0) return;

  const orderIds = Array.from(new Set(candidates.map((j) => j.order_id)));
  const { deliveredAt, failedBatches } = await loadDeliveredAt(container, orderIds);

  const now = new Date();
  const counts: Record<RxRedactionReason, number> = {
    cancelled: 0,
    delivered: 0,
    max_age: 0,
  };
  let kept = 0;
  let raced = 0;
  let errored = 0;

  for (const job of candidates) {
    const reason = rxRedactionReason(job, deliveredAt.get(job.order_id) ?? null, now);
    if (!reason) {
      kept++;
      continue;
    }
    try {
      const done = await lms.redactJobRx(job.id);
      if (done) counts[reason]++;
      else raced++;
    } catch (err) {
      errored++;
      console.error(
        `[redact-lab-job-rx] failed for job ${job.id} (order ${job.order_id}): ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      captureException(err, {
        tags: { job: "redact-lab-job-rx", reason: "redact_failed" },
        extra: { lab_job_id: job.id, order_id: job.order_id },
      });
    }
  }

  console.info(
    `[redact-lab-job-rx] checked ${candidates.length}: blanked ${counts.cancelled} cancelled, ${counts.delivered} delivered, ${counts.max_age} past two years; ${kept} kept, ${raced} changed underneath, ${errored} errored, ${failedBatches} delivery lookups failed`,
  );
}

export const config = {
  name: "redact-lab-job-rx",
  // Once a day at 20:15 UTC (03:15 in Bangkok). The retention windows are
  // measured in days, so a daily pass is exact enough.
  schedule: "15 20 * * *",
};
