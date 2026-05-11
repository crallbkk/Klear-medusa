import {
  type ILabProvider,
  type LabJobPacket,
  type LabJobStatusReport,
} from "./types";
import { UnimplementedLabProvider } from "./providers/_unimplemented";

export const LMS_MODULE = "lms";

export default class LmsModuleService {
  // Provider selection is decision-driven (DECISIONS.md #4). Until a lab
  // partner is signed, every call to submitJob/getJobStatus throws loudly.
  // To wire a real provider: import and switch on process.env.LAB_PROVIDER.
  private readonly provider: ILabProvider = new UnimplementedLabProvider();

  async submitJob(packet: LabJobPacket): Promise<{ provider_job_id: string }> {
    return this.provider.submitJob(packet);
  }

  async getJobStatus(providerJobId: string): Promise<LabJobStatusReport> {
    return this.provider.getJobStatus(providerJobId);
  }

  getProviderName(): string {
    return this.provider.name;
  }
}
