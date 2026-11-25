import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { LMS_MODULE } from "../../../../modules/lms/service";
import type LmsModuleService from "../../../../modules/lms/service";
import { jobFor } from "../production-http";

/**
 * GET /admin/lab-jobs/[id] — retrieve a single lab job by id, WITHOUT its
 * packet (the decrypted prescription). The packet is shown, one view at a
 * time and recorded, by `POST /admin/lab-jobs/[id]/packet`.
 * Returns 404 if not found.
 *
 * POST /admin/lab-jobs/[id]/retry — implemented in a sibling route.
 * Cancel comes from the Klear storefront's cancel flow which updates
 * the linked job via the lms service.
 */
export async function GET(
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
    const job = await lms.retrieveLabJob(id);
    if (!job) {
      res.status(404).json({ error: "lab_job not found" });
      return;
    }
    res.json({ job: jobFor(req, job as unknown as Record<string, unknown>) });
  } catch {
    res.status(404).json({ error: "lab_job not found" });
  }
}
