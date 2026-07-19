import { MedusaService } from "@medusajs/framework/utils";
import LabJob from "./models/lab-job";
import {
  type BuildPacketResult,
  type ILabProvider,
  type LabJobPacket,
  type LabJobStatusReport,
  LabProviderError,
} from "./types";
import { UnimplementedLabProvider } from "./providers/_unimplemented";

export const LMS_MODULE = "lms";

export type LabJobStatusValue =
  | "queued"
  | "submitting" // transient claim state — exactly one worker owns the provider call
  | "submitted"
  | "failed"
  | "cancelled"
  | "pending_rx";

/** Statuses from which a rebuild (retry heal) is allowed to rewrite the row. */
const REBUILDABLE_STATUSES: ReadonlySet<LabJobStatusValue> = new Set([
  "queued",
  "failed",
  "pending_rx",
]);

/**
 * Thrown by `updateJobFromBuild` when the target job is no longer rebuildable
 * (submitted / submitting / cancelled). For the operator retry route this is a
 * real 400/409; for the `heal-pending-rx` sweep it's BENIGN — another path
 * (a manual retry, or the prior sweep pass) advanced the job between the list
 * read and the rebuild — so the sweep counts it as concurrently-advanced, not
 * an error. Typed (not a bare Error) so callers can tell the two apart without
 * string-matching.
 */
export class LabJobNotRebuildableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LabJobNotRebuildableError";
  }
}

export type LabJobRow = {
  id: string;
  order_id: string;
  status: LabJobStatusValue;
  packet_snapshot: LabJobPacket;
  provider_job_id: string | null;
  provider_name: string | null;
  attempts: number;
  last_error: string | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Lab Management System (LMS) service.
 *
 * Two responsibilities:
 *   1. Persist a `lab_job` row for every order that went through
 *      lab-handoff — including durable rows for failures and send-later
 *      waits, so ops always has visibility in /admin/lab-jobs (no silent
 *      swallow). Lifecycle: queued / submitted / failed / pending_rx /
 *      cancelled.
 *   2. Wrap the abstract `ILabProvider` for submission + status checks.
 *      The provider is `UnimplementedLabProvider` until a lab partner is
 *      selected (DECISIONS.md #3 + #4) — `submitJob()` throws not_implemented
 *      and the job stays `queued`. Switching providers is a single-line change.
 *
 * **PDPA boundary**: the `packet_snapshot` JSON column carries plaintext Rx
 * data because the lab needs it. Never log this column, never include it in
 * audit payloads, never expose it from the customer-facing Store API.
 */
class LmsModuleService extends MedusaService({
  LabJob,
}) {
  private readonly provider: ILabProvider = new UnimplementedLabProvider();

  /**
   * Detects a Postgres unique-constraint violation (SQLSTATE 23505) however
   * MikroORM/pg wraps it, so concurrent duplicate inserts can be treated as
   * "already created" rather than crashing the subscriber.
   */
  private isUniqueViolation(err: unknown): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    const code = e?.code ?? e?.cause?.code ?? e?.errno;
    if (code === "23505") return true;
    const name = e?.constructor?.name ?? e?.name ?? "";
    if (typeof name === "string" && /UniqueConstraint/i.test(name)) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /duplicate key value|unique constraint|23505/i.test(msg);
  }

  /**
   * Insert a lab_job row, tolerating a concurrent duplicate. If the unique
   * index on (order_id) rejects the insert, another handler already created
   * the row — return that existing row instead of throwing.
   */
  private async insertJob(data: {
    order_id: string;
    status: LabJobStatusValue;
    packet_snapshot: Record<string, unknown>;
    last_error?: string | null;
  }): Promise<LabJobRow> {
    try {
      const created = (await this.createLabJobs({
        order_id: data.order_id,
        status: data.status,
        packet_snapshot: data.packet_snapshot,
        last_error: data.last_error ?? null,
        attempts: 0,
      })) as unknown as LabJobRow;
      return created;
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        const existing = await this.getJobByOrderId(data.order_id);
        if (existing) return existing;
      }
      throw err;
    }
  }

  /** Map a build result to the persisted row's status + snapshot + reason. */
  private rowFieldsFromBuild(
    result: Exclude<BuildPacketResult, { outcome: "skip" }>,
  ): {
    order_id: string;
    status: LabJobStatusValue;
    packet_snapshot: Record<string, unknown>;
    last_error: string | null;
  } {
    if (result.outcome === "ok") {
      return {
        order_id: result.packet.klear_order_id,
        status: "queued",
        packet_snapshot: result.packet as unknown as Record<string, unknown>,
        last_error: null,
      };
    }
    return {
      order_id: result.snapshot.klear_order_id,
      status: result.outcome === "pending_rx" ? "pending_rx" : "failed",
      packet_snapshot: result.snapshot as unknown as Record<string, unknown>,
      last_error: result.reason,
    };
  }

  /**
   * Persist a lab_job row from a build result. Returns null for a `skip`
   * (frame-only order — no lab job needed). For ok/failed/pending_rx the row
   * is created (deduped against a concurrent insert).
   */
  async createFromBuild(result: BuildPacketResult): Promise<LabJobRow | null> {
    if (result.outcome === "skip") return null;
    return this.insertJob(this.rowFieldsFromBuild(result));
  }

  /** Create a queued lab_job row directly from a packet (happy path). */
  async createJob(packet: LabJobPacket): Promise<LabJobRow> {
    return this.insertJob({
      order_id: packet.klear_order_id,
      status: "queued",
      packet_snapshot: packet as unknown as Record<string, unknown>,
      last_error: null,
    });
  }

  /**
   * Apply a fresh build result onto an EXISTING job (the /retry heal path).
   * Rewrites packet_snapshot, status and last_error so a fixed prescription
   * or corrected metadata can move a failed/pending_rx job forward. Does not
   * submit — the caller submits when the outcome is "ok".
   */
  async updateJobFromBuild(
    jobId: string,
    result: BuildPacketResult,
  ): Promise<LabJobRow> {
    // Guard here, not just in the route: rewriting a submitted/cancelled/
    // in-flight row's snapshot would corrupt the audit trail (and could
    // resubmit a job the lab already has). Only settled, retryable rows may
    // be rebuilt.
    const current = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    if (!current) throw new Error(`updateJobFromBuild: job ${jobId} not found`);
    if (!REBUILDABLE_STATUSES.has(current.status)) {
      throw new LabJobNotRebuildableError(
        `updateJobFromBuild: job ${jobId} is ${current.status} — only queued/failed/pending_rx jobs can be rebuilt`,
      );
    }

    if (result.outcome === "skip") {
      // The order became frame-only since the row was created (unusual). Leave
      // the snapshot untouched; just record why nothing was submitted.
      const updated = (await this.updateLabJobs({
        selector: { id: jobId },
        data: { last_error: result.reason },
      })) as unknown as LabJobRow[];
      if (!updated[0]) throw new Error(`updateJobFromBuild: job ${jobId} not found`);
      return updated[0];
    }
    const fields = this.rowFieldsFromBuild(result);
    // Skip the write when nothing meaningful changed — a still-waiting
    // (pending_rx) or still-failed job rebuilt with the SAME reason. This
    // avoids churning `updated_at` (so it stays a real "last progressed"
    // signal in /admin/lab-jobs) and needless row writes on every sweep pass.
    // An "ok" rebuild always writes — it transitions the job to `queued`.
    if (
      fields.status !== "queued" &&
      current.status === fields.status &&
      current.last_error === fields.last_error
    ) {
      return current;
    }
    const updated = (await this.updateLabJobs({
      selector: { id: jobId },
      data: {
        status: fields.status,
        packet_snapshot: fields.packet_snapshot,
        last_error: fields.last_error,
        // A successful rebuild clears any stale provider error.
        ...(fields.status === "queued" ? { provider_job_id: null } : {}),
      },
    })) as unknown as LabJobRow[];
    if (!updated[0]) throw new Error(`updateJobFromBuild: job ${jobId} not found`);
    return updated[0];
  }

  async getJobByOrderId(orderId: string): Promise<LabJobRow | null> {
    const rows = (await this.listLabJobs({
      order_id: orderId,
    })) as unknown as LabJobRow[];
    if (rows.length === 0) return null;
    rows.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return rows[0]!;
  }

  async listJobsByStatus(
    status: LabJobStatusValue,
    limit = 100,
  ): Promise<LabJobRow[]> {
    // Oldest-first: with a `take` cap, ordering ensures a large backlog of
    // never-answered pending_rx rows can't repeatedly return the same head set
    // and starve newer, healable jobs from ever being swept.
    return (await this.listLabJobs(
      { status },
      { take: limit, order: { created_at: "ASC" } },
    )) as unknown as LabJobRow[];
  }

  /**
   * Attempt to submit a queued job to the configured lab provider.
   *
   * Concurrency: the caller may be one of two racing order.placed handlers
   * (the unique index dedupes the ROW, not the submission — the 23505 loser
   * adopts the winner's row and also reaches here). Before touching the
   * provider we CLAIM the job with a status-guarded update
   * (queued → submitting, matched on `status: "queued"` in the selector);
   * only the caller whose claim affected a row calls the provider. The loser
   * gets outcome "already_submitting" and does nothing.
   *
   * Outcomes:
   *   submitted          — provider accepted; provider_job_id populated
   *   queued_no_provider — provider not wired; claim released back to queued
   *   failed             — provider rejected; last_error populated
   *   already_submitting — another worker holds the claim (or just submitted)
   */
  async submitJob(
    jobId: string,
  ): Promise<{
    outcome: "submitted" | "failed" | "queued_no_provider" | "already_submitting";
    job: LabJobRow;
  }> {
    const job = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    if (!job) throw new Error(`submitJob: job ${jobId} not found`);
    if (job.status === "submitted") {
      return { outcome: "submitted", job };
    }
    if (job.status === "submitting") {
      return { outcome: "already_submitting", job };
    }
    if (job.status === "cancelled") {
      throw new Error(
        `submitJob: job ${jobId} is cancelled — cannot resubmit`,
      );
    }
    if (job.status === "pending_rx") {
      throw new Error(
        `submitJob: job ${jobId} is pending_rx — rebuild via retry once the Rx lands before submitting`,
      );
    }
    if (job.status === "failed") {
      throw new Error(
        `submitJob: job ${jobId} is failed — heal via retry (rebuild) before submitting`,
      );
    }

    // Claim: queued → submitting, guarded on the CURRENT status in the
    // selector. If another worker claimed between our read and this write,
    // the selector matches nothing and we back off. (MedusaService resolves
    // the selector to ids before updating, so a microscopic race window
    // remains vs a native `UPDATE … WHERE status='queued'`; combined with
    // the read-check above this reduces double-submission from
    // seconds-likely to pathological. A native conditional UPDATE would
    // close it fully if a provider ever proves non-idempotent.)
    const claimed = (await this.updateLabJobs({
      selector: { id: jobId, status: "queued" },
      data: { status: "submitting" },
    })) as unknown as LabJobRow[];
    if (claimed.length === 0) {
      const current = (await this.retrieveLabJob(
        jobId,
      )) as unknown as LabJobRow;
      return {
        outcome:
          current?.status === "submitted" ? "submitted" : "already_submitting",
        job: current ?? job,
      };
    }

    try {
      const { provider_job_id } = await this.provider.submitJob(
        job.packet_snapshot,
      );
      const updated = (await this.updateLabJobs({
        selector: { id: jobId },
        data: {
          status: "submitted",
          provider_job_id,
          provider_name: this.provider.name,
          attempts: job.attempts + 1,
          last_error: null,
          submitted_at: new Date(),
        },
      })) as unknown as LabJobRow[];
      return { outcome: "submitted", job: updated[0]! };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const truncated = message.slice(0, 500);

      if (
        err instanceof LabProviderError &&
        err.code === "not_implemented"
      ) {
        // Expected pre-lab-partner state — release the claim back to
        // queued, just count the attempt.
        const updated = (await this.updateLabJobs({
          selector: { id: jobId },
          data: {
            status: "queued",
            attempts: job.attempts + 1,
            last_error: truncated,
          },
        })) as unknown as LabJobRow[];
        return { outcome: "queued_no_provider", job: updated[0]! };
      }

      const updated = (await this.updateLabJobs({
        selector: { id: jobId },
        data: {
          status: "failed",
          attempts: job.attempts + 1,
          last_error: truncated,
        },
      })) as unknown as LabJobRow[];
      return { outcome: "failed", job: updated[0]! };
    }
  }

  /** Mark a queued / failed / pending_rx / submitted job as cancelled.
   *  Called when the customer cancels before lab production starts. */
  async cancelJob(jobId: string): Promise<LabJobRow> {
    const updated = (await this.updateLabJobs({
      selector: { id: jobId },
      data: { status: "cancelled" },
    })) as unknown as LabJobRow[];
    if (!updated[0]) throw new Error(`cancelJob: job ${jobId} not found`);
    return updated[0];
  }

  /** Pass-through to the provider for lab-side status checks. */
  async getProviderJobStatus(
    providerJobId: string,
  ): Promise<LabJobStatusReport> {
    return this.provider.getJobStatus(providerJobId);
  }

  getProviderName(): string {
    return this.provider.name;
  }
}

export default LmsModuleService;
