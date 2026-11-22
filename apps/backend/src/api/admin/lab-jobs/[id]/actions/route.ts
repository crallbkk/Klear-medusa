import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import {
  LAB_ACTIONS,
  actorOf,
  readActionBody,
  resultFor,
  sendProductionError,
} from "../../production-http";

/**
 * POST /admin/lab-jobs/[id]/actions: record one step the lab took on a job.
 *
 *   { action, idempotency_key, expected_version, detail?, happened_at? }
 *
 * `idempotency_key` is made by the screen when it shows the button, so a
 * second press or a retried request returns the first result. A step that
 * moves the job needs `expected_version`, the `stage_version` the screen
 * was showing; if the job has moved since, the answer is 409 and the screen
 * reloads. Answers `{ event, job, replayed }`; the job never includes the
 * packet.
 *
 * Hold and release are ops steps (`/ops-actions`). Label, delivery, cancel
 * and a changed prescription are recorded by the system, not here.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const actor = actorOf(req, res);
  if (!actor) return;
  const body = readActionBody(req, res, LAB_ACTIONS);
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
    sendProductionError(res, err, "admin/lab-jobs/actions", id);
  }
}
