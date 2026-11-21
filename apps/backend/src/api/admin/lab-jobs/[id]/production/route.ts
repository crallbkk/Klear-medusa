import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import { publicEvent, sendProductionError, withoutPacket } from "../../production-http";

/**
 * GET /admin/lab-jobs/[id]/production: a job for the job screen. Its
 * production state, its history and its outside-lab quotes. Never the
 * packet: that is `POST /admin/lab-jobs/[id]/packet`, which records who
 * looked.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const id = req.params.id;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const job = await lms.retrieveLabJob(id);
    const [events, costs] = await Promise.all([
      lms.listProductionEventsForJob(id),
      lms.listLabCosts({ lab_job_id: id }, { order: { created_at: "ASC" }, take: 100 }),
    ]);
    res.json({
      job: withoutPacket(job as unknown as Record<string, unknown>),
      events: events.map((e) => publicEvent(e as unknown as Record<string, unknown>)),
      costs,
    });
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/production", id);
  }
}
