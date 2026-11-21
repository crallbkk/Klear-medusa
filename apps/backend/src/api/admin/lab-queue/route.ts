import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE, QUEUE_LIMIT } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";

/**
 * GET /admin/lab-queue: every job the lab still has work on, for the queue
 * board, the longest-waiting first. Jobs that are delivered or cancelled,
 * and jobs with no production stage, are not on the board unless a
 * cut-or-uncut question is still open on them.
 *
 * Never includes a packet.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
  const all = await lms.listQueue();
  const jobs = all.slice(0, QUEUE_LIMIT);
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    const column = job.cut_question_pending ? "question" : job.on_hold ? "on_hold" : job.stage ?? "none";
    counts[column] = (counts[column] ?? 0) + 1;
  }
  res.json({ jobs, counts, truncated: all.length > QUEUE_LIMIT });
}
