const captureException = jest.fn();
jest.mock("../sentry", () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { MedusaError } from "@medusajs/framework/utils";
import { sentryErrorHandler } from "../http-error-handler";

function fakeRes() {
  const res: Record<string, unknown> & { statusCode: number } = { statusCode: 200 };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = () => res;
  return res;
}

function fakeReq() {
  return {
    method: "POST",
    baseUrl: "",
    route: { path: "/store/carts/:id/complete" },
    scope: { resolve: () => ({ error: jest.fn(), info: jest.fn() }) },
  };
}

describe("sentryErrorHandler", () => {
  beforeEach(() => captureException.mockReset());

  it("answers like Medusa's handler and reports a 5xx with the route pattern only", () => {
    const res = fakeRes();
    const err = new MedusaError(MedusaError.Types.UNEXPECTED_STATE, "boom");
    sentryErrorHandler(err, fakeReq() as never, res as never, jest.fn());
    expect(res.statusCode).toBe(500);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0][1]).toEqual({
      tags: { source: "http", method: "POST", route: "/store/carts/:id/complete" },
    });
  });

  it("does not report a 4xx", () => {
    const res = fakeRes();
    const err = new MedusaError(MedusaError.Types.NOT_FOUND, "nope");
    sentryErrorHandler(err, fakeReq() as never, res as never, jest.fn());
    expect(res.statusCode).toBe(404);
    expect(captureException).not.toHaveBeenCalled();
  });
});
