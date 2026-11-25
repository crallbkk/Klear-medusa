import { authorizeBearer } from "../auth";

const VARS = ["KLEAR_OPS_FEED_SECRET", "KLEAR_STOCK_SYNC_SECRET", "KLEAR_LENS_SNAPSHOT_SECRET"] as const;
const OWN: Record<(typeof VARS)[number], string> = {
  KLEAR_OPS_FEED_SECRET: "a".repeat(40),
  KLEAR_STOCK_SYNC_SECRET: "b".repeat(40),
  KLEAR_LENS_SNAPSHOT_SECRET: "c".repeat(40),
};

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ask = (variable: (typeof VARS)[number], secret: string): any => {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ok = authorizeBearer({ headers: { authorization: `Bearer ${secret}` } } as any, res as any, variable);
  return { ok, status: res.status.mock.calls[0]?.[0], body: res.json.mock.calls[0]?.[0] };
};

describe("the three Operations secrets", () => {
  const saved = VARS.map((v) => process.env[v]);
  beforeEach(() => {
    for (const v of VARS) process.env[v] = OWN[v];
  });
  afterAll(() => {
    VARS.forEach((v, i) => {
      if (saved[i] === undefined) delete process.env[v];
      else process.env[v] = saved[i];
    });
  });

  it("each opens its own routes when all three differ", () => {
    for (const v of VARS) expect([v, ask(v, OWN[v]).ok]).toEqual([v, true]);
  });

  it("are closed, on both routes, when two of them are the same value", () => {
    const pairs: Array<[(typeof VARS)[number], (typeof VARS)[number]]> = [
      ["KLEAR_OPS_FEED_SECRET", "KLEAR_STOCK_SYNC_SECRET"],
      ["KLEAR_OPS_FEED_SECRET", "KLEAR_LENS_SNAPSHOT_SECRET"],
      ["KLEAR_STOCK_SYNC_SECRET", "KLEAR_LENS_SNAPSHOT_SECRET"],
    ];
    for (const [a, b] of pairs) {
      for (const v of VARS) process.env[v] = OWN[v];
      // Differing only in white space around it is the same secret.
      process.env[b] = ` ${OWN[a]}\n`;
      for (const v of [a, b]) {
        const r = ask(v, OWN[a]);
        expect([a, b, v, r.ok, r.status]).toEqual([a, b, v, false, 503]);
        // The same answer as an unset secret: the caller learns nothing
        // about how the server is configured.
        expect(r.body).toEqual({ error: "feed not configured" });
      }
      // The third, still distinct, keeps working.
      const third = VARS.find((v) => v !== a && v !== b)!;
      expect([third, ask(third, OWN[third]).ok]).toEqual([third, true]);
    }
  });

  it("say why only in the log, with no value and no digest", () => {
    process.env.KLEAR_LENS_SNAPSHOT_SECRET = OWN.KLEAR_OPS_FEED_SECRET;
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(ask("KLEAR_OPS_FEED_SECRET", OWN.KLEAR_OPS_FEED_SECRET).status).toBe(503);
      const log = JSON.stringify(logged.mock.calls);
      expect(log).toMatch(/KLEAR_OPS_FEED_SECRET/);
      expect(log).toMatch(/KLEAR_LENS_SNAPSHOT_SECRET/);
      expect(log).not.toContain(OWN.KLEAR_OPS_FEED_SECRET);
      expect(log).not.toMatch(/[0-9a-f]{32}/);
    } finally {
      logged.mockRestore();
    }
  });

  it("are not compared with another variable that is unset or too short", () => {
    process.env.KLEAR_STOCK_SYNC_SECRET = "";
    process.env.KLEAR_LENS_SNAPSHOT_SECRET = "short";
    expect(ask("KLEAR_OPS_FEED_SECRET", OWN.KLEAR_OPS_FEED_SECRET).ok).toBe(true);
  });
});
