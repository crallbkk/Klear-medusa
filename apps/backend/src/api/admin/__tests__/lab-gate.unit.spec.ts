// The gate before any lab account exists (design 10.10 items 6 and 7): a
// lab account is refused on EVERY admin route except the lab's own. The
// routes are not listed by hand: they are read from Medusa's installed
// route files and from this project's, so a route added by an upgrade or by
// us is covered the day it appears.

import fs from "fs";
import path from "path";
import {
  ANSWERED_FOR_THE_PAGE,
  LAB_MAY_REACH,
  SERVED_WITHOUT_SIGN_IN,
  answeredForThePage,
  confineLabAccounts,
  forgetLabMarks,
  isLabAccount,
  labMayReach,
} from "../lab-gate";
import middlewares from "../../middlewares";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

/** Every (method, path) a folder of route files serves. */
function routesUnder(apiRoot: string, file: "route.js" | "route.ts"): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "__tests__") walk(full);
        continue;
      }
      if (entry.name !== file) continue;
      const route =
        "/" +
        path
          .relative(apiRoot, dir)
          .split(path.sep)
          .map((seg) => seg.replace(/^\[(.+)\]$/, ":$1"))
          .join("/");
      const source = fs.readFileSync(full, "utf8");
      for (const method of METHODS) {
        const exported =
          file === "route.js"
            ? new RegExp(`exports\\.${method}\\s*=|exports\\.${method}\\b`).test(source)
            : new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`).test(source);
        if (exported) found.push(`${method} ${route}`);
      }
    }
  };
  walk(apiRoot);
  return found;
}

const medusaApi = path.join(path.dirname(require.resolve("@medusajs/medusa/package.json")), "dist", "api");
const ours = path.join(__dirname, "..", "..");
const draftOrderApi = path.join(
  path.dirname(require.resolve("@medusajs/draft-order/package.json")),
  ".medusa",
  "server",
  "src",
  "api",
);

const ALL_ADMIN = [
  ...routesUnder(medusaApi, "route.js"),
  ...(fs.existsSync(draftOrderApi) ? routesUnder(draftOrderApi, "route.js") : []),
  ...routesUnder(ours, "route.ts"),
].filter((r) => r.split(" ")[1].startsWith("/admin"));

const allowed = new Set(LAB_MAY_REACH.map(([m, p]) => `${m} ${p}`));
/** A concrete request for a route pattern. */
const concrete = (route: string) => {
  const [method, pattern] = route.split(" ");
  return { method, url: pattern.replace(/:[^/]+/g, "id_123") + "?fields=id" };
};

describe("a lab account in Medusa Admin", () => {
  it("found Medusa's routes and ours (or this test proves nothing)", () => {
    expect(ALL_ADMIN.length).toBeGreaterThan(250);
    for (const must of [
      "GET /admin/orders",
      "GET /admin/customers",
      "POST /admin/users/:id",
      "POST /admin/api-keys",
      "GET /admin/lab-queue",
      "POST /admin/lab-jobs/:id/ops-actions",
    ]) {
      expect(ALL_ADMIN).toContain(must);
    }
  });

  it("is refused on every admin route there is, except the ones listed for it", () => {
    const reached = ALL_ADMIN.filter((r) => {
      const { method, url } = concrete(r);
      return labMayReach(method, url);
    });
    expect(reached.sort()).toEqual([...allowed].filter((r) => ALL_ADMIN.includes(r)).sort());
  });

  it("is allowed nothing that does not exist: every listed route is a real one", () => {
    for (const route of allowed) expect([route, ALL_ADMIN.includes(route)]).toEqual([route, true]);
  });

  it("knows every admin route Medusa serves without its sign-in check", () => {
    // On those the check cannot see who is calling. They are listed by
    // name; an upgrade that adds one must fail here, not pass unseen.
    const open: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === "route.js") {
          const source = fs.readFileSync(full, "utf8");
          if (!/exports\.AUTHENTICATE\s*=\s*false/.test(source)) continue;
          const route = "/" + path.relative(medusaApi, dir).split(path.sep).join("/");
          for (const method of METHODS) {
            if (new RegExp(`exports\\.${method}\\b`).test(source)) open.push(`${method} ${route}`);
          }
        }
      }
    };
    walk(path.join(medusaApi, "admin"));
    expect(open.sort()).toEqual(SERVED_WITHOUT_SIGN_IN.map(([m, p]) => `${m} ${p}`).sort());
    // And none of ours opts out.
    const oursOptOut = routesUnder(ours, "route.ts").filter((r) => {
      const file = path.join(ours, ...r.split(" ")[1].replace(/:([^/]+)/g, "[$1]").split("/"), "route.ts");
      return /export\s+const\s+AUTHENTICATE\s*=\s*false/.test(fs.readFileSync(file, "utf8"));
    });
    expect(oursOptOut.filter((r) => r.split(" ")[1].startsWith("/admin"))).toEqual([]);
  });

  it("cannot reach what the design names: orders, customers, stock, settings, keys, users, files", () => {
    for (const [method, url] of [
      ["GET", "/admin/orders"],
      ["GET", "/admin/orders/order_1"],
      ["POST", "/admin/orders/order_1/cancel"],
      ["GET", "/admin/customers"],
      ["GET", "/admin/inventory-items"],
      ["POST", "/admin/inventory-items/iitem_1/location-levels/sloc_1"],
      ["GET", "/admin/stores"],
      ["POST", "/admin/api-keys"],
      ["GET", "/admin/api-keys"],
      ["POST", "/admin/users/user_1"],
      ["GET", "/admin/users"],
      ["DELETE", "/admin/users/user_1"],
      ["POST", "/admin/invites"],
      ["POST", "/admin/uploads"],
      ["GET", "/admin/workflows-executions"],
      ["GET", "/admin/products"],
      // The lab's own routes that need ops.
      ["POST", "/admin/lab-jobs/labjob_1/ops-actions"],
      ["POST", "/admin/lab-jobs/labjob_1/rx-changed"],
      ["POST", "/admin/lab-jobs/labjob_1/retry"],
      ["POST", "/admin/lab-jobs/labjob_1/warranty-remake"],
      // The right path with the wrong method.
      ["POST", "/admin/lab-queue"],
      ["DELETE", "/admin/lab-jobs/labjob_1"],
      ["POST", "/admin/users/me"],
    ] as const) {
      expect([method, url, labMayReach(method, url)]).toEqual([method, url, false]);
    }
  });

  it("can do its own work", () => {
    for (const [method, url] of [
      ["GET", "/admin/lab-queue"],
      ["GET", "/admin/lab-queue/"],
      ["GET", "/admin/lab-reports?weeks=12"],
      ["GET", "/admin/lab-jobs/labjob_1/production"],
      ["POST", "/admin/lab-jobs/labjob_1/packet"],
      ["POST", "/admin/lab-jobs/labjob_1/actions"],
      ["GET", "/admin/users/me"],
      ["HEAD", "/admin/lab-queue"],
      ["get", "/admin/lab-queue"],
    ] as const) {
      expect([method, url, labMayReach(method, url)]).toEqual([method, url, true]);
    }
  });

  it("is refused on a path written to be read two ways", () => {
    for (const url of [
      "/admin/lab-jobs/../orders",
      "/admin/lab-jobs/%2e%2e/orders",
      "/admin/lab-jobs/x%2Fproduction",
      "/admin//lab-queue",
      "/admin/lab-jobs/a/b/production",
      "/admin/lab-jobs/./production",
      "/admin/lab-queue/../users",
      "/admin/lab-jobs\\..\\orders",
      "/admin/lab-queue;x=1",
      "/admin/lab-queuex",
      "/ADMIN/lab-queue",
      "/admin/users/me/extra",
      "/admin/lab-jobs/labjob_1/production/more",
    ]) {
      expect([url, labMayReach("GET", url)]).toEqual([url, false]);
    }
  });
});

describe("the check itself", () => {
  // Who is a lab account is asked of the database, for the signed-in user.
  const USERS: Record<string, unknown> = {
    user_lab: { id: "user_lab", metadata: { klear_role: "lab" } },
    user_owner: { id: "user_owner", metadata: null },
    user_ops: { id: "user_ops", metadata: { klear_role: "ops" } },
    user_odd: { id: "user_odd", metadata: { klear_role: ["lab"] } },
    user_caps: { id: "user_caps", metadata: { klear_role: "Lab" } },
  };
  const retrieveUser = jest.fn(async (id: string) => {
    if (!(id in USERS)) throw new Error("User with id: gone was not found");
    return USERS[id];
  });
  beforeEach(() => {
    forgetLabMarks();
    retrieveUser.mockClear();
  });

  const run = async (
    actor: { id?: string; type?: string } | null,
    method = "GET",
    originalUrl = "/admin/orders",
  ) => {
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    const req = {
      auth_context: actor === null ? undefined : { actor_id: actor.id, actor_type: actor.type ?? "user" },
      method,
      originalUrl,
      url: "/",
      scope: { resolve: () => ({ retrieveUser }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await confineLabAccounts(req as any, res as any, next);
    return { res, next, req };
  };
  const lab = { id: "user_lab" };

  it("answers a lab account 403 in plain words and does not run the route", async () => {
    const { res, next } = await run(lab);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].message).toMatch(/only use the lab screens/);
    expect(next).not.toHaveBeenCalled();
  });

  it("lets a lab account through to its own routes, and marks the request for them", async () => {
    const { res, next, req } = await run(lab, "GET", "/admin/lab-queue");
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isLabAccount(req as any)).toBe(true);
  });

  it("answers the two things the admin page needs with fixed, empty content", async () => {
    // The real routes never run: `next` is not called.
    const stores = await run(lab, "GET", "/admin/stores");
    expect(stores.next).not.toHaveBeenCalled();
    expect(stores.res.status).not.toHaveBeenCalled();
    expect(stores.res.json.mock.calls[0][0].stores).toEqual([
      { id: "store_lab", name: "Klear lab", supported_currencies: [], metadata: null },
    ]);
    const feed = await run(lab, "GET", "/admin/notifications?limit=1&offset=0&fields=created_at");
    expect(feed.next).not.toHaveBeenCalled();
    expect(feed.res.json.mock.calls[0][0]).toEqual({ notifications: [], count: 0, offset: 0, limit: 0 });
  });

  it("answers nothing else that way: not one store, not a write, not an odd path", async () => {
    for (const [method, url] of [
      ["GET", "/admin/stores/store_1"],
      ["POST", "/admin/stores/store_1"],
      ["POST", "/admin/stores"],
      ["GET", "/admin/notifications/noti_1"],
      ["GET", "/admin/stores/../orders"],
      ["GET", "/admin/stores%2f..%2forders"],
      ["GET", "/admin/orders"],
    ] as const) {
      expect([method, url, answeredForThePage(method, url)]).toEqual([method, url, null]);
      const { res, next } = await run(lab, method, url);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
    // Every canned answer is for a real route, read-only, and not one the
    // lab is also let through to.
    for (const [method, route] of ANSWERED_FOR_THE_PAGE) {
      expect(method).toBe("GET");
      expect(ALL_ADMIN).toContain(`${method} ${route}`);
      expect(labMayReach(method, route)).toBe(false);
    }
  });

  it("leaves every other account exactly as it was", async () => {
    for (const actor of [
      { id: "user_owner" },
      { id: "user_ops" },
      // Only the exact mark counts.
      { id: "user_odd" },
      { id: "user_caps" },
      // A secret API key is not a user; it is not looked up at all.
      { id: "apk_1", type: "api-key" },
      // Nobody signed in: Medusa answers 401 itself.
      null,
      {},
    ]) {
      const { res, next, req } = await run(actor);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(isLabAccount(req as any)).toBe(false);
    }
    expect(retrieveUser.mock.calls.map((c) => c[0])).toEqual([
      "user_owner",
      "user_ops",
      "user_odd",
      "user_caps",
    ]);
  });

  it("does not trust the sign-in token: only the database says who is a lab account", async () => {
    // A token minted before the account was marked says nothing about it.
    const res = { status: jest.fn(), json: jest.fn() };
    res.status.mockReturnValue(res);
    const next = jest.fn();
    await confineLabAccounts(
      {
        auth_context: { actor_id: "user_lab", actor_type: "user", app_metadata: { user_id: "user_lab" } },
        method: "GET",
        originalUrl: "/admin/orders",
        scope: { resolve: () => ({ retrieveUser }) },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res as any,
      next,
    );
    expect(res.status).toHaveBeenCalledWith(403);
    // And a token that claims the mark gives nothing to an owner.
    const owner = await run({ id: "user_owner" });
    expect(owner.next).toHaveBeenCalled();
  });

  it("refuses when it cannot find out, instead of letting the request through", async () => {
    const gone = await run({ id: "user_gone" });
    expect(gone.res.status).toHaveBeenCalledWith(503);
    expect(gone.next).not.toHaveBeenCalled();
    retrieveUser.mockRejectedValueOnce(new Error("connection refused"));
    const down = await run({ id: "user_owner" });
    expect(down.res.status).toHaveBeenCalledWith(503);
    expect(down.next).not.toHaveBeenCalled();
    // Nothing of the failure is remembered: the next request asks again.
    const back = await run({ id: "user_owner" });
    expect(back.next).toHaveBeenCalled();
  });

  it("remembers an answer for a few seconds only, and forgets on request", async () => {
    await run(lab);
    await run(lab);
    expect(retrieveUser).toHaveBeenCalledTimes(1);
    forgetLabMarks("user_lab");
    await run(lab);
    expect(retrieveUser).toHaveBeenCalledTimes(2);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 6_000;
      await run(lab);
    } finally {
      Date.now = realNow;
    }
    expect(retrieveUser).toHaveBeenCalledTimes(3);
  });

  it("says a request is from a lab account only after the check has said so", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isLabAccount({ auth_context: { app_metadata: { klear_role: "lab" } } } as any)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isLabAccount({ klear_lab_account: true } as any)).toBe(true);
  });

  it("stands in front of every admin route", () => {
    const entry = (middlewares.routes ?? []).find((r) =>
      (r.middlewares ?? []).includes(confineLabAccounts as never),
    );
    expect(entry?.matcher).toBe("/admin*");
    // Every method: an entry limited to some would let the others past.
    expect(entry?.methods).toBeUndefined();
    // First in the list, so nothing of ours runs before it.
    expect((middlewares.routes ?? [])[0]).toBe(entry);
  });
});
