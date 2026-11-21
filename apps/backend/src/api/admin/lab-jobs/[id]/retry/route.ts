import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { MedusaError } from "@medusajs/framework/utils";
import { LMS_MODULE, LabJobNotRebuildableError } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import { rebuildAndSubmitJob } from "../../../../../modules/lms/rebuild";
import { captureException } from "../../../../../lib/observability/sentry";
import { NOT_BUILT, errorKind, withoutPacket } from "../../production-http";

// A job in an answer, never with its packet. The packet is shown by one
// route, which records who looked.
const bare = (job: unknown) => withoutPacket((job ?? {}) as Record<string, unknown>);
// What kind of error, without its text. An error's message can hold a
// whole packet (a failed save is the SQL with its values), and Sentry's
// scrubber cannot clean a message, so the original error is never logged
// or reported: a new one naming only its kind is.
const kindOf = errorKind;
const reportable = (err: unknown, what: string) => new Error(`${what}: ${errorKind(err)}`);

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
 * A job the lab has started on (stage past `ready`) → 409: its packet is
 * what the lab's sheet was printed from and is not rebuilt.
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
    res.status(400).json({ error: "id required", message: "id required" });
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
      res.status(404).json({ error: "lab_job not found", message: "lab_job not found" });
      return;
    }
    console.error(`[lab-jobs/retry] retrieve failed for ${id}: ${kindOf(err)}`);
    captureException(reportable(err, "admin/lab-jobs/retry could not read the job"), {
      tags: { route: "admin/lab-jobs/retry", reason: "retrieve_failed" },
      extra: { lab_job_id: id },
    });
    res.status(500).json({ error: "internal error retrieving lab_job", message: "internal error retrieving lab_job" });
    return;
  }
  if (!job) {
    res.status(404).json({ error: "lab_job not found", message: "lab_job not found" });
    return;
  }
  if (job.status === "cancelled") {
    res.status(400).json({ error: "cannot retry a cancelled job", message: "cannot retry a cancelled job" });
    return;
  }
  if (job.status === "submitted") {
    // Already accepted by the provider — nothing to heal. Idempotent no-op.
    res.json({ outcome: "submitted", job: bare(job) });
    return;
  }
  if (job.status === "submitting") {
    // Another worker holds the submission claim right now — rebuilding under
    // it would race the in-flight provider call. Conflict, not an error.
    res.status(409).json({ error: "submission claim in flight — retry shortly", message: "submission claim in flight — retry shortly" });
    return;
  }

  const IN_PRODUCTION = "the lab has started on this job; its packet cannot be rebuilt";
  if (job.stage && job.stage !== "ready") {
    // Checked before building, so no prescription is decrypted for nothing.
    res.status(409).json({ error: IN_PRODUCTION, message: IN_PRODUCTION });
    return;
  }

  try {
    // Rebuild from the current order metadata so fixes are picked up
    // (queued / failed / pending_rx) — shared with the heal-pending-rx job.
    const r = await rebuildAndSubmitJob(req.scope, id, job.order_id);

    if (r.buildOutcome === "ok") {
      res.json({ ...r.submit, job: bare(r.submit?.job) });
      return;
    }

    res.json({
      outcome: r.buildOutcome,
      reason: NOT_BUILT[r.buildOutcome],
      job: bare(r.job),
    });
  } catch (err) {
    if (err instanceof LabJobNotRebuildableError) {
      // The job moved (into production, or was submitted or cancelled)
      // between the read above and the rebuild. Not an infra failure.
      res.status(409).json({ error: "the job changed while it was being rebuilt; reload it", message: "the job changed while it was being rebuilt; reload it" });
      return;
    }
    console.error(`[lab-jobs/retry] retry failed for ${id}: ${kindOf(err)}`);
    captureException(reportable(err, "admin/lab-jobs/retry failed"), {
      tags: { route: "admin/lab-jobs/retry", reason: "rebuild_failed" },
      extra: { lab_job_id: id, order_id: job.order_id },
    });
    res.status(500).json({ error: "the retry failed; try again", message: "the retry failed; try again" });
  }
}
