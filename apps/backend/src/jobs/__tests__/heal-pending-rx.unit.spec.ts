import healPendingRxJob from "../heal-pending-rx";
import { LMS_MODULE, LabJobNotRebuildableError } from "../../modules/lms/service";
import { rebuildAndSubmitJob } from "../../modules/lms/rebuild";
import { captureException } from "../../lib/observability/sentry";

jest.mock("../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

jest.mock("../../modules/lms/rebuild", () => ({
  rebuildAndSubmitJob: jest.fn(),
}));

const mockRebuild = rebuildAndSubmitJob as jest.MockedFunction<
  typeof rebuildAndSubmitJob
>;

function makeLms(pending: Array<{ id: string; order_id: string }>) {
  return {
    listAllJobIdsByStatus: jest.fn().mockResolvedValue(pending),
    markStagelessJobsReady: jest.fn().mockResolvedValue(0),
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
    expect(lms.listAllJobIdsByStatus).toHaveBeenCalledWith("pending_rx");
    expect(mockRebuild).not.toHaveBeenCalled();
    // The stage sweep runs every pass, pending jobs or not.
    expect(lms.markStagelessJobsReady).toHaveBeenCalledTimes(1);
  });

  it("still heals pending jobs when the stage sweep fails", async () => {
    const lms = makeLms([{ id: "job_a", order_id: "order_a" }]);
    lms.markStagelessJobsReady.mockRejectedValue(new Error("db down"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockRebuild.mockResolvedValue({ buildOutcome: "ok", job: {}, submit: {} } as any);
    await runJob(lms);
    expect(mockRebuild).toHaveBeenCalledTimes(1);
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

  it("logs and reports a failure by its kind, never the error's own text", async () => {
    const leaky = () =>
      Object.assign(new Error("insert into lab_usage values ('LENS-SECRET-SKU')"), { code: "23505" });
    const lms = makeLms([{ id: "job_boom", order_id: "order_x" }]);
    lms.markStagelessJobsReady.mockRejectedValue(leaky());
    mockRebuild.mockRejectedValue(leaky());
    await runJob(lms);
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    const sent = (captureException as jest.Mock).mock.calls
      .map((c) => `${String(c[0]?.message)}\n${String(c[0]?.stack)}`)
      .join("\n");
    // The stage sweep and the rebuild: both failed.
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(logged).not.toMatch(/SECRET|insert into/);
    expect(sent).not.toMatch(/SECRET|insert into/);
    expect(logged).toContain("job_boom");
    expect(logged).toContain("Error/23505");
  });

  it("treats a concurrently-advanced job (LabJobNotRebuildableError) as benign — no error log", async () => {
    const lms = makeLms([
      { id: "job_raced", order_id: "order_r" },
      { id: "job_ok", order_id: "order_y" },
    ]);
    const errorSpy = console.error as jest.Mock;
    mockRebuild.mockImplementation(async (_c, jobId) => {
      if (jobId === "job_raced") {
        throw new LabJobNotRebuildableError(
          "updateJobFromBuild: job job_raced is submitted — only queued/failed/pending_rx jobs can be rebuilt",
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { buildOutcome: "ok", job: {}, submit: {} } as any;
    });

    await expect(runJob(lms)).resolves.toBeUndefined();

    // Both processed; the benign race did NOT produce an error log.
    expect(mockRebuild).toHaveBeenCalledTimes(2);
    const errorCalls = errorSpy.mock.calls.filter((c) =>
      String(c[0]).includes("heal failed"),
    );
    expect(errorCalls).toHaveLength(0);
  });
});
