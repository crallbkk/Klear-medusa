import type { MedusaContainer } from "@medusajs/framework/types";
import { LMS_MODULE, LabJobNotRebuildableError } from "./service";
import type LmsModuleService from "./service";
import { buildLabJobPacket } from "./build-packet";
import { ProductionError, decide, type JobState } from "./production";
import type { LabJobPacket } from "./types";

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

export type WarrantyRemakeResult =
  | { outcome: "started"; result: Awaited<ReturnType<LmsModuleService["applyProductionAction"]>> }
  /** The prescription could not be fetched back; nothing was changed. */
  | { outcome: "not_built"; buildOutcome: "pending_rx" | "failed" | "skip" };

/**
 * Start a warranty remake on a labelled or delivered job.
 *
 * If the readable prescription was removed from its packet (it is, some
 * time after delivery), the packet is built again from the order, which
 * decrypts the customer's stored prescription, and handed to the writer,
 * which stores it in the same transaction as the REMAKE_STARTED event. So
 * the prescription is back only if the remake is recorded, the record
 * names who asked, and a refused request changes nothing.
 *
 * Nothing is decrypted for a request that is going to be refused anyway,
 * as far as can be told before asking the writer: the key was already
 * used (the writer then answers with the first result), the job is not
 * where a warranty remake starts, the version is stale, or the rules
 * would refuse the remake even with the prescription back.
 */
export async function startWarrantyRemake(
  container: MedusaContainer,
  input: {
    job_id: string;
    idempotency_key: string;
    expected_version?: number;
    cause: unknown;
    actor_id: string;
  },
  // Replaced in tests, which have no order module or vault to build from.
  build: typeof buildLabJobPacket = buildLabJobPacket,
): Promise<WarrantyRemakeResult> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;
  const record = (restore_packet?: LabJobPacket) =>
    lms.applyProductionAction({
      job_id: input.job_id,
      action: "REMAKE_STARTED",
      idempotency_key: input.idempotency_key,
      expected_version: input.expected_version,
      detail: { cause: input.cause },
      actor: { type: "user", id: input.actor_id },
      restore_packet,
    });

  // A key that was already used is answered by the writer with the first
  // result, whatever has happened to the job since. Nothing is fetched.
  if (await lms.hasProductionEventKey(input.idempotency_key)) {
    return { outcome: "started", result: await record() };
  }
  const current = (await lms.retrieveLabJob(input.job_id)) as unknown as LabJobRow;
  if (current.stage !== "labelled" && current.stage !== "delivered") {
    throw new ProductionError(
      "not_allowed",
      "a warranty remake starts from a labelled or delivered job; this one is " +
        (current.stage ?? "not in production"),
    );
  }
  // A packet that still has its prescription: the plain remake.
  if (!current.rx_redacted_at) return { outcome: "started", result: await record() };

  if (input.expected_version !== undefined && input.expected_version !== current.stage_version) {
    throw new ProductionError(
      "conflict",
      `the job has moved (it is ${current.stage}); reload and try again`,
    );
  }
  if (current.status !== "queued") {
    throw new ProductionError(
      "not_allowed",
      `the packet of this job is ${current.status}; its prescription cannot be put back here`,
    );
  }
  // Would the remake be recorded with the prescription back? Throws the
  // rule's own refusal (on hold, an open question, a missing cause).
  decide(
    {
      stage: current.stage,
      remake_count: current.remake_count,
      on_hold: current.on_hold,
      cut_question_pending: current.cut_question_pending,
      next_issue_reason: current.next_issue_reason as JobState["next_issue_reason"],
    },
    "REMAKE_STARTED",
    { cause: input.cause },
  );

  const built = await build({ container, orderId: current.order_id });
  if (built.outcome !== "ok") return { outcome: "not_built", buildOutcome: built.outcome };
  return { outcome: "started", result: await record(built.packet) };
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
