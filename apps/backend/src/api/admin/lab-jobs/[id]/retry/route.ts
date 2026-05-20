import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";

/**
 * POST /admin/lab-jobs/[id]/retry — re-attempt submission to the lab
 * provider for a queued or failed job. No body.
 *
 * Returns the updated job + outcome. When the provider is still
 * unimplemented, outcome is `queued_no_provider` and the job's
 * attempts counter increments.
 */
export async function POST(
  req: MedusaRequest<unknown>,
  res: MedusaResponse,
): Promise<void> {
  const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
  const id = req.params.id;
  if (!id) {
    res.status(400).json({ error: "id required" });
    return;
  }
  try {
    const result = await lms.submitJob(id);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Unknown error",
    });
  }
}
