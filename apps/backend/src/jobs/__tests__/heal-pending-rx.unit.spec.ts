import healPendingRxJob from "../heal-pending-rx";
import { LMS_MODULE } from "../../modules/lms/service";
import { rebuildAndSubmitJob } from "../../modules/lms/rebuild";

jest.mock("../../modules/lms/rebuild", () => ({
  rebuildAndSubmitJob: jest.fn(),
}));

const mockRebuild = rebuildAndSubmitJob as jest.MockedFunction<
  typeof rebuildAndSubmitJob
>;

function makeLms(pending: Array<{ id: string; order_id: string }>) {
  return {
    listJobsByStatus: jest.fn().mockResolvedValue(pending),
  };
}

function runJob(lms: unknown) {
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === LMS_MODULE) return lms;
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return healPendingRxJob(container as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("heal-pending-rx scheduled job", () => {
  it("does nothing (no rebuild) when there are no pending_rx jobs", async () => {
    const lms = makeLms([]);
    await runJob(lms);
    expect(lms.listJobsByStatus).toHaveBeenCalledWith("pending_rx");
    expect(mockRebuild).not.toHaveBeenCalled();
  });

  it("rebuilds every pending_rx job — heals the ones whose Rx has landed, leaves the rest", async () => {
    const lms = makeLms([
      { id: "job_healed", order_id: "order_a" },
      { id: "job_waiting", order_id: "order_b" },
    ]);
    mockRebuild.mockImplementation(async (_c, jobId) =>
      jobId === "job_healed"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ buildOutcome: "ok", job: {}, submit: {} } as any)
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ buildOutcome: "pending_rx", job: {} } as any),
    );

    await runJob(lms);

    expect(mockRebuild).toHaveBeenCalledTimes(2);
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.anything(),
      "job_healed",
      "order_a",
    );
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.anything(),
      "job_waiting",
      "order_b",
    );
  });

  it("continues the sweep when one job's rebuild throws", async () => {
    const lms = makeLms([
      { id: "job_boom", order_id: "order_x" },
      { id: "job_ok", order_id: "order_y" },
    ]);
    mockRebuild.mockImplementation(async (_c, jobId) => {
      if (jobId === "job_boom") throw new Error("decrypt exploded");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { buildOutcome: "ok", job: {}, submit: {} } as any;
    });

    await expect(runJob(lms)).resolves.toBeUndefined();

    // The throwing job did not stop the second from being processed.
    expect(mockRebuild).toHaveBeenCalledTimes(2);
    expect(mockRebuild).toHaveBeenCalledWith(
      expect.anything(),
      "job_ok",
      "order_y",
    );
  });
});
