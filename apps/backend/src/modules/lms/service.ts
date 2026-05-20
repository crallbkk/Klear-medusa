import { MedusaService } from "@medusajs/framework/utils";
import LabJob from "./models/lab-job";
import {
  type ILabProvider,
  type LabJobPacket,
  type LabJobStatusReport,
  LabProviderError,
} from "./types";
import { UnimplementedLabProvider } from "./providers/_unimplemented";

export const LMS_MODULE = "lms";

export type LabJobRow = {
  id: string;
  order_id: string;
  status: "queued" | "submitted" | "failed" | "cancelled";
  packet_snapshot: LabJobPacket;
  provider_job_id: string | null;
  provider_name: string | null;
  attempts: number;
  last_error: string | null;
  submitted_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Lab Management System (LMS) service.
 *
 * Two responsibilities:
 *   1. Persist lab_job rows for every order that's gone through
 *      lab-handoff (queued / submitted / failed / cancelled lifecycle).
 *   2. Wrap the abstract `ILabProvider` for submission + status checks.
 *      The provider is `UnimplementedLabProvider` until a lab partner
 *      is selected (DECISIONS.md #3 + #4) — `submitJob()` throws, and
 *      the job stays in `queued` status. Switching providers is a
 *      single-line change.
 *
 * **PDPA boundary**: the `packet_snapshot` JSON column carries
 * plaintext Rx data because the lab needs it. Never log this column,
 * never include it in audit payloads, never expose it from the
 * customer-facing Store API.
 */
class LmsModuleService extends MedusaService({
  LabJob,
}) {
  private readonly provider: ILabProvider = new UnimplementedLabProvider();

  /** Create a queued lab_job row. Caller (subscriber) is responsible
   *  for first composing the packet via buildLabJobPacket. Returns the
   *  persisted job. */
  async createJob(packet: LabJobPacket): Promise<LabJobRow> {
    const created = (await this.createLabJobs({
      order_id: packet.klear_order_id,
      status: "queued",
      packet_snapshot: packet as unknown as Record<string, unknown>,
      attempts: 0,
    })) as unknown as LabJobRow;
    return created;
  }

  async getJobByOrderId(orderId: string): Promise<LabJobRow | null> {
    const rows = (await this.listLabJobs({
      order_id: orderId,
    })) as unknown as LabJobRow[];
    if (rows.length === 0) return null;
    rows.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return rows[0]!;
  }

  async listJobsByStatus(
    status: LabJobRow["status"],
    limit = 100,
  ): Promise<LabJobRow[]> {
    return (await this.listLabJobs(
      { status },
      { take: limit },
    )) as unknown as LabJobRow[];
  }

  /**
   * Attempt to submit a queued job to the configured lab provider.
   * On success → status="submitted", provider_job_id populated.
   * On provider error → status="failed", last_error populated, attempts++.
   * Provider not implemented → status stays "queued" (logged via attempts++).
   */
  async submitJob(
    jobId: string,
  ): Promise<{ outcome: "submitted" | "failed" | "queued_no_provider"; job: LabJobRow }> {
    const job = (await this.retrieveLabJob(jobId)) as unknown as LabJobRow;
    if (!job) throw new Error(`submitJob: job ${jobId} not found`);
    if (job.status === "submitted") {
      return { outcome: "submitted", job };
    }
    if (job.status === "cancelled") {
      throw new Error(
        `submitJob: job ${jobId} is cancelled — cannot resubmit`,
      );
    }

    try {
      const { provider_job_id } = await this.provider.submitJob(
        job.packet_snapshot,
      );
      const updated = (await this.updateLabJobs({
        selector: { id: jobId },
        data: {
          status: "submitted",
          provider_job_id,
          provider_name: this.provider.name,
          attempts: job.attempts + 1,
          last_error: null,
          submitted_at: new Date(),
        },
      })) as unknown as LabJobRow[];
      return { outcome: "submitted", job: updated[0]! };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      const truncated = message.slice(0, 500);

      if (
        err instanceof LabProviderError &&
        err.code === "not_implemented"
      ) {
        // Expected pre-lab-partner state — leave queued, just count attempt.
        const updated = (await this.updateLabJobs({
          selector: { id: jobId },
          data: {
            attempts: job.attempts + 1,
            last_error: truncated,
          },
        })) as unknown as LabJobRow[];
        return { outcome: "queued_no_provider", job: updated[0]! };
      }

      const updated = (await this.updateLabJobs({
        selector: { id: jobId },
        data: {
          status: "failed",
          attempts: job.attempts + 1,
          last_error: truncated,
        },
      })) as unknown as LabJobRow[];
      return { outcome: "failed", job: updated[0]! };
    }
  }

  /** Mark a queued / failed / submitted job as cancelled. Called when
   *  the customer cancels before lab production starts. */
  async cancelJob(jobId: string): Promise<LabJobRow> {
    const updated = (await this.updateLabJobs({
      selector: { id: jobId },
      data: { status: "cancelled" },
    })) as unknown as LabJobRow[];
    if (!updated[0]) throw new Error(`cancelJob: job ${jobId} not found`);
    return updated[0];
  }

  /** Pass-through to the provider for lab-side status checks. */
  async getProviderJobStatus(
    providerJobId: string,
  ): Promise<LabJobStatusReport> {
    return this.provider.getJobStatus(providerJobId);
  }

  getProviderName(): string {
    return this.provider.name;
  }
}

export default LmsModuleService;
