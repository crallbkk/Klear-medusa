import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import {
  offeredActions,
  type JobState,
  type PacketState,
} from "../../../../../modules/lms/production";
import { alsoOffered } from "../../../../../modules/lms/board";
import {
  LAB_ACTIONS,
  OPS_ACTIONS,
  publicEvent,
  sendProductionError,
  withoutPacket,
} from "../../production-http";

/**
 * GET /admin/lab-jobs/[id]/production: a job for the job screen. Its
 * production state, its history, its outside-lab quotes, the steps that can
 * be recorded on it now (`actions.lab` through `/actions`, `actions.ops`
 * through `/ops-actions`), whether its packet can be shown, whether Retry
 * or a changed prescription would be accepted, and the outside labs used.
 *
 * The offered steps come from the production rules themselves, so the
 * screen shows a button exactly when the step would be accepted. Never the
 * packet: that is `POST /admin/lab-jobs/[id]/packet`, which records who
 * looked.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const id = req.params.id;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const job = await lms.retrieveLabJob(id);
    const [events, costs, vendors] = await Promise.all([
      lms.listProductionEventsForJob(id),
      lms.listLabCosts({ lab_job_id: id }, { order: { created_at: "ASC" }, take: 100 }),
      lms.listLabVendors(),
    ]);
    // An invoice is entered against a quote that has none yet; with no such
    // quote the writer refuses it, so the screen does not offer it.
    const quoteOpen = (costs as Array<{ invoiced_satang: number | null }>).some(
      (c) => c.invoiced_satang === null || c.invoiced_satang === undefined,
    );
    const offered = offeredActions(job as unknown as JobState & PacketState).filter(
      (a) => a !== "LAB_INVOICED" || quoteOpen,
    );
    res.json({
      job: withoutPacket(job as unknown as Record<string, unknown>),
      events: events.map((e) => publicEvent(e as unknown as Record<string, unknown>)),
      costs,
      actions: {
        lab: offered.filter((a) => LAB_ACTIONS.has(a)),
        ops: offered.filter((a) => OPS_ACTIONS.has(a)),
        ...alsoOffered(job as unknown as Parameters<typeof alsoOffered>[0]),
      },
      vendors,
    });
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/production", id);
  }
}
