import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { applyChangedPrescription } from "../../../../../modules/lms/rebuild";
import { PERSON_KEY } from "../../../../../modules/lms/service";
import { NOT_BUILT, actorOf, sendProductionError, withoutPacket } from "../../production-http";

/**
 * POST /admin/lab-jobs/[id]/rx-changed: the customer's prescription changed
 * after the lab may have started. Body `{ idempotency_key }`.
 *
 * Rebuilds the packet from the order, sends the job back to `ready`, and,
 * if a lens had been issued, asks whether it was cut. Needs the ops
 * permission. Answers:
 *
 *   changed            done; `job` is the job as it now stands (no packet)
 *   not_built          the new prescription is missing or not valid; the
 *                      job was not touched (`reason` says why)
 *   not_in_production  the job has no packet yet; use Retry
 *   too_late           a label exists, or the job is delivered or cancelled
 *
 * Keep the same key for one request. A new key is a new change.
 */
const TOO_LATE: Record<string, string> = {
  not_in_production: "this job has no packet yet; use Rebuild packet instead",
  too_late: "too late to change this job here: it has a label, is delivered or is cancelled",
};

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const actor = actorOf(req, res);
  if (!actor) return;
  const key = (req.body as { idempotency_key?: unknown } | undefined)?.idempotency_key;
  // Recorded by the system on the person's behalf, under the person's key,
  // so the key is held to a person's shape here.
  if (typeof key !== "string" || !PERSON_KEY.test(key)) {
    res.status(400).json({ type: "invalid_data", message: "idempotency_key is required" });
    return;
  }
  const id = req.params.id;
  try {
    const result = await applyChangedPrescription(req.scope, id, key, actor);
    if (result.outcome === "changed") {
      res.json({
        outcome: "changed",
        job: withoutPacket(result.job as unknown as Record<string, unknown>),
      });
      return;
    }
    if (result.outcome === "not_built") {
      res.status(422).json({
        outcome: "not_built",
        buildOutcome: result.buildOutcome,
        message: NOT_BUILT[result.buildOutcome],
      });
      return;
    }
    res.status(409).json({ ...result, message: TOO_LATE[result.outcome] });
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/rx-changed", id);
  }
}
