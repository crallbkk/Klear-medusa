import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../modules/lms/service";
import type LmsModuleService from "../../../modules/lms/service";
import { captureException } from "../../../lib/observability/sentry";
import { errorKind } from "../lab-jobs/production-http";

/**
 * GET /admin/lab-reports?weeks=N: the lab's report over the last N weeks
 * (1 to 52, 12 if not given): lenses used per week by reason with the
 * spoilage and remake rates, and lenses per job against its remake count.
 * Counts only: no lens SKU, no packet.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const asked = (req.query as Record<string, unknown>).weeks;
  // A whole number is taken, kept between 1 and 52. Anything else is 12.
  const weeks =
    typeof asked === "string" && /^\d{1,9}$/.test(asked)
      ? Math.min(Math.max(Number(asked), 1), 52)
      : 12;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    res.json(await lms.productionReport(weeks));
  } catch (err) {
    // A database error's own text can hold values; report its kind only.
    const kind = errorKind(err);
    console.error(`[admin/lab-reports] failed: ${kind}`);
    captureException(new Error(`admin/lab-reports failed: ${kind}`), {
      tags: { route: "admin/lab-reports" },
    });
    res.status(500).json({ type: "unexpected_state", message: "the report could not be built; try again" });
  }
}
