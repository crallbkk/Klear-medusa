import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import { packedBeforeLabelRequired } from "../../../modules/lms/order-events";

/**
 * Middleware on `POST /admin/orders/:id/fulfillments`: a shipping label
 * cannot be booked for an order whose glasses are not boxed.
 *
 * It runs BEFORE Medusa's create-fulfillment workflow, so nothing has been
 * booked with the carrier when it refuses. (That workflow's only hook,
 * `fulfillmentCreated`, runs after the label exists; refusing there would
 * book a label and then cancel it.)
 *
 * Refuses when the order's lab job is at a stage BEFORE `packed`, or has no
 * stage because its packet was never built (still waiting for a
 * prescription, or failed). Lets through:
 *   - an order with no lab job (frame only);
 *   - a job at `packed`;
 *   - a job at `labelled` or `delivered`: the glasses are out, and this is
 *     another parcel on the same order (an accessory, a claim's replacement
 *     items, a label booked again after one was cancelled). Medusa's own
 *     quantity check stops the same items being fulfilled twice;
 *   - a job with no stage whose packet is built (it predates production:
 *     nothing here can say where the glasses are);
 *   - a cancelled job (Medusa decides what a cancelled order may do).
 *
 * Not covered: `POST /admin/fulfillments` creates a fulfillment without an
 * order route and emits no order event. The order page does not use it.
 *
 * Off unless LMS_REQUIRE_PACKED_BEFORE_LABEL=true: until the lab works in
 * the lab system, no job ever reaches `packed`, and this would stop every
 * lens order from shipping.
 */
export async function requirePackedBeforeLabel(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  if (!packedBeforeLabelRequired()) return next();
  const orderId = req.params?.id;
  // No signed-in admin: say nothing about the order; let auth answer.
  const actor = (req as { auth_context?: { actor_id?: string } }).auth_context?.actor_id;
  if (!orderId || !actor) return next();

  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const job = await lms.getJobByOrderId(orderId);
    if (!job) return next();
    if (job.stage === null) {
      const built =
        job.status === "queued" || job.status === "submitting" || job.status === "submitted";
      if (built) return next();
      res.status(409).json({
        type: "not_allowed",
        message: `This order's lenses cannot be made yet (the lab job is "${job.status}"). Fix the lab job, then book the label.`,
      });
      return;
    }
    if (
      job.stage === "packed" ||
      job.stage === "labelled" ||
      job.stage === "delivered" ||
      job.stage === "cancelled"
    ) {
      return next();
    }
    res.status(409).json({
      type: "not_allowed",
      message: `This order's glasses are not packed yet (the lab job is at "${job.stage}"). Pack the job in the lab queue, then book the label.`,
    });
  } catch (err) {
    next(err);
  }
}
