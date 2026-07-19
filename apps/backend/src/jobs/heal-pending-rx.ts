import type { MedusaContainer } from "@medusajs/framework/types";
import { LMS_MODULE } from "../modules/lms/service";
import type LmsModuleService from "../modules/lms/service";
import { rebuildAndSubmitJob } from "../modules/lms/rebuild";

/**
 * Scheduled sweep — heal send-later lab jobs (H5).
 *
 * A pay-first / send-Rx-later order creates a `pending_rx` lab job at
 * `order.placed` (no prescription yet). When the customer later submits their
 * Rx, `POST /api/order/[id]/prescription` writes `klear_prescription_id` +
 * signature onto the Medusa ORDER metadata — but nothing re-triggers the lab
 * job, so without this sweep it would sit in `pending_rx` forever.
 *
 * This job periodically re-runs the packet build for every `pending_rx` job.
 * The moment an order's metadata carries a valid Rx, the rebuild produces a
 * full packet and the job advances out of `pending_rx` (→ `queued`, then
 * `submitted` once a lab provider is wired). Jobs whose Rx has not arrived stay
 * `pending_rx` (a cheap no-op — the build returns `pending_rx` without
 * decrypting). Idempotent and safe to run repeatedly.
 *
 * Why a SWEEP and not an event/nudge: no lab provider is wired yet, so instant
 * heal has no value today, and a periodic backend-owned sweep avoids any
 * frontend→backend coupling or a dependency on Medusa emitting a
 * metadata-change event. An immediate nudge (storefront → this heal path) is a
 * small additive follow-up if progression latency ever matters.
 *
 * Scope: `pending_rx` only. Genuinely `failed` jobs (bad signature, missing
 * address, tampering) are NOT swept — they need ops attention via
 * `/admin/lab-jobs` + the manual retry route, not silent auto-retry.
 */
export default async function healPendingRxJob(
  container: MedusaContainer,
): Promise<void> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;

  const pending = await lms.listJobsByStatus("pending_rx");
  if (pending.length === 0) return;

  let healed = 0;
  let stillWaiting = 0;
  let errored = 0;

  for (const job of pending) {
    try {
      const r = await rebuildAndSubmitJob(container, job.id, job.order_id);
      if (r.buildOutcome === "ok") healed++;
      else stillWaiting++;
    } catch (err) {
      // One malformed order must never abort the sweep of the rest.
      errored++;
      console.error(
        `[heal-pending-rx] heal failed for job ${job.id} (order ${job.order_id}): ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
    }
  }

  console.info(
    `[heal-pending-rx] swept ${pending.length} pending_rx: ${healed} healed, ${stillWaiting} still waiting, ${errored} errored`,
  );
}

export const config = {
  name: "heal-pending-rx",
  // Every 15 minutes. With no lab provider wired this only needs to move healed
  // jobs out of pending_rx promptly enough for ops visibility; tighten the
  // cadence (or add a storefront nudge) if instant progression ever matters.
  schedule: "*/15 * * * *",
};
