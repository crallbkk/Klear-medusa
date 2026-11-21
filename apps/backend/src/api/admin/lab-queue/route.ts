import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE, QUEUE_LIMIT } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import {
  OVERDUE_AFTER_HOURS,
  OVERDUE_WAITING_HOURS,
  boardColumn,
  isOverdue,
} from "../../../modules/lms/board";

/**
 * GET /admin/lab-queue: every job the lab still has work on, for the queue
 * board, the longest-waiting first. Jobs that are delivered or cancelled
 * are not on the board unless a cut-or-uncut question is still open on
 * them. A job that has not reached production because its packet failed or
 * its prescription has not arrived is on it, so that it is seen.
 *
 * Each job carries the `column` it belongs in and whether it is `overdue`;
 * the board holds no rules of its own. Never includes a packet.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
  const all = await lms.listQueue();
  const now = new Date();
  const jobs = all.slice(0, QUEUE_LIMIT).map((job) => ({
    ...job,
    column: boardColumn(job),
    overdue: isOverdue(job, now),
  }));
  const counts: Record<string, number> = {};
  for (const job of jobs) counts[job.column] = (counts[job.column] ?? 0) + 1;
  res.json({
    jobs,
    counts,
    overdue: jobs.filter((j) => j.overdue).length,
    overdue_after_hours: { ...OVERDUE_AFTER_HOURS, ...OVERDUE_WAITING_HOURS },
    truncated: all.length > QUEUE_LIMIT,
  });
}
