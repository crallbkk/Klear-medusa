import {
  type ILabProvider,
  type LabJobPacket,
  type LabJobStatusReport,
  LabProviderError,
} from "../types";

const NOT_IMPLEMENTED_MSG =
  "Lab provider not yet selected. See DECISIONS.md #3 (Bangkok 3D-scan vendor) " +
  "and #4 (optical lab partner). Replace UnimplementedLabProvider once the " +
  "partner contract is signed.";

export class UnimplementedLabProvider implements ILabProvider {
  readonly name = "unimplemented";

  async submitJob(_packet: LabJobPacket): Promise<{ provider_job_id: string }> {
    throw new LabProviderError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async getJobStatus(_provider_job_id: string): Promise<LabJobStatusReport> {
    throw new LabProviderError("not_implemented", NOT_IMPLEMENTED_MSG);
  }
}
