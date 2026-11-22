import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import { actorOf, jobFor, packetFor, sendProductionError } from "../../production-http";

/**
 * POST /admin/lab-jobs/[id]/packet: show the lab packet, which holds the
 * prescription, and record who looked.
 *
 * Body `{ idempotency_key, printed? }`. The view is recorded (PACKET_VIEWED,
 * or PACKET_PRINTED with `printed: true`) BEFORE the packet is returned: if
 * it cannot be recorded, the packet is not shown.
 *
 * A POST, because it writes. Refused (409) when the job has no packet to
 * work from: still waiting for a prescription, failed, a prescription that
 * changed and is not rebuilt yet (the stored packet is then the OLD one),
 * or one removed after delivery.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const actor = actorOf(req, res);
  if (!actor) return;
  const body = (req.body ?? {}) as { idempotency_key?: unknown; printed?: unknown };
  if (typeof body.idempotency_key !== "string") {
    res.status(400).json({ type: "invalid_data", message: "idempotency_key is required" });
    return;
  }
  const id = req.params.id;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const seen = await lms.viewPacket(id, actor, body.idempotency_key, body.printed === true);
    res.json({
      ...seen,
      packet: packetFor(req, id, seen.packet as unknown as Record<string, unknown>),
      job: jobFor(req, seen.job as unknown as Record<string, unknown>),
    });
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/packet", id);
  }
}
