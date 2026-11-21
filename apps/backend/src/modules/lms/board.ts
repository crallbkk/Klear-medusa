// What the lab's screens are told about a job besides its stored columns:
// which column of the queue board it sits in, whether it is overdue, and
// where a report's first week starts. Pure functions; the routes call them,
// so the screens hold no rules of their own.

import {
  bangkokDate,
  wouldAccept,
  type JobState,
  type PacketState,
  type Stage,
} from "./production";

/**
 * Hours a job may sit in a stage before the board calls it overdue.
 *
 * THESE ARE PLACEHOLDERS. The design (10.9) says the first thresholds are
 * agreed with the lab before go-live; nobody has agreed these. One working
 * day for a step done at the bench, a week for an outside lab, three days
 * for a parcel the carrier has not delivered. A finished job has none.
 */
export const OVERDUE_AFTER_HOURS: Partial<Record<Stage, number>> = {
  ready: 24,
  printed: 24,
  lens_issued: 24,
  sent_to_lab: 7 * 24,
  received_from_lab: 24,
  edged: 24,
  mounted: 24,
  qc_passed: 24,
  qc_failed: 24,
  packed: 24,
  labelled: 3 * 24,
};

/**
 * Hours a job may wait in a column that is not a stage before it is called
 * overdue. Placeholders like the ones above. A customer who chose to send
 * the prescription later is given three days before the board flags it.
 */
export const OVERDUE_WAITING_HOURS: Record<string, number> = {
  question: 24,
  packet_failed: 24,
  waiting_rx: 3 * 24,
};

type BoardRow = {
  stage: Stage | string | null;
  status?: string | null;
  on_hold: boolean;
  cut_question_pending: boolean;
  stage_since?: Date | string | null;
  created_at?: Date | string | null;
};

/**
 * The one column a job is shown in. What needs a person comes first: an
 * open cut-or-uncut question, then a packet that failed or is waiting for a
 * prescription before the lab has started (it cannot work from it), then a
 * hold, then the stage. Once the lab has started, the job stays in its
 * stage whatever happens to the packet's hand-off: the glasses are where
 * they are.
 */
export function boardColumn(job: BoardRow): string {
  if (job.cut_question_pending) return "question";
  const notStarted = job.stage === null || job.stage === "ready";
  if (notStarted && job.status === "failed") return "packet_failed";
  if (notStarted && job.status === "pending_rx") return "waiting_rx";
  if (job.on_hold) return "on_hold";
  return job.stage ?? "none";
}

/**
 * Has the job waited longer than its column allows? In a stage, since it
 * entered the stage. With an open question or a packet problem, since it
 * entered its stage or, with no stage, since it was created. A held job is
 * not overdue: someone decided it should wait.
 */
export function isOverdue(job: BoardRow, now: Date): boolean {
  const column = boardColumn(job);
  if (column === "on_hold") return false;
  const hours = OVERDUE_WAITING_HOURS[column] ?? OVERDUE_AFTER_HOURS[column as Stage];
  if (hours === undefined) return false;
  const waitingSince = job.stage_since ?? (column in OVERDUE_WAITING_HOURS ? job.created_at : null);
  if (!waitingSince) return false;
  const since = new Date(waitingSince).getTime();
  if (Number.isNaN(since)) return false;
  return now.getTime() - since > hours * 3600_000;
}

/**
 * Why a job's packet cannot be shown to work from, or null when it can.
 * Not usable: one still waiting for a prescription or failed, one whose
 * prescription changed and is not rebuilt yet (the stored packet is then
 * the OLD one), a cancelled job, or one blanked after delivery.
 */
export function packetProblem(job: {
  status: string;
  rx_redacted_at?: Date | string | null;
}): string | null {
  if (job.status !== "queued" && job.status !== "submitting" && job.status !== "submitted") {
    return `this job has no packet to work from (it is ${job.status})`;
  }
  if (job.rx_redacted_at) {
    return "the prescription was removed from this job; rebuild the packet first";
  }
  return null;
}

/**
 * What the job screen may offer besides the production steps. Each mirrors
 * the check its route makes, so a shown button is one that will be accepted
 * (unless the job moves in between, which the route still refuses).
 *
 *   packet      show or print the packet
 *   retry       rebuild the packet of a job the lab has not started
 *   rx_changed  the customer's prescription changed during production
 */
export function alsoOffered(
  job: JobState & PacketState,
): { packet: boolean; retry: boolean; rx_changed: boolean } {
  const started = job.stage !== null && job.stage !== "ready";
  return {
    packet: packetProblem(job) === null,
    // The Retry route also rebuilds a queued job the lab has not started.
    // That is offered only when there is something to fix: its
    // prescription was removed, and a rebuild puts it back.
    retry:
      !started &&
      (job.status === "failed" ||
        job.status === "pending_rx" ||
        (job.status === "queued" && Boolean(job.rx_redacted_at))),
    rx_changed: wouldAccept(job, "RX_CHANGED"),
  };
}

/**
 * The first day a report over the last `weeks` weeks covers: the Monday, in
 * Bangkok, of the earliest of those weeks. The current week counts as one.
 */
export function reportFrom(now: Date, weeks: number): string {
  const n = Number.isFinite(weeks) ? Math.min(Math.max(Math.trunc(weeks), 1), 52) : 12;
  const today = new Date(`${bangkokDate(now)}T00:00:00Z`);
  const sinceMonday = (today.getUTCDay() + 6) % 7;
  today.setUTCDate(today.getUTCDate() - sinceMonday - 7 * (n - 1));
  return today.toISOString().slice(0, 10);
}
