import { createHash } from "crypto";
import { MedusaService, generateEntityId } from "@medusajs/framework/utils";
import { captureException } from "../../lib/observability/sentry";
import { errorKind } from "../../lib/observability/error-kind";
import LabJob from "./models/lab-job";
import ProductionEvent from "./models/production-event";
import LabUsage from "./models/lab-usage";
import LabCost from "./models/lab-cost";
import LabReleaseWindow from "./models/lab-release-window";
import LabUsageRelease from "./models/lab-usage-release";
import LabTotalDay from "./models/lab-total-day";
import LensStockSnapshot from "./models/lens-stock-snapshot";
import { addDays, dueWindows, releaseWeekday, type ReleaseWindow } from "./release";
import { packetProblem, reportFrom } from "./board";
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
  packetForbids,
  writeOffRefusal,
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

/** The shape of an idempotency key a person's request may carry. No colon:
 *  that is how the system's own keys are told apart. */
export const PERSON_KEY = /^[A-Za-z0-9._-]{8,200}$/;

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
  constructor(cause: unknown, what = "the production action could not be recorded") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = cause as any;
    // Only what has the shape of an error code or of a constraint's name.
    const code = typeof e?.code === "string" && /^[A-Z0-9_]{1,12}$/.test(e.code) ? e.code : null;
    const constraint =
      typeof e?.constraint === "string" && /^[A-Za-z0-9_]{1,63}$/.test(e.constraint)
        ? e.constraint
        : null;
    // Medusa rewrites some driver errors (unique, not-null, foreign key)
    // into its own error with no code. Its `type` and class name hold no
    // values, so they are safe to pass on; its message is not.
    const kind = [e?.type, e?.name ?? e?.constructor?.name]
      .filter((v) => typeof v === "string" && /^[A-Za-z_]{1,40}$/.test(v))
      .join("/");
    super(
      `${what} (database error ${code ?? (kind || "unknown")}${
        constraint ? `, constraint ${constraint}` : ""
      })`,
    );
    this.name = "ProductionWriteError";
    this.code = code;
  }
}

/**
 * A failure, for a log line, as the routes word it: our own write error's
 * text (built from codes only, see above), and for anything else its kind
 * (`errorKind`), never its message.
 */
export function failureKind(err: unknown): string {
  return err instanceof ProductionWriteError ? err.message : errorKind(err);
}

/**
 * The error to hand to Sentry for a failure, as `sendProductionError` does:
 * our own write error as it is, anything else replaced by a new error that
 * names where it failed and its kind. An exception's message is the one
 * thing the Sentry scrubber cannot clean, so a driver's own text never
 * reaches it.
 */
export function reportableError(err: unknown, where: string): Error {
  return err instanceof ProductionWriteError ? err : new Error(`${where} failed: ${failureKind(err)}`);
}

/** A lens snapshot from Klear Operations that cannot be taken: it is older
 *  than the one held, or its date is not one usage has been released up
 *  to (so "issued since" would count some lenses twice or not at all). */
export class LensSnapshotRefused extends Error {
  readonly code: "older_than_stored" | "not_a_release" | "not_yet_closed";
  constructor(code: "older_than_stored" | "not_a_release" | "not_yet_closed") {
    super(
      code === "older_than_stored"
        ? "a newer lens snapshot is already held"
        : code === "not_yet_closed"
          ? "as_of must be a day that has already ended in Bangkok"
          : "as_of must be the end of a released usage window",
    );
    this.name = "LensSnapshotRefused";
    this.code = code;
  }
}

export type LensStockRow = {
  sku: string;
  /** Operations' figure, as of `as_of`. */
  on_hand_at_release: number;
  as_of: string;
  /** Net usage entered after `as_of`: issues count -1, an uncut lens put
   *  back +1. */
  used_since: number;
  /** What the lab should find on the shelf now. */
  available: number;
};

/** A second live job for the same order was refused by the unique index.
 *  Carries nothing of the row. */
export class LabJobDuplicateError extends Error {
  constructor() {
    super("a lab job for that order already exists");
    this.name = "LabJobDuplicateError";
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
  /** When it was put back to start a warranty remake; null if never. */
  rx_restored_at: Date | null;
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
  /**
   * A warranty remake on a job whose readable prescription was removed: the
   * packet, freshly built from the order, to put back. Stored in the same
   * transaction as the REMAKE_STARTED event, so the prescription is back
   * only if the remake is recorded, and the event says it was put back.
   * Accepted only with REMAKE_STARTED on a labelled or delivered job whose
   * packet is ours to rewrite (`queued`) and is blanked.
   */
  restore_packet?: LabJobPacket;
};

export type ProductionActionResult = {
  event: ProductionEventRow;
  job: LabJobProductionState;
  /** True when the key had been used: nothing was written this time. */
  replayed: boolean;
};

/** Stages at which the lab still has work on a job. */
const QUEUE_STAGES = [
  "ready",
  "printed",
  "lens_issued",
  "sent_to_lab",
  "received_from_lab",
  "edged",
  "mounted",
  "qc_passed",
  "qc_failed",
  "packed",
  "labelled",
] as const;

/** The most jobs the queue returns. Past it the board says so. */
export const QUEUE_LIMIT = 1000;

/** What the queue board is given about a job. Not the packet. */
const QUEUE_COLUMNS = [
  "id",
  "order_id",
  "status",
  "last_error",
  "stage",
  "stage_since",
  "stage_version",
  "remake_count",
  "on_hold",
  "hold_reason",
  "cut_question_pending",
  "created_at",
] as const;

export type LabJobQueueRow = Pick<LabJobRow, (typeof QUEUE_COLUMNS)[number]>;

/** The most jobs the report lists. */
const REPORT_JOBS = 200;

// The report's two quote states, as SQL over `lab_cost c`. The same states
// as `quoteState` in production.ts. The second takes the period's first
// day as a parameter.
const BACK_NOT_INVOICED = `(c."received_at" is not null and c."invoiced_satang" is null and c."written_off_at" is null)`;
const WRITTEN_OFF_IN_PERIOD = `(c."written_off_at" is not null and c."invoiced_satang" is null
  and (c."written_off_at" at time zone 'Asia/Bangkok')::date >= cast(? as date))`;

/** The lab's report: counts per week and per job. No SKU, no packet. */
export type ProductionReport = {
  /** The first day covered, a Monday in Bangkok. */
  from: string;
  /** Newest week first. Only weeks in which something happened. */
  weeks: Array<{
    week_start: string;
    issued_for_orders: number;
    spoilage_replacements: number;
    remake_lenses: number;
    frames_spoiled: number;
    returned_unused: number;
    qc_failed: number;
    remakes_started: number;
    /** Replacement lenses per lens issued for an order; null with none issued. */
    spoilage_rate: number | null;
    remake_rate: number | null;
  }>;
  /** Outside-lab quotes per lab, grouped as the release groups them and
   *  named by the lab's most recent spelling. `back_not_invoiced`: work back, invoice awaited, whatever its
   *  age. `written_off`: written off within the period and not invoiced
   *  since. Counts and quoted amounts only; never a reason. */
  quotes: Array<{
    vendor: string;
    back_not_invoiced: number;
    back_not_invoiced_satang: number;
    written_off: number;
    written_off_satang: number;
  }>;
  /** True when more jobs used a lens in the period than are listed. */
  jobs_truncated: boolean;
  /** Jobs that used a lens in the period, 200 at most: those with the most
   *  lenses beyond what their remakes explain first, then the most lenses. */
  jobs: Array<{
    lab_job_id: string;
    order_id: string;
    stage: string | null;
    remake_count: number;
    lenses_issued: number;
    lenses_returned: number;
    unexplained: number;
  }>;
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
    written_off_satang: number;
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
  | "id"
  | "order_id"
  | "status"
  | "created_at"
  | "updated_at"
  | "rx_redacted_at"
  | "rx_restored_at"
  | "stage"
  | "stage_since"
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
  LensStockSnapshot,
}) {
  private readonly provider: ILabProvider = new UnimplementedLabProvider();

  // Every insert and update of a lab job goes through these two. When one
  // fails, the driver's error message is the SQL with its values written
  // in, and for a lab job that is the whole packet: prescription, name,
  // phone, address. Callers log such errors and send them to Sentry, whose
  // scrubber cannot clean an error's message. So the original error never
  // leaves this class: it is replaced by one built from the error code.
  // Nothing else in this class may call createLabJobs or updateLabJobs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async saveNewJob_(data: any): Promise<any> {
    try {
      return await this.createLabJobs(data);
    } catch (err) {
      if (this.isUniqueViolation(err)) throw new LabJobDuplicateError();
      throw new ProductionWriteError(err, "the lab job could not be saved");
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async saveJobChange_(change: any): Promise<any> {
    try {
      return await this.updateLabJobs(change);
    } catch (err) {
      throw new ProductionWriteError(err, "the lab job could not be saved");
    }
  }

  /**
   * Detects a Postgres unique-constraint violation (SQLSTATE 23505) however
   * MikroORM/pg wraps it, so concurrent duplicate inserts can be treated as
   * "already created" rather than crashing the subscriber.
   */
  private isUniqueViolation(err: unknown): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = err as any;
    if (err instanceof LabJobDuplicateError) return true;
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
    // Nothing else. The error's free text is never searched: the driver's
    // message is the INSERT with the packet written in, so a phone number
    // containing 23505, or a customer called "Unique Constraint", would turn
    // any failed insert into "already exists".
    return false;
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
      const created = (await this.saveNewJob_({
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
      const updated = (await this.saveJobChange_({
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
    const updated = (await this.saveJobChange_({
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
    const claimed = (await this.saveJobChange_({
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
    const updated = (await this.saveJobChange_({
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
            "rx_restored_at",
            "stage",
            "stage_since",
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
    const updated = (await this.saveJobChange_({
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
    // The system's own keys are made from ids with a colon ("ready:<job>",
    // "cancelled:<order>"). A person's key may not look like one: a key is
    // unique across all jobs, so a person who used "ready:<job>" for a note
    // would stop that job from ever being put at ready.
    if (actor.type === "user" && !PERSON_KEY.test(key)) {
      throw new ProductionError(
        "invalid_detail",
        "an idempotency key may hold letters, digits, dot, dash and underscore only",
      );
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
    // A write-off is a judgement made on what the screen showed, so it is
    // held to the job's version like a step that moves the job.
    const versioned = isStageAction || action === "LAB_QUOTE_WRITTEN_OFF";
    if (versioned && !isStageAction && actor.type === "user" && input.expected_version === undefined) {
      throw new ProductionError(
        "invalid_detail",
        "expected_version is required to write off a lab quote",
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
      return await this.recordProductionAction_(input, versioned, happenedAt, requestHash);
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
    versioned: boolean,
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
        versioned &&
        input.expected_version !== undefined &&
        input.expected_version !== job.stage_version
      ) {
        throw new ProductionError(
          "conflict",
          `the job has moved (it is ${job.stage ?? "not ready"}); reload and try again`,
        );
      }
      // A prescription to put back for a warranty remake: only where that
      // is what is happening.
      const restoring = input.restore_packet !== undefined;
      if (restoring) {
        const p = input.restore_packet as unknown;
        if (p === null || typeof p !== "object" || Array.isArray(p)) {
          throw new ProductionError("invalid_detail", "the packet to put back is not a packet");
        }
        if (action !== "REMAKE_STARTED" || (job.stage !== "labelled" && job.stage !== "delivered")) {
          throw new ProductionError(
            "not_allowed",
            "a prescription is only put back to start a remake on a labelled or delivered job",
          );
        }
        if (job.status !== "queued") {
          throw new ProductionError(
            "not_allowed",
            `the packet of this job is ${job.status}; its prescription cannot be put back here`,
          );
        }
        if (!job.rx_redacted_at) {
          throw new ProductionError("not_allowed", "this job's packet still has its prescription");
        }
      }
      // Whether there is a packet to work from (see `packetForbids`).
      const forbidden = packetForbids(restoring ? { ...job, rx_redacted_at: null } : job, action);
      if (forbidden) throw new ProductionError("not_allowed", forbidden);

      const state: JobState = {
        stage: job.stage,
        remake_count: job.remake_count,
        on_hold: job.on_hold,
        cut_question_pending: job.cut_question_pending,
        next_issue_reason: job.next_issue_reason,
      };
      const effect = decide(state, action, input.detail ?? {});

      // The quote a write-off or an invoice lands on, read before anything
      // is written so the event can say which. Quotes are written only
      // here, under the job's lock, so what is read stays true until the
      // write below.
      let writeOffTarget: { id: string } | null = null;
      if (effect.write_off_cost) {
        const [quote] = await em.execute(
          `select "id", "vendor", "quoted_satang", "received_at", "invoiced_satang", "written_off_at"
             from "lab_cost" where "id" = ? and "lab_job_id" = ? and "deleted_at" is null`,
          [effect.write_off_cost.lab_cost_id, job_id],
        );
        if (!quote) throw new ProductionError("quote_not_found", "this job has no such lab quote");
        const refusal = writeOffRefusal(quote);
        if (refusal) throw refusal;
        writeOffTarget = { id: String(quote.id) };
        effect.detail = {
          ...effect.detail,
          vendor: String(quote.vendor),
          quoted_satang: Number(quote.quoted_satang),
        };
      }
      let invoiceTarget: string | null = null;
      if (effect.invoice_cost?.lab_cost_id) {
        // The quote the person named: this job's, and not invoiced yet.
        const [quote] = await em.execute(
          `select "id", "received_at", "invoiced_satang", "written_off_at"
             from "lab_cost" where "id" = ? and "lab_job_id" = ? and "deleted_at" is null`,
          [effect.invoice_cost.lab_cost_id, job_id],
        );
        if (!quote) throw new ProductionError("quote_not_found", "this job has no such lab quote");
        if (quote.invoiced_satang !== null) {
          throw new ProductionError("quote_invoiced", "the lab's invoice for this quote is already recorded");
        }
        invoiceTarget = String(quote.id);
        if (quote.written_off_at) {
          effect.detail = { ...effect.detail, reversed_write_off: true };
        }
      } else if (effect.invoice_cost) {
        // No quote named. Work that came back and is not written off, then
        // work that came back and was written off (the lab billed it after
        // all), then work that never came back (a job re-sent after a
        // changed prescription leaves the first quote open); oldest first
        // within each. With no write-off on the job this is the order it
        // always was.
        const [quote] = await em.execute(
          `select "id", "written_off_at" from "lab_cost"
            where "lab_job_id" = ? and "invoiced_satang" is null and "deleted_at" is null
            order by ("received_at" is null) asc, ("written_off_at" is not null) asc,
                     "created_at" asc, "id" asc
            limit 1`,
          [job_id],
        );
        if (!quote) {
          throw new ProductionError(
            "not_allowed",
            "this job has no lab quote waiting for an invoice",
          );
        }
        invoiceTarget = String(quote.id);
        // The invoice reverses the write-off in this same step. The
        // write-off stays on the quote as it was made; the history says it
        // was reversed, and on which quote.
        if (quote.written_off_at) {
          effect.detail = { ...effect.detail, lab_cost_id: invoiceTarget, reversed_write_off: true };
        }
      }

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
        effect.invoice_cost ||
        effect.write_off_cost
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
      // A changed prescription: the stored packet is the old one. Until a
      // rebuild stores the new packet the job has none to work from, which
      // is what `pending_rx` means; PRINTED is refused, and both the Retry
      // button and the half-hourly heal sweep rebuild it.
      if (restoring) {
        // Merged over the stored packet, as a rebuild is. `updated_at` moves
        // because the packet changed: a screen showing the blanked one
        // drops it (see `viewPacket`).
        sets.push(
          `"packet_snapshot" = coalesce("packet_snapshot", '{}'::jsonb) || ?::jsonb`,
          `"rx_redacted_at" = null`,
          // The one place this is set. Retention keeps the prescription
          // from here while the remake is made (`rx-retention.ts`).
          `"rx_restored_at" = ?`,
          `"updated_at" = ?`,
        );
        params.push(JSON.stringify(input.restore_packet), now, now);
        // Said on the event, as a fact with no values: this remake is made
        // from the customer's stored prescription as it is now, which need
        // not be the one the first pair was made from.
        effect.detail = { ...effect.detail, prescription_restored: true };
      }
      if (effect.packet_outdated && (job.status === "queued" || job.status === "failed")) {
        sets.push(`"status" = 'pending_rx'`, `"last_error" = ?`);
        params.push("prescription changed; the packet is being rebuilt");
      }
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
      if (effect.invoice_cost && invoiceTarget) {
        const invoiced = await em.execute(
          `update "lab_cost" set "invoiced_satang" = ?, "invoiced_at" = ?, "updated_at" = ?
            where "id" = ? and "invoiced_satang" is null and "deleted_at" is null
            returning "id"`,
          [effect.invoice_cost.invoiced_satang, now, now, invoiceTarget],
        );
        if (invoiced.length !== 1) {
          throw new ProductionError(
            "conflict",
            "the lab quote changed while the invoice was being recorded; try again",
          );
        }
      }
      if (effect.write_off_cost && writeOffTarget) {
        // Who and when, and the reason, on the quote and nowhere else. The
        // reason is never logged, reported or served to Operations.
        const written = await em.execute(
          `update "lab_cost"
              set "written_off_at" = ?, "written_off_by" = ?, "written_off_reason" = ?, "updated_at" = ?
            where "id" = ? and "received_at" is not null and "invoiced_satang" is null
              and "written_off_at" is null and "deleted_at" is null
            returning "id"`,
          [now, actor.id, effect.write_off_cost.reason, now, writeOffTarget.id],
        );
        if (written.length !== 1) {
          throw new ProductionError(
            "conflict",
            "the lab quote changed while the write-off was being recorded; try again",
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
      console.error(`[lms] could not put lab job ${jobId} at ready: ${failureKind(err)}`);
      captureException(reportableError(err, "lms mark ready"), {
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
              "written_off_satang", "created_at", "updated_at")
           select 'labtot_' || replace(gen_random_uuid()::text, '-', ''), c."vendor_key", ?,
                  -- Back, not invoiced and not written off, at the cutoff.
                  coalesce(sum(c."quoted_satang") filter (
                    where c."received_at" < ?::timestamptz
                      and (c."invoiced_at" is null or c."invoiced_at" >= ?::timestamptz)
                      and (c."written_off_at" is null or c."written_off_at" >= ?::timestamptz)), 0)::int,
                  coalesce(sum(c."invoiced_satang") filter (
                    where c."invoiced_at" < ?::timestamptz), 0)::int,
                  -- Written off and not invoiced since, at the cutoff: the
                  -- quoted value Operations should stop expecting an invoice for.
                  coalesce(sum(c."quoted_satang") filter (
                    where c."written_off_at" < ?::timestamptz
                      and (c."invoiced_at" is null or c."invoiced_at" >= ?::timestamptz)), 0)::int,
                  ?, ?
             from (select *, lower(btrim(regexp_replace("vendor", '\\s+', ' ', 'g'))) as "vendor_key"
                     from "lab_cost") c
            where c."deleted_at" is null and c."created_at" < ?::timestamptz
            group by c."vendor_key"`,
          [w.window_end, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, now, now, cutoff],
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
        select: [
          "id",
          "vendor",
          "as_of",
          "quoted_uninvoiced_satang",
          "invoiced_to_date_satang",
          "written_off_satang",
        ],
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
        .map(
          ({ id, vendor, as_of, quoted_uninvoiced_satang, invoiced_to_date_satang, written_off_satang }) => ({
            id,
            vendor,
            as_of,
            quoted_uninvoiced_satang,
            invoiced_to_date_satang,
            written_off_satang,
          }),
        ),
    }));
  }

  /**
   * Replace the lens snapshot with the one Klear Operations sent (contract
   * 5, part 2): every SKU's on-hand as of `asOf`, the end of the last usage
   * window it had applied. Returns how many SKUs are held.
   *
   * Refused (nothing changes) when `asOf` is today or later in Bangkok;
   * when a snapshot with a later `asOf` is
   * already held, so a delayed retry cannot roll the lab's view back; and
   * when `asOf` is not a released window's end while usage dated on or
   * before it exists, because then the figure and "used since" would not
   * meet. The same `asOf` again replaces it (a correction).
   *
   * The table is a copy, so its rows are deleted outright and written
   * again, in one transaction, under a lock that orders two snapshots.
   */
  async replaceLensSnapshot(asOf: string, lenses: Array<{ sku: string; on_hand: number }>): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      await em.execute(`select pg_advisory_xact_lock(hashtext('lens_stock_snapshot'))`);
      // A day that has not ended cannot be what usage was released up to.
      // Without this, a date in the future passed the check below while no
      // usage existed, was stored, and then refused every real snapshot as
      // older. Bangkok's date on the database's clock, the one clock every
      // Medusa process shares.
      const [clock] = await em.execute(
        `select to_char((now() at time zone 'Asia/Bangkok')::date, 'YYYY-MM-DD') as "today"`,
      );
      if (!(asOf < String(clock.today))) throw new LensSnapshotRefused("not_yet_closed");
      const [held] = await em.execute(
        `select max("as_of") as "as_of" from "lens_stock_snapshot" where "deleted_at" is null`,
      );
      if (held?.as_of && String(held.as_of) > asOf) throw new LensSnapshotRefused("older_than_stored");
      const [fits] = await em.execute(
        `select exists (select 1 from "lab_release_window"
                         where "window_end" = ? and "deleted_at" is null)
             or not exists (select 1 from "lab_usage"
                             where "entered_on" <= ? and "deleted_at" is null) as "ok"`,
        [asOf, asOf],
      );
      if (!fits?.ok) throw new LensSnapshotRefused("not_a_release");
      await em.execute(`delete from "lens_stock_snapshot"`);
      // In slices, to stay well under Postgres' limit on bound values.
      for (let i = 0; i < lenses.length; i += 500) {
        const slice = lenses.slice(i, i + 500);
        await em.execute(
          `insert into "lens_stock_snapshot" ("id", "sku", "on_hand", "as_of")
           values ${slice.map(() => "(?, ?, ?, ?)").join(", ")}`,
          slice.flatMap((l) => [generateEntityId(undefined, "lenssnap"), l.sku, l.on_hand, asOf]),
        );
      }
      return lenses.length;
    });
  }

  /**
   * The lab's live view of lens stock (design 10.4): each SKU in the
   * snapshot, its figure, and that figure plus the usage entered after the
   * snapshot's date. Usage is dated by when it was entered, and a window
   * takes rows by that date, so "after the window's end" is exactly the
   * usage Operations had not applied. `skus` narrows it; all when absent.
   */
  async lensStock(skus?: string[]): Promise<LensStockRow[]> {
    if (skus && skus.length === 0) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      const rows = await em.execute(
        `select s."sku", s."on_hand", s."as_of",
                coalesce(sum(u."qty"), 0)::int as "used_since"
           from "lens_stock_snapshot" s
           left join "lab_usage" u
             on u."sku" = s."sku" and u."entered_on" > s."as_of" and u."deleted_at" is null
          where s."deleted_at" is null
            ${skus ? `and s."sku" in (${skus.map(() => "?").join(", ")})` : ""}
          group by s."sku", s."on_hand", s."as_of"
          order by s."sku"`,
        skus ?? [],
      );
      return rows.map((r) => ({
        sku: String(r.sku),
        on_hand_at_release: Number(r.on_hand),
        as_of: String(r.as_of),
        used_since: Number(r.used_since),
        available: Number(r.on_hand) + Number(r.used_since),
      }));
    });
  }

  /**
   * The jobs on the queue board, longest-waiting first, without their
   * packets: every job at a stage the lab still works in, a finished or
   * cancelled job with a cut-or-uncut question still open, and a job that
   * never reached production because its packet failed or its prescription
   * has not arrived.
   */
  async listQueue(): Promise<LabJobQueueRow[]> {
    const rows = (await this.listLabJobs(
      {
        $or: [
          { stage: [...QUEUE_STAGES] },
          { cut_question_pending: true },
          // Not in production yet and stuck before it: the packet failed
          // or the prescription has not arrived. Nothing else shows these.
          { stage: null, status: ["failed", "pending_rx"] },
        ],
      },
      {
        select: [...QUEUE_COLUMNS],
        order: { stage_since: "ASC", id: "ASC" },
        // One more than the limit, so "there are more" is known, not guessed.
        take: QUEUE_LIMIT + 1,
      },
    )) as unknown as LabJobQueueRow[];
    // Longest-waiting first. A job with no stage has waited since it was
    // created. Past the limit, which rows are missing is decided by the
    // database's order (by time in stage, jobs with no stage last), so the
    // board then says only that there are more, not which.
    const since = (j: LabJobQueueRow) => new Date(j.stage_since ?? j.created_at).getTime();
    return rows.sort((a, b) => since(a) - since(b) || (a.id < b.id ? -1 : 1));
  }

  /** Every outside lab a job was ever sent to, one spelling each, for the
   *  screen to offer instead of typing the name again. */
  async listLabVendors(): Promise<string[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      const rows = await em.execute(
        // One spelling per lab: the one used most recently.
        `select (array_agg("vendor" order by "created_at" desc, "id" desc))[1] as "vendor"
           from "lab_cost"
          where "deleted_at" is null
          group by lower("vendor")
          order by lower("vendor")
          limit 100`,
      );
      return rows.map((r) => String(r.vendor));
    });
  }

  /**
   * The lab's report over the last `weeks` weeks (design 10.9): lenses used
   * per week by reason with the spoilage and remake rates, and lenses per
   * job against its remake count.
   *
   * Counts only. A lens SKU is a lens power, and beside a job it is health
   * data, so no SKU is in the report.
   *
   * The weekly rates count lenses issued as replacements. A replacement
   * that later went back on the shelf uncut is not taken off: a returned
   * lens is booked as a return, without the reason it was issued under.
   *
   * `unexplained` is the lenses a job used beyond a pair for the order and
   * a pair per counted remake. It is a prompt to look, not an accusation: a
   * lens reissued after a spoil or a changed prescription is not a counted
   * remake (README, known gap 3).
   */
  async productionReport(weeks = 12, now: Date = new Date()): Promise<ProductionReport> {
    const from = reportFrom(now, weeks);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (this as any).baseRepository_.transaction(async (em: Sql) => {
      const usage = await em.execute(
        `select to_char(date_trunc('week', "entered_on"::date), 'YYYY-MM-DD') as "week_start",
                coalesce(sum(-"qty") filter (where "reason" = 'order'), 0)::int as "issued_for_orders",
                coalesce(sum(-"qty") filter (where "reason" = 'spoilage_replacement'), 0)::int
                  as "spoilage_replacements",
                coalesce(sum(-"qty") filter (where "reason" = 'remake'), 0)::int as "remake_lenses",
                coalesce(sum(-"qty") filter (where "reason" = 'spoilage'), 0)::int as "frames_spoiled",
                coalesce(sum("qty") filter (where "reason" = 'return_unused'), 0)::int
                  as "returned_unused"
           from "lab_usage"
          where "deleted_at" is null and "entered_on" >= ?
          group by 1`,
        [from],
      );
      const events = await em.execute(
        `select to_char(date_trunc('week', ("created_at" at time zone 'Asia/Bangkok')::date),
                        'YYYY-MM-DD') as "week_start",
                (count(*) filter (where "action" = 'QC_FAILED'))::int as "qc_failed",
                (count(*) filter (where "action" = 'REMAKE_STARTED'))::int as "remakes_started"
           from "production_event"
          where "deleted_at" is null
            and "action" in ('QC_FAILED', 'REMAKE_STARTED')
            and ("created_at" at time zone 'Asia/Bangkok')::date >= cast(? as date)
          group by 1`,
        [from],
      );
      const jobs = await em.execute(
        `select u."lab_job_id", j."order_id", j."stage", j."remake_count",
                (count(*) filter (where u."qty" < 0 and u."reason" <> 'spoilage'))::int
                  as "lenses_issued",
                (count(*) filter (where u."reason" = 'return_unused'))::int as "lenses_returned"
           from "lab_usage" u
           join "lab_job" j on j."id" = u."lab_job_id"
          where u."deleted_at" is null
            and j."deleted_at" is null
            and u."lab_job_id" in (
              select "lab_job_id" from "lab_usage"
               where "deleted_at" is null and "entered_on" >= ?)
          group by 1, 2, 3, 4
          -- The jobs to look at first: most lenses beyond what remakes
          -- explain, then most lenses.
          order by greatest(0,
                     count(*) filter (where u."qty" < 0 and u."reason" <> 'spoilage')
                     - count(*) filter (where u."reason" = 'return_unused')
                     - 2 * (1 + j."remake_count")) desc,
                   "lenses_issued" desc, u."lab_job_id"
          limit ${REPORT_JOBS + 1}`,
        [from],
      );
      const quotes = await em.execute(
        `select (array_agg(c."vendor" order by c."created_at" desc, c."id" desc))[1] as "vendor",
                (count(*) filter (where ${BACK_NOT_INVOICED}))::int as "back_not_invoiced",
                coalesce(sum(c."quoted_satang") filter (where ${BACK_NOT_INVOICED}), 0)::int
                  as "back_not_invoiced_satang",
                (count(*) filter (where ${WRITTEN_OFF_IN_PERIOD}))::int as "written_off",
                coalesce(sum(c."quoted_satang") filter (where ${WRITTEN_OFF_IN_PERIOD}), 0)::int
                  as "written_off_satang"
           from (select *, lower(btrim(regexp_replace("vendor", '\\s+', ' ', 'g'))) as "vendor_key"
                   from "lab_cost" where "deleted_at" is null) c
          group by c."vendor_key"
         having count(*) filter (where ${BACK_NOT_INVOICED} or ${WRITTEN_OFF_IN_PERIOD}) > 0
          order by c."vendor_key"`,
        [from, from, from],
      );

      const byWeek = new Map<string, ProductionReport["weeks"][number]>();
      const week = (start: string) => {
        let w = byWeek.get(start);
        if (!w) {
          w = {
            week_start: start,
            issued_for_orders: 0,
            spoilage_replacements: 0,
            remake_lenses: 0,
            frames_spoiled: 0,
            returned_unused: 0,
            qc_failed: 0,
            remakes_started: 0,
            spoilage_rate: null,
            remake_rate: null,
          };
          byWeek.set(start, w);
        }
        return w;
      };
      for (const r of usage) {
        const w = week(String(r.week_start));
        w.issued_for_orders = Number(r.issued_for_orders);
        w.spoilage_replacements = Number(r.spoilage_replacements);
        w.remake_lenses = Number(r.remake_lenses);
        w.frames_spoiled = Number(r.frames_spoiled);
        w.returned_unused = Number(r.returned_unused);
        if (w.issued_for_orders > 0) {
          w.spoilage_rate = w.spoilage_replacements / w.issued_for_orders;
          w.remake_rate = w.remake_lenses / w.issued_for_orders;
        }
      }
      for (const r of events) {
        const w = week(String(r.week_start));
        w.qc_failed = Number(r.qc_failed);
        w.remakes_started = Number(r.remakes_started);
      }
      return {
        from,
        weeks: [...byWeek.values()].sort((a, b) => (a.week_start < b.week_start ? 1 : -1)),
        quotes: quotes.map((r) => ({
          vendor: String(r.vendor),
          back_not_invoiced: Number(r.back_not_invoiced),
          back_not_invoiced_satang: Number(r.back_not_invoiced_satang),
          written_off: Number(r.written_off),
          written_off_satang: Number(r.written_off_satang),
        })),
        jobs_truncated: jobs.length > REPORT_JOBS,
        jobs: jobs.slice(0, REPORT_JOBS).map((r) => {
          const lenses_issued = Number(r.lenses_issued);
          const lenses_returned = Number(r.lenses_returned);
          const remake_count = Number(r.remake_count);
          return {
            lab_job_id: String(r.lab_job_id),
            order_id: String(r.order_id),
            stage: (r.stage as string | null) ?? null,
            remake_count,
            lenses_issued,
            lenses_returned,
            unexplained: Math.max(0, lenses_issued - lenses_returned - 2 * (1 + remake_count)),
          };
        }),
      };
    });
  }

  /**
   * Show a job's packet (it holds the prescription) to a person, recording
   * who looked first. If the view cannot be recorded, the packet is not
   * returned. Refused when the job has no packet to work from: one still
   * waiting for a prescription or failed, one whose prescription changed
   * and is not rebuilt yet (the stored packet is then the OLD one), or one
   * blanked after delivery.
   */
  async viewPacket(
    jobId: string,
    actorId: string,
    key: string,
    printed = false,
  ): Promise<{ packet: LabJobPacket; job: LabJobProductionState; as_of: Date }> {
    const usable = (job: LabJobRow): void => {
      const problem = packetProblem(job);
      if (problem) throw new ProductionError("not_allowed", problem);
    };
    usable((await this.retrieveLabJob(jobId)) as unknown as LabJobRow);
    const recorded = await this.applyProductionAction({
      job_id: jobId,
      action: printed ? "PACKET_PRINTED" : "PACKET_VIEWED",
      idempotency_key: key,
      actor: { type: "user", id: actorId },
    });
    // Every look is its own record. A key that was already used records
    // nothing, so it shows nothing: otherwise one record would cover any
    // number of looks, by anyone who learned the key.
    if (recorded.replayed) {
      throw new ProductionError("key_reused", "use a new key to look at the packet again");
    }
    // Read after recording: this is the packet as it stands now, and it is
    // checked again in case it was replaced or blanked in between.
    const job = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    usable(job);
    // `as_of` is the row's `updated_at` as read with the packet. Recording a
    // production step does not touch it; storing or blanking a packet does.
    // A screen holding this packet drops it once the job's `updated_at` is
    // no longer this value.
    return { packet: job.packet_snapshot, job: recorded.job, as_of: job.updated_at };
  }

  /** The idempotency key of a job's most recent LABELLED event, or null. */
  async lastLabelKey(jobId: string): Promise<string | null> {
    const rows = (await this.listProductionEvents(
      { lab_job_id: jobId, action: "LABELLED" },
      { select: ["idempotency_key"], order: { seq: "DESC" }, take: 1 },
    )) as unknown as Array<{ idempotency_key: string }>;
    return rows[0]?.idempotency_key ?? null;
  }

  /** Has an event with this idempotency key been recorded? */
  async hasProductionEventKey(key: string): Promise<boolean> {
    const rows = await this.listProductionEvents(
      { idempotency_key: key },
      { select: ["id"], take: 1 },
    );
    return rows.length > 0;
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
