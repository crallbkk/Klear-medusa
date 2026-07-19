import type { MedusaContainer } from "@medusajs/framework/types";
import { LMS_MODULE } from "./service";
import type LmsModuleService from "./service";
import { buildLabJobPacket } from "./build-packet";

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
