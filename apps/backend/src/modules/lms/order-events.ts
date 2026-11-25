// What Medusa's order events mean for a lab job.
//
// The lab job follows the order: a shipping label booked moves it to
// `labelled`, a cancelled label back to `packed`, a delivery to `delivered`,
// a cancelled order to `cancelled`. These are recorded by the system, never
// by a person, through the same writer as every other production action.
//
// An order with no lab job (frame only) is not production's business: every
// function here returns "no_job" and does nothing.

import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { captureException, captureMessage } from "../../lib/observability/sentry";
import { ProductionError, type ProductionAction } from "./production";
import { LMS_MODULE, ProductionWriteError, failureKind, reportableError } from "./service";
import type LmsModuleService from "./service";

export type OrderEventOutcome =
  | "recorded" // the job moved
  | "repeat" // this event had already been recorded
  | "no_job" // the order has no lab job
  | "refused"; // the job is not at a stage this event applies to

/**
 * The lab must work in the lab system before a label is booked: with this
 * on, a label cannot be booked for an order whose job is not `packed`, and a
 * job that is somewhere else when a label or delivery arrives is reported as
 * a fault. Off (the default) until the lab's screens exist: orders are still
 * made and shipped outside the lab system, so a job standing at `ready` when
 * its label is booked is expected and only logged.
 */
export function packedBeforeLabelRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LMS_REQUIRE_PACKED_BEFORE_LABEL === "true";
}

/**
 * Record a system action on the lab job of an order.
 *
 * @param key  unique to the thing that happened (a fulfillment id, an order
 *             id), so a redelivered event records nothing twice.
 * @param fulfillmentId  for LABEL_CANCELLED and DELIVERED: the fulfillment
 *             the event is about. An order can have several (an accessory,
 *             a split parcel, a claim's replacement). Only the one whose
 *             label moved the job to `labelled` may cancel that label or
 *             deliver the job; the others are refused.
 */
export async function recordOrderEvent(
  container: MedusaContainer,
  orderId: string,
  action: Extract<ProductionAction, "LABELLED" | "LABEL_CANCELLED" | "DELIVERED" | "CANCELLED">,
  key: string,
  source: string,
  fulfillmentId?: string,
): Promise<OrderEventOutcome> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;
  const job = await lms.getJobByOrderId(orderId);
  if (!job) return "no_job";

  /** An event that does not fit the job: a fault once the lab works in the
   *  lab system, a log line before that and for jobs from before production. */
  const refuse = (stage: string | null, why: string): "refused" => {
    const line = `[lms] ${action} for order ${orderId} not recorded: ${why}`;
    if (packedBeforeLabelRequired() && stage !== null) {
      console.warn(line);
      captureMessage(`[lms] an order event did not fit its lab job's stage`, {
        level: "warning",
        tags: { module: "lms", reason: "order_event_refused", action },
        extra: { order_id: orderId, lab_job_id: job.id, stage },
      });
    } else {
      console.info(line);
    }
    return "refused";
  };

  const record = async (a: typeof action, k: string) =>
    lms.applyProductionAction({
      job_id: job.id,
      action: a,
      idempotency_key: k,
      actor: { type: "system", id: source },
    });

  if (fulfillmentId && (action === "LABEL_CANCELLED" || action === "DELIVERED")) {
    const labelledBy = await lms.lastLabelKey(job.id);
    if (labelledBy !== `labelled:${fulfillmentId}` && !(await lms.hasProductionEventKey(key))) {
      return refuse(
        job.stage,
        `fulfillment ${fulfillmentId} is not the one that labelled lab job ${job.id}`,
      );
    }
  }

  try {
    const result = await record(action, key);
    return result.replayed ? "repeat" : "recorded";
  } catch (err) {
    if (!(err instanceof ProductionError && err.code === "not_allowed")) throw err;
    // Read again: the refusal was decided on the job as it is now.
    const now = (await lms.getJobByOrderId(orderId)) ?? job;
    // A cancelled order whose job is already cancelled is simply done.
    if (action === "CANCELLED" && now.stage === "cancelled") return "repeat";

    // A new label for a job still marked as labelled by an earlier
    // fulfillment. If that earlier one is cancelled in Medusa, its cancel
    // event was lost: record it now, then this label. If it is still live,
    // this is another parcel on the order and not the glasses' label.
    if (action === "LABELLED" && now.stage === "labelled" && fulfillmentId) {
      const previous = (await lms.lastLabelKey(job.id))?.replace(/^labelled:/, "");
      if (previous && previous !== fulfillmentId && (await isCancelledInMedusa(container, previous))) {
        await record("LABEL_CANCELLED", `label-cancelled:${previous}`);
        const result = await record("LABELLED", key);
        return result.replayed ? "repeat" : "recorded";
      }
    }
    return refuse(now.stage, `lab job ${job.id} is ${now.stage ?? "not ready"}`);
  }
}

/** Is this fulfillment cancelled in Medusa? False when it cannot be told. */
async function isCancelledInMedusa(container: MedusaContainer, fulfillmentId: string): Promise<boolean> {
  try {
    const query = container.resolve(ContainerRegistrationKeys.QUERY);
    const { data } = await query.graph({
      entity: "fulfillment",
      fields: ["id", "canceled_at"],
      filters: { id: [fulfillmentId] },
    });
    return Boolean((data?.[0] as { canceled_at?: unknown } | undefined)?.canceled_at);
  } catch {
    return false;
  }
}

/**
 * Subscriber wrapper. The event bus delivers an event once (the Redis bus
 * defaults to a single attempt), so a write that fails for a passing reason
 * (a lock timeout, a job that moved underneath) is tried again here, up to
 * three times. It never throws; what still fails is reported with ids only.
 */
export async function recordOrderEventSafely(
  container: MedusaContainer,
  orderId: string,
  action: Parameters<typeof recordOrderEvent>[2],
  key: string,
  source: string,
  fulfillmentId?: string,
): Promise<OrderEventOutcome | "failed"> {
  const ATTEMPTS = 3;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await recordOrderEvent(container, orderId, action, key, source, fulfillmentId);
      } catch (err) {
        const passing =
          err instanceof ProductionWriteError ||
          (err instanceof ProductionError && err.code === "conflict");
        if (!passing || attempt >= ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
  } catch (err) {
    console.error(`[lms] ${action} for order ${orderId} failed: ${failureKind(err)}`);
    captureException(reportableError(err, `lms order event ${action}`), {
      tags: { module: "lms", reason: "order_event_failed", action },
      extra: { order_id: orderId },
    });
    return "failed";
  }
}
