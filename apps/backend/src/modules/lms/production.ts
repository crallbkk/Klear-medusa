// Production rules for a lab job: which action is allowed from which stage,
// where it leads, and what it records (lens or frame usage, an outside lab's
// quote). Pure functions with no database access; `LmsModuleService.
// applyProductionAction` runs them inside one transaction under a row lock.
//
// `status` (queued / submitted / failed / ...) keeps its meaning: building and
// handing off the packet. `stage` is where the physical job is.

export const STAGES = [
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
  "delivered",
  "cancelled",
] as const;
export type Stage = (typeof STAGES)[number];

/** Stages before a shipping label exists. A cancel or a changed prescription
 *  is only possible here. */
const BEFORE_LABEL: ReadonlySet<Stage> = new Set([
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
]);

/** Stages at which a lens from Klear's own shelf has been cut or fitted. */
const LENS_CUT: ReadonlySet<Stage> = new Set([
  "edged",
  "mounted",
  "qc_passed",
  "qc_failed",
  "packed",
]);

export const STAGE_ACTIONS = [
  "READY",
  "PRINTED",
  "LENS_ISSUED",
  "SENT_TO_LAB",
  "RECEIVED_FROM_LAB",
  "EDGED",
  "MOUNTED",
  "QC_PASSED",
  "QC_FAILED",
  "REMAKE_STARTED",
  "REWORK",
  "LENS_SPOILED",
  "PACKED",
  "LABELLED",
  "LABEL_CANCELLED",
  "DELIVERED",
  "RX_CHANGED",
  "CANCELLED",
] as const;
export const NOTE_ACTIONS = [
  "FRAME_DAMAGED",
  "LENS_RETURNED_UNUSED",
  "LENS_CUT_CONFIRMED",
  "HOLD",
  "RELEASE",
  "PACKET_VIEWED",
  "PACKET_PRINTED",
  "LAB_INVOICED",
  "NOTE",
] as const;
export const ACTIONS = [...STAGE_ACTIONS, ...NOTE_ACTIONS] as const;
export type ProductionAction = (typeof ACTIONS)[number];

/** Actions only the system may record (subscribers and the packet builder),
 *  never a person pressing a button. */
export const SYSTEM_ONLY_ACTIONS: ReadonlySet<ProductionAction> = new Set([
  "READY",
  "LABELLED",
  "LABEL_CANCELLED",
  "DELIVERED",
  "RX_CHANGED",
  "CANCELLED",
]);

/** Why a lens left the shelf. These are the reasons operations books against
 *  (design 10.4); `spoilage` is also used for a frame broken in the lab. */
export type UsageReason =
  | "order"
  | "spoilage_replacement"
  | "remake"
  | "spoilage"
  | "return_unused";

export type ProductionErrorCode =
  | "not_allowed" // the action is not valid from the job's current stage
  | "invalid_detail" // the action's details are missing or malformed
  | "conflict" // someone else changed the job; re-read and try again
  | "not_found"
  | "key_reused"; // the idempotency key belongs to a different action

export class ProductionError extends Error {
  readonly code: ProductionErrorCode;
  constructor(code: ProductionErrorCode, message: string) {
    super(message);
    this.name = "ProductionError";
    this.code = code;
  }
}

/** The part of a job the rules read. */
export type JobState = {
  stage: Stage | null;
  remake_count: number;
  on_hold: boolean;
  cut_question_pending: boolean;
  /** The reason the next lens issue will be booked under. */
  next_issue_reason: UsageReason;
};

export type UsageLine = { sku: string; reason: UsageReason; qty: number };

export type Effect = {
  /** Set when the action moves the job; absent for a note-type action. */
  to_stage?: Stage;
  patch: Partial<
    Pick<
      JobState,
      "remake_count" | "on_hold" | "cut_question_pending" | "next_issue_reason"
    > & { hold_reason: string | null }
  >;
  usage: UsageLine[];
  /** An outside lab's quote, opened by SENT_TO_LAB. */
  open_cost?: { vendor: string; quoted_satang: number; expected_on: string | null };
  /** RECEIVED_FROM_LAB: the open quote's work has come back. */
  receive_cost?: true;
  /** LAB_INVOICED: the amount on the lab's invoice for this job. */
  invoice_cost?: { invoiced_satang: number };
  /** LENS_RETURNED_UNUSED: the SKUs the operator is putting back on the
   *  shelf. The service checks each was issued on this job and not already
   *  returned; the rules cannot see earlier events. */
  return_lenses?: string[];
  /** CANCELLED: the packet's `status` is set to cancelled with the stage. */
  cancel_status?: true;
  /** RX_CHANGED: the stored packet is for the old prescription. The job's
   *  `status` goes to `pending_rx` until a rebuild stores the new packet,
   *  so nobody can print from the old one in between. */
  packet_outdated?: true;
  /** What is stored on the event. Never a prescription value. */
  detail: Record<string, unknown>;
};

// Lens and frame SKUs as printed on the envelope or the frame bag. Same
// pattern as Klear Operations' stock items, so a usage row can never carry a
// string the stock ledger would refuse.
const SKU = /^[A-Z0-9][A-Z0-9._+\-]{1,63}$/;

function text(detail: Record<string, unknown>, key: string, max = 500): string {
  const v = detail[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ProductionError("invalid_detail", `"${key}" is required`);
  }
  if (v.length > max) {
    throw new ProductionError("invalid_detail", `"${key}" is longer than ${max} characters`);
  }
  return v.trim();
}

function sku(value: unknown, what: string): string {
  if (typeof value !== "string" || !SKU.test(value)) {
    throw new ProductionError(
      "invalid_detail",
      `${what} must be a SKU as printed on the label (capitals, digits, . _ + -)`,
    );
  }
  return value;
}

function satang(detail: Record<string, unknown>, key: string): number {
  const v = detail[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 2_000_000_000) {
    throw new ProductionError(
      "invalid_detail",
      `"${key}" must be a whole number of satang, zero or more`,
    );
  }
  return v;
}

function dateOrNull(detail: Record<string, unknown>, key: string): string | null {
  const v = detail[key];
  if (v === undefined || v === null || v === "") return null;
  // Round-trip, because Date.parse accepts 31 February and rolls it over.
  const ok =
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
    new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
  if (!ok) {
    throw new ProductionError("invalid_detail", `"${key}" must be a real date, YYYY-MM-DD`);
  }
  return v as string;
}

function refuse(action: ProductionAction, job: JobState): never {
  throw new ProductionError(
    "not_allowed",
    `${action} is not possible while the job is ${job.stage ?? "not ready"}`,
  );
}

function need(job: JobState, action: ProductionAction, ...from: Stage[]): void {
  if (job.stage === null || !from.includes(job.stage)) refuse(action, job);
}

/** While nobody has said whether the issued lens was cut, the job does not
 *  go back into production: a second issue would make "which lens is going
 *  back" unanswerable (design 10.2 rule 2). */
function needQuestionAnswered(job: JobState, action: ProductionAction): void {
  if (job.cut_question_pending) {
    throw new ProductionError(
      "not_allowed",
      `${action} must wait: first say whether the lens already issued was cut`,
    );
  }
}

function skuList(detail: Record<string, unknown>, what: string): string[] {
  const lenses = detail.lenses;
  // A pair is two. One is allowed: after a single spoiled lens only that
  // one is replaced, and only an uncut one goes back.
  if (!Array.isArray(lenses) || lenses.length < 1 || lenses.length > 2) {
    throw new ProductionError("invalid_detail", `"lenses" must list ${what}, one or two`);
  }
  return lenses.map((l, i) => sku(l, `lens ${i + 1}`));
}

/**
 * Decide what an action does to a job, or throw a `ProductionError` saying
 * why it cannot be done. Reads nothing but its arguments.
 */
export function decide(
  job: JobState,
  action: ProductionAction,
  detail: Record<string, unknown> = {},
): Effect {
  const none: Effect = { patch: {}, usage: [], detail: {} };

  switch (action) {
    case "READY":
      if (job.stage !== null) refuse(action, job);
      return { ...none, to_stage: "ready" };

    case "PRINTED":
      need(job, action, "ready");
      needQuestionAnswered(job, action);
      return { ...none, to_stage: "printed" };

    case "LENS_ISSUED": {
      need(job, action, "printed");
      needQuestionAnswered(job, action);
      const skus = skuList(detail, "the SKU on each lens envelope");
      return {
        ...none,
        to_stage: "lens_issued",
        usage: skus.map((s) => ({ sku: s, reason: job.next_issue_reason, qty: -1 })),
        detail: { lenses: skus, reason: job.next_issue_reason },
      };
    }

    case "SENT_TO_LAB": {
      need(job, action, "printed");
      needQuestionAnswered(job, action);
      // One spelling per lab: inner runs of white space collapsed. Totals
      // are grouped without regard to case as well (see the release).
      const vendor = text(detail, "vendor", 120).replace(/\s+/g, " ");
      const quoted_satang = satang(detail, "quoted_satang");
      const expected_on = dateOrNull(detail, "expected_on");
      return {
        ...none,
        to_stage: "sent_to_lab",
        open_cost: { vendor, quoted_satang, expected_on },
        detail: { vendor, quoted_satang, expected_on },
      };
    }

    case "RECEIVED_FROM_LAB":
      need(job, action, "sent_to_lab");
      return { ...none, to_stage: "received_from_lab", receive_cost: true };

    case "EDGED":
      need(job, action, "lens_issued");
      return { ...none, to_stage: "edged" };

    case "MOUNTED":
      need(job, action, "edged", "received_from_lab");
      return { ...none, to_stage: "mounted" };

    case "QC_PASSED":
      need(job, action, "mounted");
      return { ...none, to_stage: "qc_passed" };

    case "QC_FAILED":
      need(job, action, "mounted");
      return { ...none, to_stage: "qc_failed", detail: { reason: text(detail, "reason") } };

    case "REMAKE_STARTED": {
      need(job, action, "qc_failed", "labelled", "delivered");
      const cause = text(detail, "cause");
      // After a QC failure the replacement lens is production spoilage. After
      // the customer has the glasses it is a warranty remake.
      const warranty = job.stage !== "qc_failed";
      return {
        ...none,
        to_stage: "printed",
        patch: {
          remake_count: job.remake_count + 1,
          next_issue_reason: warranty ? "remake" : "spoilage_replacement",
        },
        detail: { cause, warranty },
      };
    }

    case "REWORK":
      need(job, action, "qc_failed");
      return { ...none, to_stage: "edged" };

    case "LENS_SPOILED":
      need(job, action, "lens_issued", "edged", "mounted");
      return {
        ...none,
        to_stage: "printed",
        patch: { next_issue_reason: "spoilage_replacement" },
        detail: { reason: text(detail, "reason") },
      };

    case "PACKED":
      need(job, action, "qc_passed");
      return { ...none, to_stage: "packed" };

    case "LABELLED":
      need(job, action, "packed");
      return { ...none, to_stage: "labelled" };

    case "LABEL_CANCELLED":
      // The label was cancelled in Medusa before the carrier took the
      // parcel: the boxed glasses are waiting for a label again. (Not in the
      // design's table, which has no way back from `labelled`; without it a
      // re-booked label could never be recorded.)
      need(job, action, "labelled");
      return { ...none, to_stage: "packed" };

    case "DELIVERED":
      need(job, action, "labelled");
      return { ...none, to_stage: "delivered" };

    case "RX_CHANGED": {
      if (job.stage === null || !BEFORE_LABEL.has(job.stage)) refuse(action, job);
      const patch: Effect["patch"] = {};
      // A lens issued and maybe not yet cut: someone must say which, and
      // the answer decides how the next pair is booked (LENS_CUT_CONFIRMED:
      // a remake. LENS_RETURNED_UNUSED: nothing was lost, so no change).
      if (job.stage === "lens_issued") patch.cut_question_pending = true;
      // A lens already cut for the old prescription is lost; the next issue
      // is a remake.
      if (LENS_CUT.has(job.stage)) patch.next_issue_reason = "remake";
      return { ...none, to_stage: "ready", patch, packet_outdated: true };
    }

    case "CANCELLED": {
      if (job.stage !== null && !BEFORE_LABEL.has(job.stage)) refuse(action, job);
      const patch: Effect["patch"] = { on_hold: false, hold_reason: null };
      if (job.stage === "lens_issued") patch.cut_question_pending = true;
      return { ...none, to_stage: "cancelled", patch, cancel_status: true };
    }

    case "FRAME_DAMAGED": {
      if (job.stage === null || job.stage === "cancelled" || job.stage === "delivered") {
        refuse(action, job);
      }
      const s = sku(detail.sku, `"sku"`);
      return {
        ...none,
        usage: [{ sku: s, reason: "spoilage", qty: -1 }],
        detail: { sku: s, reason: text(detail, "reason") },
      };
    }

    case "LENS_RETURNED_UNUSED":
      if (!job.cut_question_pending) {
        throw new ProductionError(
          "not_allowed",
          "a lens can only be returned unused while the cut-or-uncut question is open",
        );
      }
      {
        const skus = skuList(detail, "the SKU of each lens going back on the shelf");
        return {
          ...none,
          patch: { cut_question_pending: false },
          return_lenses: skus,
          detail: { lenses: skus },
        };
      }

    case "LENS_CUT_CONFIRMED":
      if (!job.cut_question_pending) {
        throw new ProductionError("not_allowed", "there is no cut-or-uncut question open on this job");
      }
      // The lens is lost. If the job goes on (a changed prescription), the
      // pair issued next is a remake; a cancelled job issues nothing more.
      return {
        ...none,
        patch:
          job.stage === "cancelled"
            ? { cut_question_pending: false }
            : { cut_question_pending: false, next_issue_reason: "remake" },
      };

    case "HOLD": {
      if (job.stage === null || job.stage === "cancelled" || job.stage === "delivered") {
        refuse(action, job);
      }
      if (job.on_hold) throw new ProductionError("not_allowed", "the job is already on hold");
      const reason = text(detail, "reason");
      return { ...none, patch: { on_hold: true, hold_reason: reason }, detail: { reason } };
    }

    case "RELEASE":
      if (!job.on_hold) throw new ProductionError("not_allowed", "the job is not on hold");
      return { ...none, patch: { on_hold: false, hold_reason: null } };

    case "PACKET_VIEWED":
    case "PACKET_PRINTED":
      return none;

    case "LAB_INVOICED": {
      const invoiced_satang = satang(detail, "invoiced_satang");
      return { ...none, invoice_cost: { invoiced_satang }, detail: { invoiced_satang } };
    }

    case "NOTE":
      return { ...none, detail: { text: text(detail, "text", 2000) } };
  }
}

// Details that pass every action's own checks. Used only to ask `decide`
// whether the STAGE allows an action; nothing here is ever stored.
const SAMPLE_DETAIL: Partial<Record<ProductionAction, Record<string, unknown>>> = {
  LENS_ISSUED: { lenses: ["SAMPLE"] },
  SENT_TO_LAB: { vendor: "sample", quoted_satang: 0 },
  QC_FAILED: { reason: "sample" },
  REMAKE_STARTED: { cause: "sample" },
  LENS_SPOILED: { reason: "sample" },
  FRAME_DAMAGED: { sku: "SAMPLE", reason: "sample" },
  LENS_RETURNED_UNUSED: { lenses: ["SAMPLE"] },
  HOLD: { reason: "sample" },
  LAB_INVOICED: { invoiced_satang: 0 },
  NOTE: { text: "sample" },
};

/**
 * The actions a person could record on a job as it stands: the buttons the
 * job screen shows. Asked of `decide` itself, so the screen can never offer
 * what the rules refuse or hide what they allow. System actions and packet
 * looks are not buttons and are never in the list.
 */
export function offeredActions(job: JobState & PacketState): ProductionAction[] {
  return ACTIONS.filter((action) => {
    if (SYSTEM_ONLY_ACTIONS.has(action)) return false;
    if (action === "PACKET_VIEWED" || action === "PACKET_PRINTED") return false;
    return wouldAccept(job, action);
  });
}

/** The part of a job's packet the rules below read. */
export type PacketState = {
  status: string;
  rx_redacted_at?: Date | string | null;
};

/**
 * Why the state of a job's PACKET forbids an action, or null. `decide`
 * knows where the physical job is; this knows whether there is a packet to
 * work from. The writer checks both, and so does anything that says what a
 * job offers.
 */
export function packetForbids(
  job: PacketState & { stage: Stage | null },
  action: ProductionAction,
): string | null {
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
    return `a job whose packet is ${job.status} is not ready for production`;
  }
  // Nor can the lab print from a packet whose prescription was removed (the
  // packet route refuses to show it). A rebuild puts it back.
  if (action === "PRINTED" && job.rx_redacted_at) {
    return "the prescription was removed from this job; rebuild the packet first";
  }
  // A changed prescription replaces the packet. One a lab provider has,
  // or is being given, cannot be replaced, so the job cannot go back.
  if (
    action === "RX_CHANGED" &&
    job.status !== "queued" &&
    job.status !== "failed" &&
    job.status !== "pending_rx"
  ) {
    return `the packet of this job is ${job.status}; its prescription cannot be changed here`;
  }
  // A warranty remake needs the prescription back in the packet first
  // (it is blanked some time after delivery). The caller rebuilds it.
  if (action === "REMAKE_STARTED" && job.rx_redacted_at && job.stage !== "qc_failed") {
    return "the prescription was removed from this job after delivery; rebuild the packet before starting a remake";
  }
  return null;
}

/** Would the writer accept this action on the job as it stands, given good
 *  details? True for system actions too; who may record it is not asked.
 *  (Two things only the database knows are not asked either: whether a lab
 *  quote is waiting for an invoice, and which lenses were issued.) */
export function wouldAccept(job: JobState & PacketState, action: ProductionAction): boolean {
  if (packetForbids(job, action) !== null) return false;
  try {
    decide(job, action, SAMPLE_DETAIL[action] ?? {});
    return true;
  } catch (err) {
    if (err instanceof ProductionError && err.code === "not_allowed") return false;
    throw err;
  }
}

/** The Bangkok calendar date of an instant. Bangkok is UTC+7 with no
 *  daylight saving. */
export function bangkokDate(at: Date): string {
  return new Date(at.getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}
