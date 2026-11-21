import type { MedusaContainer } from "@medusajs/framework/types";
import { LMS_MODULE } from "../modules/lms/service";
import type LmsModuleService from "../modules/lms/service";
import { captureException } from "../lib/observability/sentry";

/**
 * Scheduled job: release finished usage windows to Klear Operations.
 *
 * Lens and frame usage is recorded per job inside the lab module. Operations
 * is told totals per release window (a week, cut at every month end; see
 * `modules/lms/release.ts`). This job writes each window that has ended and
 * has not been released: its marker, its totals per SKU and reason, and the
 * lab totals as of its last day. Operations then reads them from
 * `GET /ops-feed/lab-releases`.
 *
 * Hourly, not weekly: the work is "release whatever is due", so a run that
 * finds nothing costs one query, and a missed run (a deploy, an outage) is
 * made up by the next one instead of waiting a week.
 */
export default async function releaseLabUsageJob(container: MedusaContainer): Promise<void> {
  const lms = container.resolve(LMS_MODULE) as LmsModuleService;
  try {
    const released = await lms.releaseDueWindows();
    if (released.length > 0) {
      console.info(
        `[release-lab-usage] released ${released.length} window(s), up to ${
          released[released.length - 1].window_end
        }`,
      );
    }
  } catch (err) {
    console.error(
      `[release-lab-usage] release failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    captureException(err, { tags: { job: "release-lab-usage", reason: "release_failed" } });
    return;
  }

  // Every piece dated inside a released window must be in a released total.
  try {
    const drift = await lms.unreleasedUsageDrift();
    if (drift !== 0) {
      const err = new Error(
        `${drift} total(s) released to Klear Operations disagree with the lab's usage rows: usage was written into a window after its release`,
      );
      console.error(`[release-lab-usage] ${err.message}`);
      captureException(err, { tags: { job: "release-lab-usage", reason: "usage_drift" } });
    }
  } catch (err) {
    captureException(err, { tags: { job: "release-lab-usage", reason: "drift_check_failed" } });
  }
}

export const config = {
  name: "release-lab-usage",
  // Ten past every hour. A window ends at midnight in Bangkok (17:00 UTC);
  // the first run after that is 17:10 UTC.
  schedule: "10 * * * *",
};
