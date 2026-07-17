import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { LMS_MODULE } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";

/**
 * GET /admin/lab-jobs — list lab jobs, optionally filtered by status.
 * Requires admin auth (Medusa Admin's standard auth gate; the route
 * lives under /admin and is gated by the dashboard cookie).
 *
 * Status filter: ?status=queued|submitted|failed|cancelled
 * Limit: ?limit=N (default 100, max 500)
 *
 * Response shape mirrors the LabJobRow type from lms/service.ts.
 *
 * **PDPA note**: this endpoint returns `packet_snapshot` which
 * contains decrypted Rx data. The Medusa Admin dashboard requires a
 * superadmin/ops Medusa user to call it. Don't add this route's data
 * to logs, Sentry, or any persistent storage outside Medusa's DB.
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
        | "submitted"
        | "failed"
        | "cancelled"
        | "pending_rx",
      limit,
    );
  } else {
    jobs = await lms.listLabJobs({}, { take: limit });
  }

  res.json({ jobs, count: jobs.length });
}
