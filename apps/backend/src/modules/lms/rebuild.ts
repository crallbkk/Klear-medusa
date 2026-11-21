import type { MedusaContainer } from "@medusajs/framework/types";
import { LMS_MODULE, LabJobNotRebuildableError } from "./service";
import type LmsModuleService from "./service";
import { buildLabJobPacket } from "./build-packet";
import { ProductionError } from "./production";

type LabJobRow = Awaited<ReturnType<LmsModuleService["updateJobFromBuild"]>>;
type SubmitResult = Awaited<ReturnType<LmsModuleService["submitJob"]>>;

export interface RebuildResult {
  /** The build outcome applied to the job. */
  buildOutcome: "ok" | "pending_rx" | "failed" | "skip";
  /** Failure/skip/pending reason, when the outcome carries one. */
  reason?: string;
  /** The job row after the rebuild (and submit, when ok). */
  job: LabJobRow;
  /** Present ONLY when buildOutcome === "ok" — the submit attempt's result
   *  (`submitted` with a provider, `queued_no_provider` until one is wired). */
  submit?: SubmitResult;
}

/**
 * Re-run `buildLabJobPacket` against the order's CURRENT metadata, apply it to
 * an existing job, and submit when the rebuild produces a full packet.
 *
 * This is the single shared heal path used by BOTH:
 *   - `POST /admin/lab-jobs/[id]/retry` (operator-initiated), and
 *   - the `heal-pending-rx` scheduled job (send-later auto-heal, H5).
 *
 * A rebuild that comes back `ok` moves the job to `queued` (clearing any stale
 * provider error) and then submits; with no lab provider wired that submit is
 * `queued_no_provider`, which still correctly advances the job OUT of
 * `pending_rx`. A rebuild that is still `pending_rx` / `failed` / `skip` updates
 * the row's reason and does not submit.
 *
 * The caller is responsible for excluding non-rebuildable statuses
 * (submitted / submitting / cancelled) before calling — `updateJobFromBuild`
 * also guards them, but a caller-side pre-check yields a precise response.
 */
export type ChangedRxResult =
  | { outcome: "changed"; job: LabJobRow }
  /** The job has no production stage: its packet was never built. The
   *  ordinary Retry is the way to build it. */
  | { outcome: "not_in_production" }
  /** A label exists, or the job is delivered or cancelled. A change now is
   *  a remake or a new order, not a changed prescription. */
  | { outcome: "too_late"; stage: string }
  /** The new packet could not be built; nothing was touched. */
  | { outcome: "not_built"; buildOutcome: "pending_rx" | "failed" | "skip"; reason?: string };

/**
 * A customer's prescription changed on a job the lab may already have
 * started. The packet is rebuilt from the order, the job goes back to
 * `ready` (RX_CHANGED, which also opens the cut-or-uncut question when a
 * lens had been issued), and the new packet replaces the old one.
 *
 * Order of work, and why:
 *   1. Build first. If the new prescription is not there or not valid, the
 *      job is left exactly as it was: the lab keeps working from a packet
 *      that is at least complete.
 *   2. Record RX_CHANGED. From here the job is at `ready`, the lab's queue
 *      shows it as changed, and its status is `pending_rx`: the stored
 *      packet is the old one, so it cannot be printed.
 *   3. Write the new packet, which makes the job `queued` again. If this
 *      fails, the job waits at `ready` and `pending_rx`; this function
 *      called again, the Retry button, or the half-hourly heal sweep
 *      finishes it.
 *
 * The order is always the job's own; the caller cannot name another.
 * `key` identifies this one request so a repeat does nothing twice. The
 * caller must keep it the same for one request: a new key is a new change,
 * which sends the job back to `ready` again and re-opens the cut question.
 *
 * Note: the packet write merges into the stored packet (see
 * `updateJobFromBuild`). Every prescription field is required, so none can
 * be left over from the old packet; an optional field absent from the new
 * packet (a second address line) keeps its old value.
 */
export async function applyChangedPrescription(
  container: MedusaContainer,
  jobId: string,
  key: string,
  actorId: string,
): Promise<ChangedRxResult> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;

  // A packet already handed to (or being handed to) a lab provider, or a
  // cancelled one, cannot be replaced; find that out before anything is
  // recorded, not after RX_CHANGED has moved the job.
  const current = (await lms.retrieveLabJob(jobId)) as unknown as {
    status: string;
    stage: string | null;
    order_id: string;
  };
  if (current.status !== "queued" && current.status !== "failed" && current.status !== "pending_rx") {
    throw new LabJobNotRebuildableError(
      `applyChangedPrescription: job ${jobId} is ${current.status}; its packet cannot be replaced`,
    );
  }
  if (current.stage === null) return { outcome: "not_in_production" };
  if (current.stage === "labelled" || current.stage === "delivered" || current.stage === "cancelled") {
    return { outcome: "too_late", stage: current.stage };
  }
  const orderId = current.order_id;

  const result = await buildLabJobPacket({ container, orderId });
  if (result.outcome !== "ok") {
    return {
      outcome: "not_built",
      buildOutcome: result.outcome,
      reason: (result as { reason?: string }).reason,
    };
  }
  let recorded;
  try {
    recorded = await lms.applyProductionAction({
      job_id: jobId,
      action: "RX_CHANGED",
      idempotency_key: key,
      actor: { type: "system", id: `rx-changed:${actorId}` },
    });
  } catch (err) {
    // The job moved while the packet was being built (a label was booked).
    if (err instanceof ProductionError && err.code === "not_allowed") {
      const now = (await lms.retrieveLabJob(jobId)) as unknown as LabJobRow;
      return { outcome: "too_late", stage: now.stage ?? "not ready" };
    }
    throw err;
  }
  // This request was already carried out and the lab has since started
  // again: the packet it stored is in use and is not written a second time.
  if (recorded.replayed && recorded.job.stage !== "ready") {
    return { outcome: "changed", job: (await lms.retrieveLabJob(jobId)) as unknown as LabJobRow };
  }
  const job = await lms.updateJobFromBuild(jobId, result);
  return { outcome: "changed", job };
}

export async function rebuildAndSubmitJob(
  container: MedusaContainer,
  jobId: string,
  orderId: string,
): Promise<RebuildResult> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;

  const result = await buildLabJobPacket({ container, orderId });
  const job = await lms.updateJobFromBuild(jobId, result);

  if (result.outcome === "ok") {
    const submit = await lms.submitJob(job.id);
    return { buildOutcome: "ok", job: submit.job, submit };
  }

  return {
    buildOutcome: result.outcome,
    reason: (result as { reason?: string }).reason,
    job,
  };
}
