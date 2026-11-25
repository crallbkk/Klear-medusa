import { recordOrderEvent } from "../order-events";
import { ProductionError } from "../production";
import { LMS_MODULE } from "../service";
import { captureMessage } from "../../../lib/observability/sentry";

jest.mock("../../../lib/observability/sentry", () => ({
  captureMessage: jest.fn(),
  captureException: jest.fn(),
}));

function container(job: unknown) {
  const lms = {
    getJobByOrderId: jest.fn().mockResolvedValue(job),
    lastLabelKey: jest.fn().mockResolvedValue("labelled:ful_other"),
    hasProductionEventKey: jest.fn().mockResolvedValue(false),
    applyProductionAction: jest
      .fn()
      .mockRejectedValue(new ProductionError("not_allowed", "LABELLED is not possible")),
  };
  return {
    lms,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    c: { resolve: (key: string) => (key === LMS_MODULE ? lms : undefined) } as any,
  };
}

describe("recordOrderEvent: an event that does not fit the job's stage", () => {
  const saved = process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (saved === undefined) delete process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
    else process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = saved;
  });

  it("is only logged while the lab does not yet work in the lab system", async () => {
    delete process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL;
    const { c } = container({ id: "labjob_1", stage: "ready" });
    expect(await recordOrderEvent(c, "order_1", "LABELLED", "labelled:ful_1", "test")).toBe("refused");
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("is reported as a fault once the lab does, with ids only", async () => {
    process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = "true";
    const { c } = container({ id: "labjob_1", stage: "ready" });
    expect(await recordOrderEvent(c, "order_1", "LABELLED", "labelled:ful_1", "test")).toBe("refused");
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect((captureMessage as jest.Mock).mock.calls[0][1].extra).toEqual({
      order_id: "order_1",
      lab_job_id: "labjob_1",
      stage: "ready",
    });
  });

  it("is a fault too when it is refused for coming from another fulfillment", async () => {
    process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = "true";
    const { c, lms } = container({ id: "labjob_1", stage: "labelled" });
    expect(
      await recordOrderEvent(c, "order_1", "DELIVERED", "delivered:ful_1", "test", "ful_1"),
    ).toBe("refused");
    expect(lms.applyProductionAction).not.toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it("is never a fault for a job from before production", async () => {
    process.env.LMS_REQUIRE_PACKED_BEFORE_LABEL = "true";
    const { c } = container({ id: "labjob_1", stage: null });
    expect(await recordOrderEvent(c, "order_1", "LABELLED", "labelled:ful_1", "test")).toBe("refused");
    expect(captureMessage).not.toHaveBeenCalled();
  });
});
