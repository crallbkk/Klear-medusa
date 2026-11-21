import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { LMS_MODULE } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import { withoutPacket } from "./production-http";

/**
 * GET /admin/lab-jobs — list lab jobs, optionally filtered by status.
 * Requires admin auth (Medusa Admin's standard auth gate; the route
 * lives under /admin and is gated by the dashboard cookie).
 *
 * Status filter: ?status=queued|submitting|submitted|failed|cancelled|pending_rx
 *   (oldest first: the work queue). Without a status: newest first.
 * Limit: ?limit=N (default 100, max 500)
 *
 * Response shape mirrors the LabJobRow type from lms/service.ts.
 *
 * The packet (`packet_snapshot`, which holds the decrypted prescription) is
 * NOT in the response. A list is no place for it, and nothing recorded who
 * read it. One packet at a time is shown by
 * `POST /admin/lab-jobs/[id]/packet`, which records the view.
 */
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;

  const rawLimit = req.query.limit;
  const limit =
    typeof rawLimit === "string"
      ? Math.min(Math.max(parseInt(rawLimit, 10) || 100, 1), 500)
      : 100;

  const status = req.query.status as string | undefined;
  const validStatuses = [
    "queued",
    "submitting",
    "submitted",
    "failed",
    "cancelled",
    "pending_rx",
  ];

  let jobs;
  if (status && validStatuses.includes(status)) {
    jobs = await lms.listJobsByStatus(
      status as
        | "queued"
        | "submitting"
        | "submitted"
        | "failed"
        | "cancelled"
        | "pending_rx",
      limit,
    );
  } else {
    // Newest first. Without an order Postgres returns rows in no defined
    // order, so the capped list could leave out the jobs ops is looking for.
    jobs = await lms.listLabJobs(
      {},
      { take: limit, order: { created_at: "DESC", id: "DESC" } },
    );
  }

  res.json({
    jobs: jobs.map((job) => withoutPacket(job as unknown as Record<string, unknown>)),
    count: jobs.length,
  });
}
