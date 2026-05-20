import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { buildLabJobPacket } from "../modules/lms/build-packet";
import { LMS_MODULE } from "../modules/lms/service";
import type LmsModuleService from "../modules/lms/service";

/**
 * On Medusa `order.placed`, compose a LabJobPacket and persist a
 * `lab_job` row in the LMS module's queue.
 *
 * Today the lab provider is `UnimplementedLabProvider`, so the job
 * stays in `queued` status forever — no money or product moves. Once
 * a lab partner is selected, swap the provider and the same
 * subscriber will start submitting jobs immediately on order.placed.
 *
 * Failure mode: errors during packet construction are CAPTURED, not
 * thrown. We don't want a malformed-Rx case to break the order-placed
 * pipeline (the customer has already paid). The order goes through;
 * a missing/failed lab_job is visible to ops in /admin/lab-jobs.
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
  // duplicate. Medusa's event bus may deliver the same event more than
  // once on retries.
  const existing = await lms.getJobByOrderId(orderId);
  if (existing) {
    return;
  }

  let packet;
  try {
    packet = await buildLabJobPacket({ container, orderId });
  } catch (err) {
    console.error(
      `[order-placed] buildLabJobPacket failed for ${orderId}: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
    return;
  }

  const job = await lms.createJob(packet);

  // Try to submit immediately. If the provider isn't wired
  // (UnimplementedLabProvider throws not_implemented) the job stays in
  // queued — that's the expected pre-lab-partner state.
  try {
    const result = await lms.submitJob(job.id);
    if (result.outcome === "queued_no_provider") {
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
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
};
