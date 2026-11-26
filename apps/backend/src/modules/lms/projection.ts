// Contract 6 (`order-status-projection-v1`): what the Website is told about
// an order's production. Pure functions; the writer
// (`LmsModuleService.applyProductionAction`) records the state to show in
// the same transaction as the stage, and `projection-sender.ts` posts it.
//
// The Website is told a STATE, numbered by a sequence, never the events:
// production loops (a remake goes backwards), and the Website applies a
// message when its sequence is higher than the last it applied, whatever
// its current state. The sequence is the job's `stage_version` at the time:
// it only grows, and there is one job per order (`UQ_lab_job_order_id_active`;
// a remake loops the same job), so it is per order as the contract asks.
//
// Never sent: any prescription detail, lens power, packet content, operator
// name or lab cost. The message has exactly five fields.

import type { ProductionAction, Stage } from "./production";

export const PROJECTION_PATH = "/api/webhooks/order-projection";

export const PROJECTED_STATES = [
  "pending_lab",
  "sent_to_lab",
  "in_production",
  "qc_pass",
  "qc_fail",
  "remake_required",
  "assembled",
] as const;
export type ProjectedState = (typeof PROJECTED_STATES)[number];

/**
 * The Website state a stage shows, given the action that reached it, or
 * null when the Website hears of it some other way: a label and a delivery
 * through the carrier's scans, a cancel because the Website made it.
 */
export function projectedState(stage: Stage, via: ProductionAction, warranty: boolean): ProjectedState | null {
  switch (stage) {
    case "ready":
      return "pending_lab";
    case "printed":
      // Back at printed for a warranty remake after the glasses were
      // labelled or delivered: the customer is told a new pair is being
      // made. A remake after a QC failure is still the first pair being
      // made, as far as the customer is concerned.
      if (via === "REMAKE_STARTED") return warranty ? "remake_required" : "in_production";
      return "sent_to_lab";
    case "lens_issued":
    case "sent_to_lab":
    case "received_from_lab":
    case "edged":
    case "mounted":
      return "in_production";
    case "qc_passed":
      return "qc_pass";
    case "qc_failed":
      return "qc_fail";
    case "packed":
      return "assembled";
    case "labelled":
    case "delivered":
    case "cancelled":
      return null;
  }
}

export type ProjectionMessage = {
  medusa_order_id: string;
  state: ProjectedState;
  sequence: number;
  /** When it happened in the lab (the paper-log time when one was typed). */
  occurred_at: string;
  /** Warranty remakes started on the job so far. A message whose cycle is
   *  above the one the Website last applied belongs to a remake after the
   *  glasses shipped, and may move a shipped or delivered order. */
  warranty_cycle: number;
};

export type ProjectionColumns = {
  order_id: string;
  projection_state: string | null;
  projection_seq: number;
  projection_at: Date | string | null;
  warranty_remakes: number;
};

/** The message for a job's latest state, or null if it has none. */
export function projectionMessage(job: ProjectionColumns): ProjectionMessage | null {
  if (!job.projection_state || !job.projection_at || !(job.projection_seq > 0)) return null;
  if (!(PROJECTED_STATES as readonly string[]).includes(job.projection_state)) return null;
  return {
    medusa_order_id: job.order_id,
    state: job.projection_state as ProjectedState,
    sequence: Number(job.projection_seq),
    occurred_at: new Date(job.projection_at).toISOString(),
    warranty_cycle: Number(job.warranty_remakes ?? 0),
  };
}

/**
 * Did the Website take the message? Applied, or ignored (an older sequence,
 * a closed order, a shipped order, the state it already shows), both mean
 * it need not be sent again. Anything else, including "not ready" (the
 * order is not known to the Website yet), is sent again later.
 */
export function isAcknowledged(status: number, body: unknown): boolean {
  if (status !== 200 || !body || typeof body !== "object") return false;
  const b = body as { ok?: unknown; outcome?: unknown };
  return b.ok === true && (b.outcome === "applied" || b.outcome === "ignored");
}
