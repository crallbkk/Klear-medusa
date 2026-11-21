import releaseLabUsageJob from "../release-lab-usage";
import { LMS_MODULE } from "../../modules/lms/service";
import { captureException } from "../../lib/observability/sentry";

jest.mock("../../lib/observability/sentry", () => ({ captureException: jest.fn() }));

function run(lms: unknown) {
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === LMS_MODULE) return lms;
      throw new Error(`unexpected resolve(${key})`);
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return releaseLabUsageJob(container as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("release-lab-usage scheduled job", () => {
  it("releases what is due and then checks nothing was left behind", async () => {
    const lms = {
      releaseDueWindows: jest
        .fn()
        .mockResolvedValue([{ window_start: "2026-11-02", window_end: "2026-11-08" }]),
      unreleasedUsageDrift: jest.fn().mockResolvedValue(0),
    };
    await run(lms);
    expect(lms.releaseDueWindows).toHaveBeenCalledTimes(1);
    expect(lms.unreleasedUsageDrift).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("reports usage that sits inside a released window and was not released", async () => {
    const lms = {
      releaseDueWindows: jest.fn().mockResolvedValue([]),
      unreleasedUsageDrift: jest.fn().mockResolvedValue(2),
    };
    await run(lms);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(String((captureException as jest.Mock).mock.calls[0][0])).toMatch(/2 total/);
  });

  it("never throws: a failed release is reported and the next run tries again", async () => {
    const lms = {
      releaseDueWindows: jest.fn().mockRejectedValue(new Error("db down")),
      unreleasedUsageDrift: jest.fn(),
    };
    await expect(run(lms)).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
