import { GET } from "../lab-releases/route";
import { LMS_MODULE } from "../../../modules/lms/service";

const SECRET = "s".repeat(48);

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

function makeReq(opts: { auth?: string; query?: Record<string, unknown>; lms?: unknown } = {}) {
  return {
    headers: opts.auth === undefined ? {} : { authorization: opts.auth },
    query: opts.query ?? {},
    scope: {
      resolve: jest.fn((key: string) => {
        if (key === LMS_MODULE) return opts.lms;
        throw new Error(`unexpected resolve(${key})`);
      }),
    },
  };
}

const WINDOW = {
  window_end: "2026-11-08",
  released_at: new Date("2026-11-08T17:10:00Z"),
  usage: [{ id: "labrel_1", sku: "LENS-A", reason: "order", net_qty: -2 }],
  lab_totals: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (req: unknown, res: unknown) => GET(req as any, res as any);

describe("GET /ops-feed/lab-releases", () => {
  const saved = process.env.KLEAR_OPS_FEED_SECRET;
  beforeEach(() => {
    process.env.KLEAR_OPS_FEED_SECRET = SECRET;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.KLEAR_OPS_FEED_SECRET;
    else process.env.KLEAR_OPS_FEED_SECRET = saved;
  });

  it("is closed when the secret is unset or too short to be one", async () => {
    for (const value of [undefined, "", "short"]) {
      if (value === undefined) delete process.env.KLEAR_OPS_FEED_SECRET;
      else process.env.KLEAR_OPS_FEED_SECRET = value;
      const lms = { listReleasedWindows: jest.fn() };
      const res = makeRes();
      // Even a caller who sends exactly what the variable holds gets nothing.
      await call(makeReq({ auth: `Bearer ${value ?? ""}`, lms }), res);
      expect(res.status).toHaveBeenCalledWith(503);
      expect(lms.listReleasedWindows).not.toHaveBeenCalled();
    }
  });

  it("refuses a missing, malformed or wrong bearer secret without touching the data", async () => {
    for (const auth of [
      undefined,
      "",
      SECRET,
      `Basic ${SECRET}`,
      "Bearer ",
      `Bearer ${SECRET}x`,
      `Bearer ${SECRET.slice(1)}`,
      `bearer ${SECRET}`,
    ]) {
      const lms = { listReleasedWindows: jest.fn() };
      const res = makeRes();
      await call(makeReq({ auth, lms }), res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(lms.listReleasedWindows).not.toHaveBeenCalled();
    }
  });

  it("ignores white space around the configured secret", async () => {
    process.env.KLEAR_OPS_FEED_SECRET = `${SECRET}\n`;
    const lms = { listReleasedWindows: jest.fn().mockResolvedValue([]) };
    const res = makeRes();
    await call(makeReq({ auth: `Bearer ${SECRET}`, lms }), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(lms.listReleasedWindows).toHaveBeenCalled();
  });

  it("serves windows after the cursor and hands back the next cursor", async () => {
    const lms = { listReleasedWindows: jest.fn().mockResolvedValue([WINDOW]) };
    const res = makeRes();
    await call(
      makeReq({ auth: `Bearer ${SECRET}`, query: { after: "2026-11-01", limit: "10" }, lms }),
      res,
    );
    expect(lms.listReleasedWindows).toHaveBeenCalledWith("2026-11-01", 10);
    expect(res.json).toHaveBeenCalledWith({ windows: [WINDOW], next_after: "2026-11-08" });
  });

  it("keeps the caller's cursor when there is nothing new", async () => {
    const lms = { listReleasedWindows: jest.fn().mockResolvedValue([]) };
    const res = makeRes();
    await call(makeReq({ auth: `Bearer ${SECRET}`, query: { after: "2026-11-08" }, lms }), res);
    expect(lms.listReleasedWindows).toHaveBeenCalledWith("2026-11-08", 50);
    expect(res.json).toHaveBeenCalledWith({ windows: [], next_after: "2026-11-08" });
  });

  it("refuses a cursor that is not a date, and clamps the limit", async () => {
    const lms = { listReleasedWindows: jest.fn().mockResolvedValue([]) };
    for (const after of ["yesterday", "2026-11-08'; drop table lab_job; --", ["2026-11-08"]]) {
      const res = makeRes();
      await call(makeReq({ auth: `Bearer ${SECRET}`, query: { after }, lms }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(lms.listReleasedWindows).not.toHaveBeenCalled();
    const res = makeRes();
    await call(makeReq({ auth: `Bearer ${SECRET}`, query: { limit: "100000" }, lms }), res);
    expect(lms.listReleasedWindows).toHaveBeenCalledWith(null, 200);
  });
});
