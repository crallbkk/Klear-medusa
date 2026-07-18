import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { MedusaError } from "@medusajs/framework/utils";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import { buildLabJobPacket } from "../../../../../modules/lms/build-packet";

/**
 * POST /admin/lab-jobs/[id]/retry — heal + re-attempt a lab job. No body.
 *
 * This is the healing path for `failed` AND `pending_rx` jobs: it RE-RUNS
 * `buildLabJobPacket` against the current order metadata, so a fixed
 * prescription or corrected line metadata (e.g. the send-later Rx that has
 * since been submitted, which writes `klear_prescription_id` onto the order)
 * is picked up. Only when the rebuild produces a full packet does it submit.
 *
 *   rebuild → ok         → snapshot refreshed, status queued, then submit
 *   rebuild → pending_rx → still waiting; row updated, no submit
 *   rebuild → failed     → still broken; reason refreshed, no submit
 *   rebuild → skip       → order became frame-only; reason recorded, no submit
 *
 * Errors: unknown job id → 404; cancelled → 400 (operator error); anything
 * else (DB down, order module failure, …) → 500 — an infra failure is not a
 * bad request and must not be reported as one.
 */
export async function POST(
  req: MedusaRequest<unknown>,
  res: MedusaResponse,
): Promise<void> {
  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }

  // Resolve the job first so a missing id is a real 404. MedusaService's
  // retrieve throws MedusaError NOT_FOUND rather than returning null — catch
  // that specifically; any other retrieve failure is infra (500).
  let job;
  try {
    job = await lms.retrieveLabJob(id);
  } catch (err) {
    if (
      err instanceof MedusaError &&
      err.type === MedusaError.Types.NOT_FOUND
    ) {
      res.status(404).json({ error: "lab_job not found" });
      return;
    }
    console.error(
      `[lab-jobs/retry] retrieve failed for ${id}: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
    res.status(500).json({ error: "internal error retrieving lab_job" });
    return;
  }
  if (!job) {
    res.status(404).json({ error: "lab_job not found" });
    return;
  }
  if (job.status === "cancelled") {
    res.status(400).json({ error: "cannot retry a cancelled job" });
    return;
  }
  if (job.status === "submitted") {
    // Already accepted by the provider — nothing to heal. Idempotent no-op.
    res.json({ outcome: "submitted", job });
    return;
  }

  try {
    // Rebuild from the current order metadata so fixes are picked up
    // (queued / failed / pending_rx).
    const result = await buildLabJobPacket({
      container: req.scope,
      orderId: job.order_id,
    });

    const updated = await lms.updateJobFromBuild(id, result);

    if (result.outcome === "ok") {
      const submitResult = await lms.submitJob(updated.id);
      res.json(submitResult);
      return;
    }

    res.json({
      outcome: result.outcome,
      reason: (result as { reason?: string }).reason,
      job: updated,
    });
  } catch (err) {
    console.error(
      `[lab-jobs/retry] retry failed for ${id}: ${
        err instanceof Error ? err.message : "unknown"
      }`,
    );
    res.status(500).json({
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
