import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { MedusaError } from "@medusajs/framework/utils";
import {
  LMS_MODULE,
  LabJobDuplicateError,
  LabJobNotRebuildableError,
  ProductionWriteError,
} from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import { rebuildAndSubmitJob } from "../../../../../modules/lms/rebuild";
import { captureException } from "../../../../../lib/observability/sentry";
import { errorKind } from "../../production-http";

// Errors whose text this code builds itself, from ids, a status and an
// error code. Their message is safe to log, to report and to answer with.
const ownWords = (err: unknown): string | null =>
  err instanceof ProductionWriteError ||
  err instanceof LabJobNotRebuildableError ||
  err instanceof LabJobDuplicateError
    ? err.message
    : null;

// How a failure is named in the log: its own words if they are ours,
// otherwise only what kind of error it is.
const named = (err: unknown): string => ownWords(err) ?? errorKind(err);

// What is sent to Sentry. One of our own errors goes as it is, with its
// stack. Anything else is replaced by its kind: an error's message is the
// one thing the Sentry scrubber cannot clean.
const reportable = (err: unknown, what: string): Error => {
  if (ownWords(err) !== null) return err as Error;
  const safe = new Error(`${what}: ${errorKind(err)}`);
  // Keep where it came from: the original's stack frames, and only lines
  // that are frames (they end in file:line:column). The message part of a
  // stack, which can run over several lines, is left behind.
  const stack = (err as { stack?: unknown })?.stack;
  if (typeof stack === "string") {
    const NL = String.fromCharCode(10);
    const frames = stack.split(NL).filter((line) => /^\s+at .*:\d+:\d+\)?\r?$/.test(line));
    if (frames.length > 0) {
      safe.stack = [`${safe.name}: ${safe.message}`, ...frames].join(NL);
    }
  }
  return safe;
};

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
      `[lab-jobs/retry] retrieve failed for ${id}: ${named(err)}`,
    );
    captureException(reportable(err, "admin/lab-jobs/retry could not read the job"), {
      tags: { route: "admin/lab-jobs/retry", reason: "retrieve_failed" },
      extra: { lab_job_id: id },
    });
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
  if (job.status === "submitting") {
    // Another worker holds the submission claim right now — rebuilding under
    // it would race the in-flight provider call. Conflict, not an error.
    res.status(409).json({ error: "submission claim in flight — retry shortly" });
    return;
  }

  try {
    // Rebuild from the current order metadata so fixes are picked up
    // (queued / failed / pending_rx) — shared with the heal-pending-rx job.
    const r = await rebuildAndSubmitJob(req.scope, id, job.order_id);

    if (r.buildOutcome === "ok") {
      res.json(r.submit);
      return;
    }

    res.json({
      outcome: r.buildOutcome,
      reason: r.reason,
      job: r.job,
    });
  } catch (err) {
    if (err instanceof LabJobNotRebuildableError) {
      // The job moved on between this route's read and the rebuild. Not a
      // fault: the heal sweep treats the same thing as nothing to report.
      res.status(409).json({ error: err.message });
      return;
    }
    console.error(
      `[lab-jobs/retry] retry failed for ${id}: ${named(err)}`,
    );
    captureException(reportable(err, "admin/lab-jobs/retry failed"), {
      tags: { route: "admin/lab-jobs/retry", reason: "rebuild_failed" },
      extra: { lab_job_id: id, order_id: job.order_id },
    });
    // Our own words if we have them; otherwise a fixed sentence, because
    // an error's own text can carry values.
    res.status(500).json({ error: ownWords(err) ?? "the retry failed; see the server log" });
  }
}
