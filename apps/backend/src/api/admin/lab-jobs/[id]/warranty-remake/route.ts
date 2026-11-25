import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { startWarrantyRemake } from "../../../../../modules/lms/rebuild";
import type { ProductionAction } from "../../../../../modules/lms/production";
import {
  NOT_BUILT,
  actorOf,
  readActionBody,
  resultFor,
  sendProductionError,
} from "../../production-http";

const ONLY_REMAKE: ReadonlySet<ProductionAction> = new Set<ProductionAction>(["REMAKE_STARTED"]);

/**
 * POST /admin/lab-jobs/[id]/warranty-remake: start a remake on a labelled
 * or delivered job whose readable prescription was removed from the packet
 * (that happens some time after delivery).
 *
 *   { action: "REMAKE_STARTED", idempotency_key, expected_version, detail: { cause } }
 *
 * The packet is built again from the order, which decrypts the customer's
 * stored prescription, and put back; then the remake is recorded as the
 * signed-in user. Needs the ops permission: the plain remake (`/actions`)
 * works from a packet the lab already has, this one fetches a prescription.
 *
 * Answers `{ event, job, replayed }` like `/actions`, never the packet. If
 * the prescription cannot be fetched (the customer's stored prescription is
 * gone, or the order no longer builds), 422 and nothing is changed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const actor = actorOf(req, res);
  if (!actor) return;
  const body = readActionBody(req, res, ONLY_REMAKE);
  if (!body) return;
  // Checked here, before a job is read or a prescription fetched.
  const bad = (message: string) => res.status(400).json({ type: "invalid_data", message });
  if (body.idempotency_key.length < 8 || body.idempotency_key.length > 200) {
    bad("idempotency_key must be 8 to 200 characters");
    return;
  }
  if (body.expected_version === undefined) {
    bad("expected_version is required");
    return;
  }
  const cause = body.detail?.cause;
  if (typeof cause !== "string" || cause.trim() === "" || cause.length > 500) {
    bad("detail.cause is required, at most 500 characters");
    return;
  }
  const id = req.params.id;
  try {
    const done = await startWarrantyRemake(req.scope, {
      job_id: id,
      idempotency_key: body.idempotency_key,
      expected_version: body.expected_version,
      cause,
      actor_id: actor,
    });
    if (done.outcome === "not_built") {
      res.status(422).json({
        type: "not_allowed",
        outcome: "not_built",
        buildOutcome: done.buildOutcome,
        message: `the prescription could not be fetched for the remake: ${NOT_BUILT[done.buildOutcome]}`,
      });
      return;
    }
    res.json(resultFor(req, done.result));
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/warranty-remake", id);
  }
}
