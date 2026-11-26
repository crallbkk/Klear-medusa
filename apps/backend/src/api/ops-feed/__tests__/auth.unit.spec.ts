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

describe("every route secret against every other Klear secret this server holds", () => {
  const ROUTES = [
    "KLEAR_OPS_FEED_SECRET",
    "KLEAR_STOCK_SYNC_SECRET",
    "KLEAR_LENS_SNAPSHOT_SECRET",
    "KLEAR_ORDER_CANCEL_SECRET",
  ] as const;
  // Secrets this server sends or uses itself, never accepts on a route.
  const OTHERS = ["KLEAR_PROJECTION_SECRET", "KLEAR_CARRIER_WEBHOOK_SECRET", "KLEAR_RX_METADATA_SECRET"] as const;
  const ALL = [...ROUTES, ...OTHERS];
  const value = (i: number) => String.fromCharCode(100 + i).repeat(40);
  const saved = ALL.map((v) => process.env[v]);
  const setAll = () => ALL.forEach((v, i) => (process.env[v] = value(i)));
  afterAll(() => {
    ALL.forEach((v, i) => {
      if (saved[i] === undefined) delete process.env[v];
      else process.env[v] = saved[i];
    });
  });

  const askRoute = (variable: (typeof ROUTES)[number], secret: string) => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = authorizeBearer({ headers: { authorization: `Bearer ${secret}` } } as any, res as any, variable);
    return { ok, status: res.status.mock.calls[0]?.[0] };
  };

  it("opens each route for its own secret when all differ", () => {
    setAll();
    ROUTES.forEach((v) => expect([v, askRoute(v, value(ALL.indexOf(v))).ok]).toEqual([v, true]));
  });

  it("closes a route whose secret equals any other one, for every pair", () => {
    for (const route of ROUTES) {
      for (const other of ALL) {
        if (other === route) continue;
        setAll();
        process.env[other] = value(ALL.indexOf(route));
        const r = askRoute(route, value(ALL.indexOf(route)));
        expect([route, other, r.ok, r.status]).toEqual([route, other, false, 503]);
      }
    }
  });
});

describe("the log line for two secrets that hold the same value", () => {
  const saved = { ...process.env };
  afterAll(() => {
    process.env = { ...saved };
  });
  const logFor = (other: string) => {
    process.env.KLEAR_OPS_FEED_SECRET = "q".repeat(40);
    process.env.KLEAR_STOCK_SYNC_SECRET = "r".repeat(40);
    process.env.KLEAR_LENS_SNAPSHOT_SECRET = "s".repeat(40);
    process.env.KLEAR_ORDER_CANCEL_SECRET = "t".repeat(40);
    process.env.KLEAR_PROJECTION_SECRET = "u".repeat(40);
    process.env[other] = "q".repeat(40);
    const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = { status: jest.fn(), json: jest.fn() };
      res.status.mockReturnValue(res);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      authorizeBearer({ headers: { authorization: "Bearer x" } } as any, res as any, "KLEAR_OPS_FEED_SECRET");
      return JSON.stringify(logged.mock.calls);
    } finally {
      logged.mockRestore();
    }
  };
  it("says both are closed when both are route secrets", () => {
    expect(logFor("KLEAR_STOCK_SYNC_SECRET")).toMatch(/both are closed/);
  });
  it("says only this route is closed when the other is a secret this server sends", () => {
    const log = logFor("KLEAR_PROJECTION_SECRET");
    expect(log).not.toMatch(/both are closed/);
    expect(log).toMatch(/KLEAR_OPS_FEED_SECRET is closed/);
  });
});
