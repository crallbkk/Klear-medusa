// A failure the lab module reports on its own (no route in front of it) is
// logged and sent to Sentry by its kind, as the routes do
// (`sendProductionError`): a driver's or a library's own message can hold
// values written into it, and an exception's message is the one thing the
// Sentry scrubber cannot clean. Our own write error's text is built from
// codes only and is kept, as the routes keep it.

import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import LmsModuleService, { ProductionWriteError } from "../service";
import { LMS_MODULE } from "../service";
import { recordOrderEventSafely } from "../order-events";
import labJobOrderEventsHandler from "../../../subscribers/lab-job-order-events";
import { captureException } from "../../../lib/observability/sentry";

jest.mock("../../../lib/observability/sentry", () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

/** A driver error whose own text holds a value, as a real one does. */
const leaky = () =>
  Object.assign(new Error(`insert into lab_usage values ('LENS-SECRET-SKU', 'Somchai Secretname')`), {
    code: "23505",
  });
const NEEDLE = /SECRET|Secretname|insert into/;
const logged = () => JSON.stringify((console.error as jest.Mock).mock.calls);
/** Everything handed to Sentry: each error's message and stack, and the context. */
const captured = () =>
  (captureException as jest.Mock).mock.calls
    .map((c) => `${String(c[0]?.message)}\n${String(c[0]?.stack)}\n${JSON.stringify(c[1])}`)
    .join("\n");

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe("markReadyForProduction", () => {
  const markReady = (applyProductionAction: jest.Mock) =>
    LmsModuleService.prototype.markReadyForProduction.call(
      { applyProductionAction } as unknown as LmsModuleService,
      "labjob_1",
    );

  it("logs and reports an unexpected error by its kind, never its text", async () => {
    expect(await markReady(jest.fn().mockRejectedValue(leaky()))).toBe(false);
    expect(logged()).not.toMatch(NEEDLE);
    expect(logged()).toContain("labjob_1");
    expect(logged()).toContain("Error/23505");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captured()).not.toMatch(NEEDLE);
    expect(captured()).toContain("Error/23505");
  });

  it("keeps our own write error's text, which holds codes only", async () => {
    const err = new ProductionWriteError(leaky());
    expect(await markReady(jest.fn().mockRejectedValue(err))).toBe(false);
    expect(logged()).toContain(err.message);
    expect(logged()).not.toMatch(NEEDLE);
    expect((captureException as jest.Mock).mock.calls[0][0]).toBe(err);
  });
});

describe("recordOrderEventSafely", () => {
  it("logs and reports a failure by its kind, never its text", async () => {
    const container = {
      resolve: (key: string) => {
        if (key !== LMS_MODULE) throw new Error(`unexpected resolve(${key})`);
        return { getJobByOrderId: jest.fn().mockRejectedValue(leaky()) };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(await recordOrderEventSafely(container, "order_1", "LABELLED", "labelled:ful_1", "test")).toBe(
      "failed",
    );
    expect(logged()).not.toMatch(NEEDLE);
    expect(logged()).toContain("order_1");
    expect(logged()).toContain("Error/23505");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captured()).not.toMatch(NEEDLE);
  });
});

describe("lab-job-order-events subscriber", () => {
  it("logs and reports a failed fulfillment lookup by its kind, never its text", async () => {
    const container = {
      resolve: (key: string) => {
        if (key !== ContainerRegistrationKeys.QUERY) throw new Error(`unexpected resolve(${key})`);
        return { graph: jest.fn().mockRejectedValue(leaky()) };
      },
    };
    await labJobOrderEventsHandler({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      event: { name: "delivery.created", data: { id: "ful_1" } } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container: container as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(logged()).not.toMatch(NEEDLE);
    expect(logged()).toContain("ful_1");
    expect(logged()).toContain("Error/23505");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captured()).not.toMatch(NEEDLE);
  });
});
