import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { buildLabJobPacket } from "../modules/lms/build-packet";
import { LMS_MODULE } from "../modules/lms/service";
import type LmsModuleService from "../modules/lms/service";
import type { BuildPacketResult } from "../modules/lms/types";
import { captureException } from "../lib/observability/sentry";

/**
 * On Medusa `order.placed`, compose a lab-job build result and persist a
 * durable `lab_job` row in the LMS queue.
 *
 * Durable failure visibility: unlike the old handler (which swallowed any
 * build error and created NO row), a failed/pending build now ALWAYS lands a
 * row so ops sees it in /admin/lab-jobs:
 *   - ok         → queued, then submitted if a provider is wired
 *   - pending_rx → row awaiting the customer's send-later prescription
 *   - failed     → row with the reason in last_error (heals via /retry)
 *   - skip       → frame-only order; legitimately no row (console.info only)
 *
 * The lab provider is `UnimplementedLabProvider` today, so an ok job stays
 * `queued` forever — no money or product moves. Once a lab partner is
 * selected, swap the provider and the same subscriber submits on order.placed.
 *
 * Idempotency: a read-before-create existence check plus a DB unique index on
 * order_id (the create tolerates a concurrent duplicate) means a redelivered
 * order.placed never doubles up a row.
 */

export default async function orderPlacedHandler({
  event,
  container,
}: SubscriberArgs<{ id: string }>) {
  const orderId = event.data?.id;
  if (!orderId) {
    console.warn("[order-placed] event missing order id; skipping lab job");
    return;
  }

  const lms = container.resolve(LMS_MODULE) as LmsModuleService;

  // Idempotency: if a job already exists for this order, don't create a
  // duplicate. Medusa's event bus may deliver the same event more than once.
  const existing = await lms.getJobByOrderId(orderId);
  if (existing) {
    return;
  }

  let result: BuildPacketResult;
  try {
    result = await buildLabJobPacket({ container, orderId });
  } catch (err) {
    // Infra failure (e.g. the order module threw). Still record a durable
    // failed row so the order isn't silently missing from the lab queue.
    captureException(err, {
      tags: { subscriber: "order-placed", reason: "build_threw" },
      extra: { order_id: orderId },
    });
    result = {
      outcome: "failed",
      reason: `lab-job build threw: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      snapshot: { job_ref: `klear-${orderId}`, klear_order_id: orderId },
    };
  }

  if (result.outcome === "skip") {
    console.info(
      `[order-placed] order ${orderId} needs no lab job (${result.reason})`,
    );
    return;
  }

  const job = await lms.createFromBuild(result);
  if (!job) return;

  if (result.outcome !== "ok") {
    // pending_rx / failed — durable, ops-visible, no submission attempt.
    console.info(
      `[order-placed] lab_job ${job.id} recorded as ${result.outcome}: ${result.reason}`,
    );
    return;
  }

  // Try to submit immediately. If the provider isn't wired
  // (UnimplementedLabProvider throws not_implemented) the job stays in
  // queued — that's the expected pre-lab-partner state.
  try {
    const submitResult = await lms.submitJob(job.id);
    if (submitResult.outcome === "queued_no_provider") {
      console.info(
        `[order-placed] lab_job ${job.id} queued (no provider wired)`,
      );
    }
  } catch (err) {
    console.error(
      `[order-placed] submitJob failed for ${job.id}: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
    captureException(err, {
      tags: { subscriber: "order-placed", reason: "submit_failed" },
      extra: { order_id: orderId, lab_job_id: job.id },
    });
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
};
