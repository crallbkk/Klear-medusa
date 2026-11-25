import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import {
  OPS_ACTIONS,
  actorOf,
  readActionBody,
  resultFor,
  sendProductionError,
} from "../../production-http";

/**
 * POST /admin/lab-jobs/[id]/ops-actions: put a job on hold or release it,
 * enter an outside lab's bill, or write off a quote it will never bill.
 * Same body and answer as `/actions`; needs the ops permission.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const actor = actorOf(req, res);
  if (!actor) return;
  const body = readActionBody(req, res, OPS_ACTIONS);
  if (!body) return;
  const id = req.params.id;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const done = await lms.applyProductionAction({
      job_id: id,
      ...body,
      actor: { type: "user", id: actor },
    });
    res.json(resultFor(req, done));
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/ops-actions", id);
  }
}
