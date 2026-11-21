import { createHash } from "crypto";
import { MedusaService, generateEntityId } from "@medusajs/framework/utils";
import { captureException } from "../../lib/observability/sentry";
import LabJob from "./models/lab-job";
import ProductionEvent from "./models/production-event";
import LabUsage from "./models/lab-usage";
import LabCost from "./models/lab-cost";
import LabReleaseWindow from "./models/lab-release-window";
import LabUsageRelease from "./models/lab-usage-release";
import LabTotalDay from "./models/lab-total-day";
import { addDays, dueWindows, releaseWeekday, type ReleaseWindow } from "./release";
import {
  type BuildPacketResult,
  type ILabProvider,
  type LabJobPacket,
  type LabJobStatusReport,
  LabProviderError,
} from "./types";
import { UnimplementedLabProvider } from "./providers/_unimplemented";
import { isSubmissionInFlight } from "./rx-retention";
import {
  ACTIONS,
  STAGE_ACTIONS,
  SYSTEM_ONLY_ACTIONS,
  ProductionError,
  bangkokDate,
  decide,
  type JobState,
  type ProductionAction,
  type Stage,
} from "./production";

export const LMS_MODULE = "lms";

export type LabJobStatusValue =
  | "queued"
  | "submitting" // transient claim state — exactly one worker owns the provider call
  | "submitted"
  | "failed"
  | "cancelled"
  | "pending_rx";

/** How far back a built job with no stage is still given one (by the
 *  migration's backfill and by `markStagelessJobsReady`). Older jobs predate
 *  production and nobody knows where their glasses are. */
export const STAGELESS_SWEEP_DAYS = 30;

/**
 * A database failure while recording a production action. Built from the
 * driver's error code and constraint name ONLY. The driver's own message
 * holds the SQL with its values written in (a lens SKU next to a job id, a
 * note's text), and an error message is the one place the Sentry scrubber
 * cannot clean, so that message is never passed on.
 */
export class ProductionWriteError extends Error {
  readonly code: string | null;
  constructor(cause: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = cause as any;
    const code = typeof e?.code === "string" ? e.code : null;
    const constraint = typeof e?.constraint === "string" ? e.constraint : null;
    // Medusa rewrites some driver errors (unique, not-null, foreign key)
    // into its own error with no code. Its `type` and class name hold no
    // values, so they are safe to pass on; its message is not.
    const kind = [e?.type, e?.name ?? e?.constructor?.name]
      .filter((v) => typeof v === "string" && /^[A-Za-z_]{1,40}$/.test(v))
      .join("/");
    super(
      `the production action could not be recorded (database error ${code ?? (kind || "unknown")}${
        constraint ? `, constraint ${constraint}` : ""
      })`,
    );
    this.name = "ProductionWriteError";
    this.code = code;
  }
}

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
  /** When the readable prescription in `packet_snapshot` was blanked. */
  rx_redacted_at: Date | null;
  /** Production: where the physical job is. Null until the packet is built. */
  stage: Stage | null;
  stage_since: Date | null;
  stage_version: number;
  event_seq: number;
  remake_count: number;
  on_hold: boolean;
  hold_reason: string | null;
  cut_question_pending: boolean;
  next_issue_reason: string;
  created_at: Date;
  updated_at: Date;
};

/** The production columns of a job, as returned by an action. */
export type LabJobProductionState = Pick<
  LabJobRow,
  | "id"
  | "order_id"
  | "stage"
  | "stage_since"
  | "stage_version"
  | "event_seq"
  | "remake_count"
  | "on_hold"
  | "hold_reason"
  | "cut_question_pending"
  | "next_issue_reason"
>;

export type ProductionEventRow = {
  id: string;
  lab_job_id: string;
  seq: number;
  action: ProductionAction;
  from_stage: Stage | null;
  to_stage: Stage | null;
  idempotency_key: string;
  actor_type: "user" | "system";
  actor_id: string;
  happened_at: Date | null;
  detail: Record<string, unknown>;
  created_at: Date;
};

export type ProductionActionInput = {
  job_id: string;
  action: ProductionAction;
  /** Made by the caller once per intended action. A repeat with the same key
   *  returns the first result and changes nothing. */
  idempotency_key: string;
  /** The `stage_version` the caller saw. Required when a person moves a job;
   *  the action is refused if the job has moved since. System callers may
   *  leave it out: they act on the job as it is under the lock. */
  expected_version?: number;
  actor: { type: "user" | "system"; id: string };
  /** When it happened, if entered later from the paper log. */
  happened_at?: Date | null;
  detail?: Record<string, unknown>;
};

export type ProductionActionResult = {
  event: ProductionEventRow;
  job: LabJobProductionState;
  /** True when the key had been used: nothing was written this time. */
  replayed: boolean;
};

/** One released window as the feed serves it: totals only. */
export type ReleasedWindow = {
  window_end: string;
  released_at: Date;
  usage: Array<{ id: string; sku: string; reason: string; net_qty: number }>;
  lab_totals: Array<{
    id: string;
    vendor: string;
    as_of: string;
    quoted_uninvoiced_satang: number;
    invoiced_to_date_satang: number;
  }>;
};

const JOB_PRODUCTION_COLUMNS = `"id", "order_id", "stage", "stage_since", "stage_version", "event_seq",
  "remake_count", "on_hold", "hold_reason", "cut_question_pending", "next_issue_reason"`;

/** The job columns an action may set besides the stage. Fixed here so no
 *  column name is ever built from input. */
const PATCHABLE = [
  "remake_count",
  "on_hold",
  "hold_reason",
  "cut_question_pending",
  "next_issue_reason",
] as const;

// The transaction manager Medusa hands a module: `execute(sql, params)`
// returns the rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sql = { execute: (sql: string, params?: unknown[]) => Promise<any[]> };

/** The columns the retention sweep needs — deliberately NOT the snapshot. */
export type LabJobRetentionRow = Pick<
  LabJobRow,
  "id" | "order_id" | "status" | "created_at" | "updated_at" | "rx_redacted_at"
>;

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
 * audit payloads, never expose it from the customer-facing Store API. The
 * plaintext Rx is blanked once the job no longer needs it (`redactJobRx`,
 * driven by the `redact-lab-job-rx` scheduled job).
 */
class LmsModuleService extends MedusaService({
  LabJob,
  ProductionEvent,
  LabUsage,
  LabCost,
  LabReleaseWindow,
  LabUsageRelease,
  LabTotalDay,
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
    // What actually reaches this code on a real database: Medusa's repository
    // turns the pg error into a MedusaError of type "invalid_data" with the
    // message "Lab job with order_id: ..., already exists." and no pg code
    // (`dbErrorMapper` in @medusajs/utils). Found by production.db.spec.ts;
    // the fake store in the unit tests throws the raw pg shape.
    if (
      e?.type === "invalid_data" &&
      typeof e?.message === "string" &&
      /^Lab job with order_id: .*, already exists\.$/.test(e.message)
    ) {
      return true;
    }
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
    const job = await this.insertJob(this.rowFieldsFromBuild(result));
    if (job.status === "queued") await this.markReadyForProduction(job.id);
    return job;
  }

  /** Create a queued lab_job row directly from a packet (happy path). */
  async createJob(packet: LabJobPacket): Promise<LabJobRow> {
    const job = await this.insertJob({
      order_id: packet.klear_order_id,
      status: "queued",
      packet_snapshot: packet as unknown as Record<string, unknown>,
      last_error: null,
    });
    if (job.status === "queued") await this.markReadyForProduction(job.id);
    return job;
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
    // Once the lab has started (printed or later) the stored packet is what
    // their sheet was printed from. Replacing it silently would leave the
    // two disagreeing with nothing in the history. A changed prescription on
    // a job in production is an RX_CHANGED event, which is not wired yet;
    // until it is, such a job is not rebuilt at all.
    if (current.stage && current.stage !== "ready") {
      throw new LabJobNotRebuildableError(
        `updateJobFromBuild: job ${jobId} is in production (${current.stage}) — its packet cannot be rebuilt`,
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
        // A rebuild may write the prescription back, so the row is no longer
        // "blanked"; the retention sweep will decide on it again. (The write
        // is MERGED into the stored snapshot, not a replacement: a rebuild
        // whose result has no `prescription` key, i.e. failed or pending_rx,
        // leaves whatever prescription the row already held.)
        rx_redacted_at: null,
        // A successful rebuild clears any stale provider error.
        ...(fields.status === "queued" ? { provider_job_id: null } : {}),
      },
    })) as unknown as LabJobRow[];
    if (!updated[0]) throw new Error(`updateJobFromBuild: job ${jobId} not found`);
    if (updated[0].status === "queued") await this.markReadyForProduction(jobId);
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
    // Oldest-first and capped: a page for the admin queue. NOT for sweeps:
    // a capped oldest-first page returns the same head set every time, so a
    // backlog of never-answered rows would hide every newer one. Sweeps use
    // `listAllJobIdsByStatus`.
    return (await this.listLabJobs(
      { status },
      { take: limit, order: { created_at: "ASC" } },
    )) as unknown as LabJobRow[];
  }

  /**
   * EVERY job in a status, oldest first, paged so none is skipped. Ids and
   * order ids only: the sweep that uses it rebuilds each job from the order,
   * so it never needs (or loads) the snapshot and its prescription.
   */
  async listAllJobIdsByStatus(
    status: LabJobStatusValue,
  ): Promise<Array<Pick<LabJobRow, "id" | "order_id" | "status">>> {
    const PAGE = 500;
    const out: Array<Pick<LabJobRow, "id" | "order_id" | "status">> = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = (await this.listLabJobs(
        { status },
        {
          select: ["id", "order_id", "status"],
          take: PAGE,
          skip,
          // id breaks created_at ties so paging never skips or repeats a row.
          order: { created_at: "ASC", id: "ASC" },
        },
      )) as unknown as Array<Pick<LabJobRow, "id" | "order_id" | "status">>;
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
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
    if (job.rx_redacted_at) {
      // The snapshot no longer holds the prescription. Sending it would give
      // the lab a job with no Rx; a rebuild restores it from the encrypted
      // record.
      throw new Error(
        `submitJob: job ${jobId} had its prescription blanked (retention) — rebuild via retry before submitting`,
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
      const done = await this.finishSubmission_(jobId, {
        status: "submitted",
        provider_job_id,
        provider_name: this.provider.name,
        attempts: job.attempts + 1,
        last_error: null,
        submitted_at: new Date(),
      });
      if (!done) return this.submissionOvertaken_(jobId, job);
      return { outcome: "submitted", job: done };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const truncated = message.slice(0, 500);

      if (
        err instanceof LabProviderError &&
        err.code === "not_implemented"
      ) {
        // Expected pre-lab-partner state — release the claim back to
        // queued, just count the attempt.
        const released = await this.finishSubmission_(jobId, {
          status: "queued",
          attempts: job.attempts + 1,
          last_error: truncated,
        });
        if (!released) return this.submissionOvertaken_(jobId, job);
        return { outcome: "queued_no_provider", job: released };
      }

      const failed = await this.finishSubmission_(jobId, {
        status: "failed",
        attempts: job.attempts + 1,
        last_error: truncated,
      });
      if (!failed) return this.submissionOvertaken_(jobId, job);
      return { outcome: "failed", job: failed };
    }
  }

  /**
   * Write the result of a provider call, but only onto a row that is still
   * `submitting`. A job cancelled while the provider call was in flight has
   * left that status; writing "submitted" or "queued" over it would undo the
   * cancel. Returns null when the row had moved.
   */
  private async finishSubmission_(
    jobId: string,
    data: Record<string, unknown>,
  ): Promise<LabJobRow | null> {
    const updated = (await this.updateLabJobs({
      selector: { id: jobId, status: "submitting" },
      data,
    })) as unknown as LabJobRow[];
    return updated[0] ?? null;
  }

  private async submissionOvertaken_(
    jobId: string,
    fallback: LabJobRow,
  ): Promise<{ outcome: "already_submitting"; job: LabJobRow }> {
    const current = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    return { outcome: "already_submitting", job: current ?? fallback };
  }

  /**
   * Every job whose snapshot may still hold a readable prescription
   * (`rx_redacted_at` is null), oldest first. Returns ids, status and dates
   * only: the retention sweep decides without ever loading a prescription.
   *
   * Live rows only. Like every MedusaService list, this skips soft-deleted
   * rows (and `updateLabJobs` cannot write to them). The only soft-deleted
   * lab jobs are the duplicates removed by Migration20260717000100;
   * Migration20261006000100 blanks those once. Nothing else soft-deletes a
   * lab job; if that ever changes, blank the prescription at the same time.
   */
  async listJobsHoldingRx(): Promise<LabJobRetentionRow[]> {
    const PAGE = 500;
    const out: LabJobRetentionRow[] = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = (await this.listLabJobs(
        { rx_redacted_at: null },
        {
          select: [
            "id",
            "order_id",
            "status",
            "created_at",
            "updated_at",
            "rx_redacted_at",
          ],
          take: PAGE,
          skip,
          // id breaks created_at ties so paging never skips or repeats a row.
          order: { created_at: "ASC", id: "ASC" },
        },
      )) as unknown as LabJobRetentionRow[];
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  }

  /**
   * Blank the readable prescription in a job's snapshot and stamp
   * `rx_redacted_at`. Everything else in the snapshot is kept.
   *
   * Returns false (and writes nothing) when there is nothing to do or the
   * job moved underneath us: already blanked, mid-submission, or its status
   * changed between the read and the guarded write. The caller decides WHEN
   * (see `rx-retention.ts`); this only refuses the one state where blanking
   * would corrupt a submission in flight. A row orphaned in `submitting`
   * (past the grace period) is not in flight and is blanked like any other.
   *
   * Known narrow race: MedusaService resolves a selector to ids, then
   * updates (see the claim in `submitJob`). A rebuild landing in the few
   * milliseconds between this method's read and write can leave a fresh
   * prescription under a set stamp. `submitJob` then refuses the job until
   * the next rebuild, which also clears the stamp. The daily sweep (20:15
   * UTC) and the half-hourly heal job (:00, :30) never overlap, so only a
   * manual retry at that minute can hit it.
   *
   * Not reversible in place. A job that needs its prescription again gets it
   * from the encrypted record through the retry (rebuild) path.
   */
  async redactJobRx(jobId: string): Promise<boolean> {
    const job = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    if (!job) throw new Error(`redactJobRx: job ${jobId} not found`);
    if (job.rx_redacted_at) return false;
    if (isSubmissionInFlight(job, new Date())) return false;

    // Guarded on the status we read and on still-not-blanked, like the submit
    // claim: if the job was claimed for submission (or blanked by another
    // run) in between, the selector matches nothing.
    //
    // `packet_snapshot` here is a PATCH, not a replacement: Medusa's
    // repository assigns JSON columns with `mergeObjectProperties`, so only
    // the `prescription` key is overwritten and every other key keeps the
    // value in the row. Writing back a full copy of what we read would put
    // stale keys over a rebuild that landed in between.
    const updated = (await this.updateLabJobs({
      selector: { id: jobId, status: job.status, rx_redacted_at: null },
      data: { packet_snapshot: { prescription: null }, rx_redacted_at: new Date() },
    })) as unknown as LabJobRow[];
    return updated.length > 0;
  }

  /** Mark a queued / failed / pending_rx / submitted job as cancelled.
   *  Called when the customer cancels before lab production starts. */
  async cancelJob(jobId: string): Promise<LabJobRow> {
    // Through the production writer, so the stage, the status and the
    // history say the same thing. Refused (not_allowed) once a shipping
    // label exists.
    try {
      await this.applyProductionAction({
        job_id: jobId,
        action: "CANCELLED",
        idempotency_key: `cancel:${jobId}`,
        actor: { type: "system", id: "cancel-job" },
      });
    } catch (err) {
      // Already cancelled by another caller (a subscriber, the migration):
      // that is what was asked for. Anything else stands.
      const row = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
      if (
        !(err instanceof ProductionError && err.code === "not_allowed" && row?.stage === "cancelled")
      ) {
        throw err;
      }
      return row;
    }
    return (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
  }

  // ── Production ──────────────────────────────────────────────────────────

  /**
   * Record one production action on a job: the ONLY writer of `stage`, of
   * `production_event`, of `lab_usage` and of `lab_cost`.
   *
   * One transaction:
   *   1. lock the job row, so actions on one job happen one at a time;
   *   2. if the idempotency key was already used, return that first result;
   *   3. refuse if the caller's `expected_version` is not the job's;
   *   4. ask the rules (`production.ts`) what the action does;
   *   5. write the job's new state, the event, and any usage or cost rows.
   * Anything thrown rolls all of it back.
   *
   * Throws `ProductionError` (`not_found`, `conflict`, `not_allowed`,
   * `invalid_detail`, `key_reused`).
   */
  async applyProductionAction(
    input: ProductionActionInput,
  ): Promise<ProductionActionResult> {
    const { job_id, action, actor } = input;
    const key = input.idempotency_key;
    if (!(ACTIONS as readonly string[]).includes(action)) {
      throw new ProductionError("invalid_detail", `unknown action ${String(action)}`);
    }
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      throw new ProductionError(
        "invalid_detail",
        "an idempotency key of 8 to 200 characters is required",
      );
    }
    if (!actor || (actor.type !== "user" && actor.type !== "system") || !actor.id) {
      throw new ProductionError("invalid_detail", "the action must say who did it");
    }
    if (actor.type === "user" && SYSTEM_ONLY_ACTIONS.has(action)) {
      throw new ProductionError(
        "not_allowed",
        `${action} is recorded by the system, not by a person`,
      );
    }
    const isStageAction = (STAGE_ACTIONS as readonly string[]).includes(action);
    if (isStageAction && actor.type === "user" && input.expected_version === undefined) {
      throw new ProductionError(
        "invalid_detail",
        "expected_version is required to move a job",
      );
    }
    if (typeof actor.id !== "string" || typeof job_id !== "string") {
      throw new ProductionError("invalid_detail", "ids must be text");
    }
    if (input.expected_version !== undefined && !Number.isInteger(input.expected_version)) {
      throw new ProductionError("invalid_detail", "expected_version must be a whole number");
    }
    const happenedAt = input.happened_at ?? null;
    if (
      happenedAt &&
      (!(happenedAt instanceof Date) ||
        Number.isNaN(happenedAt.getTime()) ||
        happenedAt.getTime() > Date.now() + 60_000)
    ) {
      throw new ProductionError("invalid_detail", "happened_at must be a time in the past");
    }
    const detailIn = input.detail ?? {};
    if (typeof detailIn !== "object" || Array.isArray(detailIn)) {
      throw new ProductionError("invalid_detail", "detail must be an object");
    }
    const requestHash = createHash("sha256")
      .update(stableJson({ detail: detailIn, happened_at: happenedAt?.toISOString() ?? null }))
      .digest("hex");

    try {
      return await this.recordProductionAction_(input, isStageAction, happenedAt, requestHash);
    } catch (err) {
      if (err instanceof ProductionError) throw err;
      throw new ProductionWriteError(err);
    }
  }

  /**
   * The transaction behind `applyProductionAction`. It opens its OWN
   * transaction and does not join a caller's: never call the writer from
   * inside another transaction that has already written this job's row (it
   * would wait on its caller; `lock_timeout` turns that into an error after
   * five seconds instead of a hang).
   */
  private async recordProductionAction_(
    input: ProductionActionInput,
    isStageAction: boolean,
    happenedAt: Date | null,
    requestHash: string,
  ): Promise<ProductionActionResult> {
    const { job_id, action, actor } = input;
    const key = input.idempotency_key;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      await em.execute(`set local lock_timeout = '5s'`);
      const [job] = await em.execute(
        `select ${JOB_PRODUCTION_COLUMNS}, "status", "rx_redacted_at"
           from "lab_job" where "id" = ? and "deleted_at" is null for update`,
        [job_id],
      );
      if (!job) throw new ProductionError("not_found", `lab job ${job_id} not found`);

      const [prior] = await em.execute(
        `select * from "production_event" where "idempotency_key" = ?`,
        [key],
      );
      if (prior) {
        if (
          prior.lab_job_id !== job_id ||
          prior.action !== action ||
          (prior.request_hash !== null && prior.request_hash !== requestHash)
        ) {
          throw new ProductionError(
            "key_reused",
            "that idempotency key was used for a different action",
          );
        }
        return { event: prior, job: productionState(job), replayed: true };
      }

      if (
        isStageAction &&
        input.expected_version !== undefined &&
        input.expected_version !== job.stage_version
      ) {
        throw new ProductionError(
          "conflict",
          `the job has moved (it is ${job.stage ?? "not ready"}); reload and try again`,
        );
      }
      // READY and PRINTED need a built packet. A job can be at `ready` with
      // its packet un-built again (a retry whose rebuild now waits for a
      // prescription); the lab must not start on it, and while it stays at
      // `ready` it can still be rebuilt.
      if (
        (action === "READY" || action === "PRINTED") &&
        job.status !== "queued" &&
        job.status !== "submitting" &&
        job.status !== "submitted"
      ) {
        throw new ProductionError(
          "not_allowed",
          `a job whose packet is ${job.status} is not ready for production`,
        );
      }
      // A warranty remake needs the prescription back in the packet first
      // (it is blanked some time after delivery). The caller rebuilds it.
      if (action === "REMAKE_STARTED" && job.rx_redacted_at && job.stage !== "qc_failed") {
        throw new ProductionError(
          "not_allowed",
          "the prescription was removed from this job after delivery; rebuild the packet before starting a remake",
        );
      }

      const state: JobState = {
        stage: job.stage,
        remake_count: job.remake_count,
        on_hold: job.on_hold,
        cut_question_pending: job.cut_question_pending,
        next_issue_reason: job.next_issue_reason,
      };
      const effect = decide(state, action, input.detail ?? {});

      // An action that records usage or touches a lab quote shares the
      // release's lock (the release takes the exclusive side): the release
      // waits for it, and it waits for a release in progress. The clock is
      // read only after the lock is held. Other actions (READY, a note, a
      // hold) feed nothing into a release and do not wait for one.
      if (
        effect.usage.length > 0 ||
        effect.return_lenses ||
        effect.open_cost ||
        effect.receive_cost ||
        effect.invoice_cost
      ) {
        await em.execute(`select pg_advisory_xact_lock_shared(hashtext('lms_usage_release'))`);
      }
      const now = new Date();
      const seq = job.event_seq + 1;
      const sets: string[] = [`"event_seq" = ?`];
      const params: unknown[] = [seq];
      if (effect.to_stage) {
        sets.push(
          `"stage" = ?`,
          `"stage_since" = ?`,
          `"stage_version" = "stage_version" + 1`,
        );
        params.push(effect.to_stage, now);
      }
      for (const column of PATCHABLE) {
        if (column in effect.patch) {
          sets.push(`"${column}" = ?`);
          params.push((effect.patch as Record<string, unknown>)[column]);
        }
      }
      // A cancelled job's packet is cancelled too, in the same write, so
      // nothing later submits or rebuilds it.
      if (effect.cancel_status) sets.push(`"status" = 'cancelled'`);
      // Guarded on the version read under the lock: belt and braces, and it
      // keeps the write correct even if a caller ever drops the lock.
      const updated = await em.execute(
        `update "lab_job" set ${sets.join(", ")}
          where "id" = ? and "stage_version" = ? and "event_seq" = ?
          returning ${JOB_PRODUCTION_COLUMNS}`,
        [...params, job_id, job.stage_version, job.event_seq],
      );
      if (updated.length !== 1) {
        throw new ProductionError(
          "conflict",
          "the job changed while the action was being recorded; try again",
        );
      }

      const eventId = generateEntityId(undefined, "prodevt");
      const [event] = await em.execute(
        `insert into "production_event"
           ("id", "lab_job_id", "seq", "action", "from_stage", "to_stage", "idempotency_key",
            "actor_type", "actor_id", "happened_at", "detail", "request_hash",
            "created_at", "updated_at")
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
         returning *`,
        [
          eventId,
          job_id,
          seq,
          action,
          job.stage,
          effect.to_stage ?? null,
          key,
          actor.type,
          actor.id,
          happenedAt,
          JSON.stringify(effect.detail),
          requestHash,
          now,
          now,
        ],
      );

      const usage = [...effect.usage];
      if (effect.return_lenses) {
        // Each lens going back must be one of the LATEST issue: that is the
        // issue the open question is about. Lenses of earlier issues were
        // cut or spoiled. The question closes with this action, so the same
        // issue can never be returned twice.
        const held = await em.execute(
          `select u."sku", (-sum(u."qty"))::int as "held" from "lab_usage" u
            where u."production_event_id" = (
              select e."id" from "production_event" e
               where e."lab_job_id" = ? and e."action" = 'LENS_ISSUED'
               order by e."seq" desc limit 1)
            group by u."sku"`,
          [job_id],
        );
        const available = new Map<string, number>(
          held.map((r: { sku: string; held: number }) => [r.sku, Number(r.held)]),
        );
        for (const s of effect.return_lenses) {
          const left = available.get(s) ?? 0;
          if (left < 1) {
            throw new ProductionError(
              "not_allowed",
              "a lens can only be returned if it is one of the lenses last issued on this job",
            );
          }
          available.set(s, left - 1);
          usage.push({ sku: s, reason: "return_unused", qty: 1 });
        }
      }
      // A usage row belongs to the window in which it is entered, and must
      // never land in a window already released (it would be left out for
      // good). Normally "today" is after every released window; if this
      // process's clock is behind the releasing one's, the day after the
      // last released window is used instead.
      let enteredOn = bangkokDate(now);
      if (usage.length > 0) {
        const [lastWindow] = await em.execute(
          `select "window_end" from "lab_release_window" order by "window_end" desc limit 1`,
        );
        if (lastWindow && lastWindow.window_end >= enteredOn) {
          enteredOn = addDays(lastWindow.window_end, 1);
        }
      }
      for (const line of usage) {
        await em.execute(
          `insert into "lab_usage"
             ("id", "lab_job_id", "production_event_id", "sku", "reason", "qty", "entered_on",
              "created_at", "updated_at")
           values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            generateEntityId(undefined, "labuse"),
            job_id,
            eventId,
            line.sku,
            line.reason,
            line.qty,
            enteredOn,
            now,
            now,
          ],
        );
      }

      if (effect.open_cost) {
        await em.execute(
          `insert into "lab_cost"
             ("id", "lab_job_id", "vendor", "quoted_satang", "expected_on", "sent_event_id",
              "created_at", "updated_at")
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            generateEntityId(undefined, "labcost"),
            job_id,
            effect.open_cost.vendor,
            effect.open_cost.quoted_satang,
            effect.open_cost.expected_on,
            eventId,
            now,
            now,
          ],
        );
      }
      if (effect.receive_cost) {
        const received = await em.execute(
          `update "lab_cost" set "received_at" = ?, "updated_at" = ?
            where "id" = (select "id" from "lab_cost"
                           where "lab_job_id" = ? and "received_at" is null and "deleted_at" is null
                           order by "created_at" desc, "id" desc limit 1)
            returning "id"`,
          [now, now, job_id],
        );
        if (received.length !== 1) {
          throw new ProductionError(
            "not_allowed",
            "this job has no open quote from an outside lab",
          );
        }
      }
      if (effect.invoice_cost) {
        // A quote whose work came back before one whose work did not (a
        // job re-sent after a changed prescription leaves the first quote
        // open and unreceived); within that, oldest first.
        const invoiced = await em.execute(
          `update "lab_cost" set "invoiced_satang" = ?, "invoiced_at" = ?, "updated_at" = ?
            where "id" = (select "id" from "lab_cost"
                           where "lab_job_id" = ? and "invoiced_satang" is null and "deleted_at" is null
                           order by ("received_at" is null) asc, "created_at" asc, "id" asc limit 1)
            returning "id"`,
          [effect.invoice_cost.invoiced_satang, now, now, job_id],
        );
        if (invoiced.length !== 1) {
          throw new ProductionError(
            "not_allowed",
            "this job has no lab quote waiting for an invoice",
          );
        }
      }

      return { event, job: productionState(updated[0]), replayed: false };
    });
  }

  /**
   * Put a job whose packet has just been built at `ready`. Does nothing if
   * the job already has a stage (a rebuild of a job in production is an
   * RX_CHANGED, recorded by its own caller).
   */
  async markReadyForProduction(jobId: string): Promise<boolean> {
    try {
      const r = await this.applyProductionAction({
        job_id: jobId,
        action: "READY",
        idempotency_key: `ready:${jobId}`,
        actor: { type: "system", id: "packet-build" },
      });
      return !r.replayed;
    } catch (err) {
      if (err instanceof ProductionError && err.code === "not_allowed") return false;
      // NEVER rethrown. The job row is already saved; failing here would
      // stop the hand-off (the order-placed subscriber, the retry route, the
      // heal sweep) over a stage that `markStagelessJobsReady` sets on its
      // next pass anyway. The error holds ids only (see ProductionWriteError).
      console.error(
        `[lms] could not put lab job ${jobId} at ready: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      );
      captureException(err, {
        tags: { module: "lms", reason: "mark_ready_failed" },
        extra: { lab_job_id: jobId },
      });
      return false;
    }
  }

  /**
   * Give a stage to recent jobs whose packet is built and that have none:
   * a READY write that failed, or a job created by the previous deployment
   * while this one was starting. Run by the `heal-pending-rx` job. Returns
   * how many it set.
   */
  async markStagelessJobsReady(pageSize = 500): Promise<number> {
    const since = new Date(Date.now() - STAGELESS_SWEEP_DAYS * 24 * 3600 * 1000);
    // The whole list first, then the writes: a job that cannot be set stays
    // in the list, so paging while writing would either skip rows or return
    // the same failing head for ever.
    const ids: string[] = [];
    for (let skip = 0; ; skip += pageSize) {
      const page = (await this.listLabJobs(
        {
          status: ["queued", "submitting", "submitted"],
          stage: null,
          created_at: { $gt: since },
        },
        { select: ["id"], take: pageSize, skip, order: { created_at: "ASC", id: "ASC" } },
      )) as unknown as Array<{ id: string }>;
      ids.push(...page.map((r) => r.id));
      if (page.length < pageSize) break;
    }
    let set = 0;
    for (const id of ids) {
      if (await this.markReadyForProduction(id)) set++;
    }
    return set;
  }

  // ── Release to Klear Operations ─────────────────────────────────────────

  /**
   * Release every window that has ended and has not been released: the
   * window's marker, its usage totals per SKU and reason, and the lab totals
   * as of its last day, all in one transaction per run. Safe to run as often
   * as you like and from two processes at once (an advisory lock makes them
   * take turns; the second finds nothing left to do).
   *
   * A window's rows are written once and never change. A usage row entered
   * later belongs to the window in which it was ENTERED (`entered_on`), so
   * nothing can arrive for a window after its release.
   */
  async releaseDueWindows(
    now: Date = new Date(),
    weekday: number = releaseWeekday(),
  ): Promise<ReleaseWindow[]> {
    const today = bangkokDate(now);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      await em.execute(`set local lock_timeout = '5s'`);
      await em.execute(`select pg_advisory_xact_lock(hashtext('lms_usage_release'))`);

      const [last] = await em.execute(
        `select "window_end" from "lab_release_window" order by "window_end" desc limit 1`,
      );
      // Production starts with the first event; there is nothing to release,
      // and no window to mark, before that.
      const [first] = await em.execute(
        `select to_char(min("created_at") at time zone 'Asia/Bangkok', 'YYYY-MM-DD') as "day"
           from "production_event"`,
      );
      if (!last && !first?.day) return [];

      const windows = dueWindows(last?.window_end ?? null, first?.day ?? today, today, weekday);
      for (const w of windows) {
        await em.execute(
          `insert into "lab_release_window"
             ("id", "window_start", "window_end", "released_at", "created_at", "updated_at")
           values (?, ?, ?, ?, ?, ?)`,
          [generateEntityId(undefined, "labwin"), w.window_start, w.window_end, now, now, now],
        );
        await em.execute(
          `insert into "lab_usage_release"
             ("id", "window_end", "sku", "reason", "net_qty", "created_at", "updated_at")
           select 'labrel_' || replace(gen_random_uuid()::text, '-', ''), ?, u."sku", u."reason",
                  sum(u."qty")::int, ?, ?
             from "lab_usage" u
            where u."entered_on" >= ? and u."entered_on" <= ?
            group by u."sku", u."reason"
           having sum(u."qty") <> 0`,
          [w.window_end, now, now, w.window_start, w.window_end],
        );
        // Lab totals as of the end of the window's last day in Bangkok.
        const cutoff = `${addDays(w.window_end, 1)}T00:00:00+07:00`;
        await em.execute(
          `insert into "lab_total_day"
             ("id", "vendor", "as_of", "quoted_uninvoiced_satang", "invoiced_to_date_satang",
              "created_at", "updated_at")
           select 'labtot_' || replace(gen_random_uuid()::text, '-', ''), c."vendor_key", ?,
                  coalesce(sum(c."quoted_satang") filter (
                    where c."received_at" < ?::timestamptz
                      and (c."invoiced_at" is null or c."invoiced_at" >= ?::timestamptz)), 0)::int,
                  coalesce(sum(c."invoiced_satang") filter (
                    where c."invoiced_at" < ?::timestamptz), 0)::int,
                  ?, ?
             from (select *, lower(btrim(regexp_replace("vendor", '\\s+', ' ', 'g'))) as "vendor_key"
                     from "lab_cost") c
            where c."deleted_at" is null and c."created_at" < ?::timestamptz
            group by c."vendor_key"`,
          [w.window_end, cutoff, cutoff, cutoff, now, now, cutoff],
        );
      }
      return windows;
    });
  }

  /**
   * A check, not a repair: how many released totals (window, SKU, reason)
   * disagree with the usage rows dated inside that window. Zero when every
   * piece is accounted for. Anything else means a row was written into a
   * window after its release (the writer is built so that cannot happen) or
   * a table was changed by hand, and Klear Operations has been told the
   * wrong totals. It stays non-zero until the cause is dealt with.
   */
  async unreleasedUsageDrift(): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      const [row] = await em.execute(
        `with used as (
           select w."window_end", u."sku", u."reason", sum(u."qty") as "qty"
             from "lab_usage" u
             join "lab_release_window" w
               on u."entered_on" >= w."window_start" and u."entered_on" <= w."window_end"
            group by 1, 2, 3
           having sum(u."qty") <> 0
         )
         select count(*)::int as "drift"
           from used
           full join "lab_usage_release" r
             on r."window_end" = used."window_end" and r."sku" = used."sku"
            and r."reason" = used."reason"
          where used."qty" is distinct from r."net_qty"`,
      );
      return Number(row?.drift ?? 0);
    });
  }

  /**
   * Released windows after a given window end, oldest first, each complete.
   * This is everything the feed to Klear Operations serves: no job, order,
   * day or time appears in it.
   */
  async listReleasedWindows(after: string | null, limit = 50): Promise<ReleasedWindow[]> {
    const take = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const windows = (await this.listLabReleaseWindows(
      after ? { window_end: { $gt: after } } : {},
      { select: ["window_end", "released_at"], take, order: { window_end: "ASC" } },
    )) as unknown as Array<{ window_end: string; released_at: Date }>;
    if (windows.length === 0) return [];
    const ends = windows.map((w) => w.window_end);
    const usage = (await this.listLabUsageReleases(
      { window_end: ends },
      { select: ["id", "window_end", "sku", "reason", "net_qty"], take: null, order: { id: "ASC" } },
    )) as unknown as Array<{ id: string; window_end: string; sku: string; reason: string; net_qty: number }>;
    const totals = (await this.listLabTotalDays(
      { as_of: ends },
      {
        select: ["id", "vendor", "as_of", "quoted_uninvoiced_satang", "invoiced_to_date_satang"],
        take: null,
        order: { id: "ASC" },
      },
    )) as unknown as ReleasedWindow["lab_totals"];
    return windows.map((w) => ({
      window_end: w.window_end,
      released_at: w.released_at,
      usage: usage
        .filter((u) => u.window_end === w.window_end)
        .map(({ id, sku, reason, net_qty }) => ({ id, sku, reason, net_qty })),
      lab_totals: totals
        .filter((t) => t.as_of === w.window_end)
        .map(({ id, vendor, as_of, quoted_uninvoiced_satang, invoiced_to_date_satang }) => ({
          id,
          vendor,
          as_of,
          quoted_uninvoiced_satang,
          invoiced_to_date_satang,
        })),
    }));
  }

  /** A job's production history, oldest first. */
  async listProductionEventsForJob(jobId: string): Promise<ProductionEventRow[]> {
    return (await this.listProductionEvents(
      { lab_job_id: jobId },
      { order: { seq: "ASC" }, take: 1000 },
    )) as unknown as ProductionEventRow[];
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

/** JSON with object keys in a fixed order, so equal contents hash equally. */
function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // A key whose value is undefined is the same request as no key at all.
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function productionState(row: Record<string, unknown>): LabJobProductionState {
  return {
    id: row.id as string,
    order_id: row.order_id as string,
    stage: (row.stage ?? null) as Stage | null,
    stage_since: (row.stage_since ?? null) as Date | null,
    stage_version: row.stage_version as number,
    event_seq: row.event_seq as number,
    remake_count: row.remake_count as number,
    on_hold: row.on_hold as boolean,
    hold_reason: (row.hold_reason ?? null) as string | null,
    cut_question_pending: row.cut_question_pending as boolean,
    next_issue_reason: row.next_issue_reason as string,
  };
}

export default LmsModuleService;
