// What the lab screens need that is not drawing: the words for each step,
// the fields each step asks for, and how what was typed becomes the request
// the lab routes accept. No React here, so it is tested on its own
// (`__tests__/lab.unit.spec.ts` checks every built request against the
// production rules themselves).
//
// The screens hold no production rules. Which steps a job offers, which
// column it sits in and whether it is overdue all come from the routes.

export type LabJob = {
  id: string;
  /** Absent for a lab account, which is shown the job and not the order. */
  order_id?: string;
  status: string;
  last_error?: string | null;
  stage: string | null;
  stage_since?: string | null;
  stage_version: number;
  /** The number of the job's latest event. */
  event_seq?: number;
  remake_count: number;
  on_hold: boolean;
  hold_reason?: string | null;
  cut_question_pending: boolean;
  created_at?: string;
  updated_at?: string;
};

export type QueueJob = LabJob & { column: string; overdue: boolean };

export type LabEvent = {
  id: string;
  seq: number;
  action: string;
  from_stage: string | null;
  to_stage: string | null;
  actor_type: string;
  actor_id: string;
  happened_at: string | null;
  created_at: string;
  detail: Record<string, unknown> | null;
};

export type LabCost = {
  id: string;
  vendor: string;
  quoted_satang: number;
  expected_on: string | null;
  received_at: string | null;
  invoiced_satang: number | null;
  invoiced_at: string | null;
};

/** Shown beside every free-text box (module README, known gap 5). */
export const NO_PRESCRIPTION_HERE =
  "Do not type prescription values, or a customer's name or phone, here. This text is kept in the job's history.";

const STAGE_LABEL: Record<string, string> = {
  ready: "Ready to print",
  printed: "Printed",
  lens_issued: "Lens issued",
  sent_to_lab: "At outside lab",
  received_from_lab: "Back from lab",
  edged: "Edged",
  mounted: "Mounted",
  qc_passed: "QC passed",
  qc_failed: "QC failed",
  packed: "Packed",
  labelled: "Labelled",
  delivered: "Delivered",
  cancelled: "Cancelled",
  // Board columns that are not stages.
  question: "Cut or uncut?",
  packet_failed: "Packet failed",
  waiting_rx: "Waiting for prescription",
  on_hold: "On hold",
  none: "Not in production",
};

/** The board's columns, in the order they are shown: what needs a person
 *  first, then the stages in the order a job passes through them. */
export const BOARD_COLUMNS = [
  "question",
  "packet_failed",
  "waiting_rx",
  "on_hold",
  "ready",
  "printed",
  "lens_issued",
  "sent_to_lab",
  "received_from_lab",
  "edged",
  "mounted",
  "qc_failed",
  "qc_passed",
  "packed",
  "labelled",
] as const;

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return STAGE_LABEL.none;
  return STAGE_LABEL[stage] ?? stage;
}

/** The words on each step's button. */
export const ACTION_LABEL: Record<string, string> = {
  PRINTED: "Mark printed",
  LENS_ISSUED: "Issue lens",
  SENT_TO_LAB: "Send to outside lab",
  RECEIVED_FROM_LAB: "Received from lab",
  EDGED: "Edged",
  MOUNTED: "Mounted",
  QC_PASSED: "QC passed",
  QC_FAILED: "QC failed",
  REMAKE_STARTED: "Start remake",
  REWORK: "Rework",
  LENS_SPOILED: "Lens spoiled",
  PACKED: "Packed",
  FRAME_DAMAGED: "Frame damaged",
  LENS_RETURNED_UNUSED: "Lens went back uncut",
  LENS_CUT_CONFIRMED: "Lens was cut",
  LAB_INVOICED: "Enter lab invoice",
  NOTE: "Add note",
  HOLD: "Put on hold",
  RELEASE: "Release hold",
  // Recorded by the system or by looking at the packet; never a button.
  READY: "Ready",
  LABELLED: "Label booked",
  LABEL_CANCELLED: "Label cancelled",
  DELIVERED: "Delivered",
  RX_CHANGED: "Prescription changed",
  CANCELLED: "Cancelled",
  PACKET_VIEWED: "Packet viewed",
  PACKET_PRINTED: "Packet printed",
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}

export type FieldKind = "sku" | "text" | "baht" | "date" | "vendor";
export type ActionField = {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  help?: string;
};

const reason = (label: string): ActionField => ({
  name: "reason",
  label,
  kind: "text",
  required: true,
  help: NO_PRESCRIPTION_HERE,
});
const lensPair = (first: string): ActionField[] => [
  { name: "lens_1", label: first, kind: "sku", required: true, help: "The SKU printed on the lens envelope." },
  {
    name: "lens_2",
    label: "Second lens SKU",
    kind: "sku",
    required: false,
    help: "Leave empty when it is one lens only.",
  },
];

/** What each step asks for. A step not listed asks for nothing. */
export const ACTION_FIELDS: Record<string, ActionField[]> = {
  LENS_ISSUED: lensPair("Lens SKU"),
  LENS_RETURNED_UNUSED: lensPair("SKU of the lens going back on the shelf"),
  SENT_TO_LAB: [
    {
      name: "vendor",
      label: "Outside lab",
      kind: "vendor",
      required: true,
      help: `Choose a lab already used, so its totals stay in one place, or type a new one. ${NO_PRESCRIPTION_HERE}`,
    },
    { name: "quoted", label: "Quoted price (baht)", kind: "baht", required: true },
    { name: "expected_on", label: "Expected back", kind: "date", required: false },
  ],
  QC_FAILED: [reason("What failed")],
  REMAKE_STARTED: [{ ...reason("Cause of the remake"), name: "cause" }],
  LENS_SPOILED: [reason("What happened to the lens")],
  FRAME_DAMAGED: [
    { name: "sku", label: "Frame SKU", kind: "sku", required: true, help: "The SKU on the frame bag." },
    reason("What happened to the frame"),
  ],
  LAB_INVOICED: [{ name: "invoiced", label: "Amount on the lab's invoice (baht)", kind: "baht", required: true }],
  NOTE: [{ ...reason("Note"), name: "text" }],
  HOLD: [reason("Why the job is held")],
};

export function fieldsFor(action: string): ActionField[] {
  return ACTION_FIELDS[action] ?? [];
}

// The same shape the lab routes and Klear Operations' stock items accept.
const SKU = /^[A-Z0-9][A-Z0-9._+\-]{1,63}$/;

/** A SKU as typed, tidied: no spaces around it, capitals. Null if it still
 *  is not one. */
export function tidySku(typed: string): string | null {
  const sku = typed.trim().toUpperCase();
  return SKU.test(sku) ? sku : null;
}

/**
 * Baht as typed ("450", "450.5", "1,250.75") to whole satang, by moving the
 * decimal point in the text. No floating-point arithmetic touches money.
 * Null if it is not an amount of zero or more with at most two decimals, or
 * is more than the routes accept (20 million baht).
 *
 * A comma is only ever a thousands separator, and only in the right
 * places. "450,50" is refused, not read as 45,050: a keyboard set to a
 * comma-decimal language must not multiply an amount by a hundred.
 */
export function bahtToSatang(typed: string): number | null {
  const trimmed = typed.trim();
  if (trimmed.includes(",") && !/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(trimmed)) return null;
  const text = trimmed.replace(/,/g, "");
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const satang = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return satang <= 2_000_000_000 ? satang : null;
}

/** Whole satang as baht with two decimals and thousands separators. */
export function formatBaht(satang: number | null | undefined): string {
  if (satang === null || satang === undefined || !Number.isFinite(satang)) return "";
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(satang));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${whole}.${String(abs % 100).padStart(2, "0")}`;
}

function realDate(text: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(text) &&
    !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) &&
    new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text
  );
}

export type BuiltDetail =
  | { ok: true; detail: Record<string, unknown> | undefined }
  | { ok: false; field: string; message: string };

/**
 * Turn what was typed into a step's form into the `detail` the lab routes
 * accept, or say which field is wrong and why, in words for the person
 * typing. The routes check everything again; this only saves a round trip
 * and gives a clearer message.
 */
export function buildDetail(action: string, values: Record<string, string>): BuiltDetail {
  const fields = fieldsFor(action);
  if (fields.length === 0) return { ok: true, detail: undefined };
  const detail: Record<string, unknown> = {};
  const lenses: string[] = [];
  for (const field of fields) {
    const typed = (values[field.name] ?? "").trim();
    const bad = (message: string): BuiltDetail => ({ ok: false, field: field.name, message });
    if (typed === "") {
      if (field.required) return bad(`${field.label} is needed.`);
      continue;
    }
    switch (field.kind) {
      case "sku": {
        const sku = tidySku(typed);
        if (!sku) {
          return bad(`${field.label}: type the SKU as printed (capitals, digits, . _ + -).`);
        }
        if (field.name.startsWith("lens_")) lenses.push(sku);
        else detail[field.name] = sku;
        break;
      }
      case "baht": {
        const satang = bahtToSatang(typed);
        if (satang === null) return bad(`${field.label}: type an amount such as 450 or 450.50.`);
        detail[`${field.name}_satang`] = satang;
        break;
      }
      case "date":
        if (!realDate(typed)) return bad(`${field.label}: choose a real date.`);
        detail[field.name] = typed;
        break;
      case "vendor":
        if (typed.length > 120) return bad(`${field.label}: at most 120 characters.`);
        detail[field.name] = typed.replace(/\s+/g, " ");
        break;
      case "text": {
        const max = action === "NOTE" ? 2000 : 500;
        if (typed.length > max) return bad(`${field.label}: at most ${max} characters.`);
        detail[field.name] = typed;
        break;
      }
    }
  }
  if (fields.some((f) => f.name.startsWith("lens_"))) detail.lenses = lenses;
  return { ok: true, detail };
}

/**
 * What makes two presses the same request: the step, the job exactly as the
 * screen showed it (its stage version and the number of its latest event),
 * and what was typed. A second press, or a retry after a lost connection,
 * has the same identity and so sends the same key, and the route answers
 * with the first result instead of recording again. Anything else is a
 * different request with a different key: other details, or the same step
 * after the job has moved on (even if it later comes back to this stage).
 */
export function requestIdentity(
  step: string,
  job: Pick<LabJob, "id" | "stage_version" | "event_seq">,
  values: Record<string, string> = {},
): string {
  const typed = Object.keys(values)
    .sort()
    .filter((k) => values[k].trim() !== "")
    .map((k) => [k, values[k].trim()]);
  return JSON.stringify([step, job.id, job.stage_version, job.event_seq ?? null, typed]);
}

/** The key for a request, made on first use and the same on every later
 *  use of the same identity. `kept` lives as long as the job's screen. */
export function keyFor(kept: Map<string, string>, identity: string): string {
  let key = kept.get(identity);
  if (!key) {
    key = newKey();
    kept.set(identity, key);
  }
  return key;
}

/**
 * Is a packet on the screen still the packet to work from? `asOf` is the
 * stamp the packet route gave with it: the job row's `updated_at` as read
 * with the packet. Recording a step does not change that; storing a new
 * packet or blanking the prescription does. So: the route must still allow
 * a look, and the stamp must still be the job's.
 */
export function packetIsCurrent(
  asOf: string | null | undefined,
  job: Pick<LabJob, "updated_at">,
  lookAllowed: boolean,
): boolean {
  if (!lookAllowed || !asOf || !job.updated_at) return false;
  const a = new Date(asOf).getTime();
  const b = new Date(job.updated_at).getTime();
  return !Number.isNaN(a) && a === b;
}

/** Said when a request got no answer: it may or may not have been recorded. */
export const NO_ANSWER =
  "No answer from the server. The step may have been recorded: check the history before trying again.";

/**
 * A new idempotency key. A look at the packet takes a new one every time;
 * a step takes one per request (see `requestIdentity`).
 */
export function newKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `screen-${c.randomUUID()}`;
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return `screen-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** How long ago, in the largest unit that fits: "now", "25 min", "3 h", "2 d". */
export function waited(since: string | Date | null | undefined, now: Date = new Date()): string {
  if (!since) return "";
  const ms = now.getTime() - new Date(since).getTime();
  if (Number.isNaN(ms)) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** What a job is called on the screens: by its order for ops, by itself
 *  for a lab account (which is not given the order). */
export function jobTitle(job: { id?: string; lab_job_id?: string; order_id?: string }): string {
  if (job.order_id) return `Order …${shortId(job.order_id)}`;
  return `Job …${shortId(job.id ?? job.lab_job_id ?? "")}`;
}

/** The short form of an order id for a list: its last eight characters. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

/** A rate as a percentage with one decimal, or a dash when there is none. */
export function percent(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "-";
  return `${(rate * 100).toFixed(1)}%`;
}

/** What an event recorded, as one line for the history. Only fields the
 *  production rules store; nothing here can be a prescription. */
export function eventSummary(event: Pick<LabEvent, "action" | "detail">): string {
  const d = event.detail ?? {};
  const parts: string[] = [];
  if (Array.isArray(d.lenses)) parts.push(d.lenses.map(String).join(", "));
  if (typeof d.sku === "string") parts.push(d.sku);
  if (typeof d.vendor === "string") parts.push(d.vendor);
  if (typeof d.quoted_satang === "number") parts.push(`quoted ${formatBaht(d.quoted_satang)}`);
  if (typeof d.invoiced_satang === "number") parts.push(`invoiced ${formatBaht(d.invoiced_satang)}`);
  if (typeof d.expected_on === "string") parts.push(`expected ${d.expected_on}`);
  if (d.warranty === true) parts.push("warranty");
  for (const key of ["reason", "cause", "text"]) {
    if (typeof d[key] !== "string") continue;
    // "reason" on a lens issue is the booking reason, a fixed word such as
    // spoilage_replacement. Anything else is what a person typed, shown as typed.
    const fixedWord = key === "reason" && event.action === "LENS_ISSUED";
    parts.push(fixedWord ? String(d[key]).replace(/_/g, " ") : String(d[key]));
  }
  return parts.join(" · ");
}

/**
 * What to tell the person about a failed request. A refusal (a 4xx answer)
 * is shown in the route's own words. Anything else, a dropped connection,
 * a server fault, an answer that is not JSON, is shown as a fixed sentence:
 * such an error's own text is the browser's or the parser's, which can
 * quote part of a response.
 */
export function failureMessage(err: unknown): string {
  if (!wasAnswered(err)) return NO_ANSWER;
  const e = err as { message?: unknown };
  if (typeof e?.message === "string" && e.message.trim() !== "") return e.message;
  return "The request was refused.";
}

/** Did the route refuse because the job moved (reload it) or for good
 *  (a new key is needed for the next try)? A network failure is neither:
 *  the same key is kept so the retry cannot record the step twice. */
export function wasAnswered(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
