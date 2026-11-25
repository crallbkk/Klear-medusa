// The gate before any lab account exists (design 10.10 items 6 and 7),
// against the real server: the whole app is started on a scratch database,
// a lab account signs in the way a person does, and every admin route
// Medusa and this project serve is called over HTTP.
//
// The unit test (`src/api/admin/__tests__/lab-gate.unit.spec.ts`) proves the
// rule. This proves the rule is actually in front of the routes: mounted,
// in the right order, reading the right thing from a real sign-in.
//
// Needs a Postgres: DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD.
//   npm run test:integration:http

import fs from "fs";
import http from "http";
import path from "path";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import {
  ANSWERED_FOR_THE_PAGE,
  LAB_MAY_REACH,
  SERVED_WITHOUT_SIGN_IN,
} from "../../src/api/admin/lab-gate";
import { listAdminAccounts, setLabAccount } from "../../src/modules/lms/lab-account";
import { LMS_MODULE } from "../../src/modules/lms/service";

jest.setTimeout(300_000);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function routesUnder(apiRoot: string, file: "route.js" | "route.ts"): Array<[string, string]> {
  const found: Array<[string, string]> = [];
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
            ? new RegExp(`exports\\.${method}\\b`).test(source)
            : new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`).test(source);
        if (exported) found.push([method, route]);
      }
    }
  };
  walk(apiRoot);
  return found.filter(([, route]) => route.startsWith("/admin"));
}

const medusaApi = path.join(path.dirname(require.resolve("@medusajs/medusa/package.json")), "dist", "api");
const draftOrderApi = path.join(
  path.dirname(require.resolve("@medusajs/draft-order/package.json")),
  ".medusa",
  "server",
  "src",
  "api",
);
const ALL_ADMIN: Array<[string, string]> = [
  ...routesUnder(medusaApi, "route.js"),
  ...(fs.existsSync(draftOrderApi) ? routesUnder(draftOrderApi, "route.js") : []),
  ...routesUnder(path.join(__dirname, "..", "..", "src", "api"), "route.ts"),
];
// Reached by a lab account: its own routes, and the two Medusa serves to
// anyone without looking at who is signed in.
const allowed = new Set(
  [...LAB_MAY_REACH, ...SERVED_WITHOUT_SIGN_IN].map(([m, p]) => `${m} ${p}`),
);
const REFUSAL = "this account can only use the lab screens";

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    const PASSWORD = "integration-test-only-1";

    /** An admin user that can sign in with a password, as `medusa user` makes one. */
    async function makeUser(email: string): Promise<void> {
      const container = getContainer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const users = container.resolve(Modules.USER) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const auth = container.resolve(Modules.AUTH) as any;
      const user = await users.createUsers({ email });
      const registered = await auth.register("emailpass", {
        body: { email, password: PASSWORD },
      });
      if (!registered.success) throw new Error(`could not register ${email}`);
      await auth.updateAuthIdentities({
        id: registered.authIdentity.id,
        app_metadata: { user_id: user.id },
      });
    }

    /** Sign in over HTTP and return the header a browser-less client sends. */
    async function signIn(email: string): Promise<{ headers: Record<string, string> }> {
      const res = await api.post("/auth/user/emailpass", { email, password: PASSWORD });
      return { headers: { authorization: `Bearer ${res.data.token}` } };
    }

    const call = (method: string, url: string, auth: { headers: Record<string, string> }) =>
      api.request({
        method,
        url,
        data: method === "GET" || method === "DELETE" ? undefined : {},
        ...auth,
        // Every status is an answer to look at, not an exception.
        validateStatus: () => true,
      });

    /** A request sent exactly as written: no client tidies the path. */
    const raw = (method: string, rawPath: string, headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const base = new URL(api.defaults.baseURL);
        const req = http.request(
          { host: base.hostname, port: base.port, method, path: rawPath, headers },
          (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on("error", reject);
        req.end();
      });

    describe("a lab account against the running server", () => {
      let lab: { headers: Record<string, string> };
      let owner: { headers: Record<string, string> };
      /** Signed in BEFORE the account was marked. */
      let early: { headers: Record<string, string> };

      beforeEach(async () => {
        await makeUser("lab@example.test");
        await makeUser("owner@example.test");
        early = await signIn("lab@example.test");
        expect((await call("GET", "/admin/orders", early)).status).toBe(200);
        const marked = await setLabAccount(getContainer(), "lab@example.test", true);
        expect(marked.outcome).toBe("marked");
        lab = await signIn("lab@example.test");
        owner = await signIn("owner@example.test");
      });

      it("confines a session that was already open when the account was marked", async () => {
        const res = await call("GET", "/admin/orders", early);
        expect([res.status, res.data?.message]).toEqual([403, REFUSAL]);
        expect((await call("GET", "/admin/lab-queue", early)).status).toBe(200);
      });

      it("confines the browser's sign-in (a session cookie) the same way", async () => {
        const session = await api.post("/auth/session", {}, lab);
        const cookie = (session.headers["set-cookie"] ?? []).map((c: string) => c.split(";")[0]).join("; ");
        expect(cookie).not.toBe("");
        const withCookie = { headers: { cookie } };
        const orders = await call("GET", "/admin/orders", withCookie);
        expect([orders.status, orders.data?.message]).toEqual([403, REFUSAL]);
        expect((await call("POST", "/admin/api-keys", withCookie)).status).toBe(403);
        expect((await call("GET", "/admin/lab-queue", withCookie)).status).toBe(200);
      });

      it("is never given an order's id, which the storefront API would turn into the customer's details", async () => {
        // A real job, with an order id that would be recognised anywhere.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lms = getContainer().resolve(LMS_MODULE) as any;
        const ORDER = "order_01SECRETORDERID0000000";
        const made = await lms.createFromBuild({
          outcome: "ok",
          packet: {
            job_ref: `klear-${ORDER}`,
            klear_order_id: ORDER,
            frame_sku: "KLR-1",
            lens_type: "non_prescription",
            lens_index: null,
            coating_addons: [],
            prescription: null,
            customer: {
              name: "A B",
              phone: "+66800000000",
              delivery_address: { line1: "x", city: "c", province: "p", postal_code: "10110", country_code: "TH" },
            },
            submitted_at: new Date().toISOString(),
          },
        });
        const id = made.id as string;
        // And one whose stored error names its order, as older rows do.
        const failed = await lms.createFromBuild({
          outcome: "failed",
          reason: `order ${ORDER} not found`,
          snapshot: { job_ref: `klear-${ORDER}x`, klear_order_id: `${ORDER}x` },
        });
        // What each POST a lab account may make is sent with. A route added
        // to LAB_MAY_REACH without an entry here fails the test.
        const BODIES: Record<string, object> = {
          "/admin/lab-jobs/:id/actions": {
            action: "NOTE",
            idempotency_key: "http-test-key-0001",
            detail: { text: "seen" },
          },
          "/admin/lab-jobs/:id/packet": { idempotency_key: "http-test-key-0002" },
        };
        // Every route on the lab's list, walked from the list itself.
        const answers: Record<string, { status: number; data: any }> = {};
        for (const [method, route] of LAB_MAY_REACH) {
          for (const jobId of route.includes(":id") ? [id, failed.id as string] : [""]) {
            const url = route.replace(":id", jobId);
            if (method === "POST") expect([route, route in BODIES]).toEqual([route, true]);
            const res =
              method === "POST"
                ? await api.request({
                    method,
                    url,
                    data: { ...BODIES[route], idempotency_key: `http-key-${jobId.slice(-6)}-${route.length}` },
                    ...lab,
                    validateStatus: () => true,
                  })
                : await call(method, url, lab);
            answers[`${method} ${url}`] = res;
            expect([url, JSON.stringify(res.data).match(/SECRETORDERID|"order_id"|klear_order_id/)?.[0]]).toEqual([
              url,
              undefined,
            ]);
          }
        }
        // The routes answered (the failed job has no packet to show: 409).
        expect(answers["GET /admin/lab-queue"].status).toBe(200);
        expect(answers[`GET /admin/lab-jobs/${id}/production`].status).toBe(200);
        expect(answers[`POST /admin/lab-jobs/${id}/actions`].status).toBe(200);
        // The job itself is there, and the packet names it by the job.
        expect(answers["GET /admin/lab-queue"].data.jobs.map((j: { id: string }) => j.id)).toEqual(
          expect.arrayContaining([id, failed.id]),
        );
        expect(answers[`POST /admin/lab-jobs/${id}/packet`].data.packet.job_ref).toBe(`lab-${id.slice(-8)}`);
        // Ops is still shown the order.
        expect(JSON.stringify((await call("GET", "/admin/lab-queue", owner)).data)).toContain(ORDER);
      });

      it("cannot write off a lab quote, which an ordinary admin account can", async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lms = getContainer().resolve(LMS_MODULE) as any;
        const made = await lms.createFromBuild({
          outcome: "ok",
          packet: {
            job_ref: "klear-order_writeoff",
            klear_order_id: "order_writeoff",
            frame_sku: "KLR-1",
            lens_type: "non_prescription",
            lens_index: null,
            coating_addons: [],
            prescription: null,
            customer: {
              name: "A B",
              phone: "+66800000000",
              delivery_address: { line1: "x", city: "c", province: "p", postal_code: "10110", country_code: "TH" },
            },
            submitted_at: new Date().toISOString(),
          },
        });
        const id = made.id as string;
        let step = 0;
        for (const [action, detail] of [
          ["PRINTED", undefined],
          ["SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 45000 }],
          ["RECEIVED_FROM_LAB", undefined],
        ] as const) {
          const job = await lms.retrieveLabJob(id);
          await lms.applyProductionAction({
            job_id: id,
            action,
            idempotency_key: `http-wo-setup-${++step}`,
            expected_version: job.stage_version,
            actor: { type: "user", id: "user_setup" },
            detail,
          });
        }
        const [quote] = await lms.listLabCosts({ lab_job_id: id });
        const REASON = "Somchai Secretname's remake, not billed";
        const body = async (k: string) => ({
          action: "LAB_QUOTE_WRITTEN_OFF",
          idempotency_key: k,
          expected_version: (await lms.retrieveLabJob(id)).stage_version,
          detail: { lab_cost_id: quote.id, reason: REASON },
        });
        const post = async (url: string, data: object, auth: { headers: Record<string, string> }) =>
          api.request({ method: "POST", url, data, ...auth, validateStatus: () => true });

        // The lab account: refused by the gate on the ops route, and the
        // lab's own route does not take the step at all.
        const byGate = await post(`/admin/lab-jobs/${id}/ops-actions`, await body("http-wo-lab-1"), lab);
        expect([byGate.status, byGate.data?.message]).toEqual([403, REFUSAL]);
        const byLabRoute = await post(`/admin/lab-jobs/${id}/actions`, await body("http-wo-lab-2"), lab);
        expect(byLabRoute.status).toBe(400);
        const labView = await call("GET", `/admin/lab-jobs/${id}/production`, lab);
        expect(labView.data.actions.write_off).toEqual([]);
        expect((await lms.listLabCosts({ lab_job_id: id }))[0].written_off_at).toBeNull();

        // The owner is offered it on that quote, records it, and a repeat is a replay.
        const ownerView = await call("GET", `/admin/lab-jobs/${id}/production`, owner);
        expect(ownerView.data.actions.write_off).toEqual([quote.id]);
        const first = await post(`/admin/lab-jobs/${id}/ops-actions`, await body("http-wo-owner-1"), owner);
        expect([first.status, first.data.replayed]).toEqual([200, false]);
        const again = await post(`/admin/lab-jobs/${id}/ops-actions`, await body("http-wo-owner-1"), owner);
        expect([again.status, again.data.replayed]).toEqual([200, true]);
        const twice = await post(`/admin/lab-jobs/${id}/ops-actions`, await body("http-wo-owner-2"), owner);
        expect([twice.status, twice.data.type]).toEqual([409, "quote_written_off"]);
        const me = (await call("GET", "/admin/users/me", owner)).data.user;
        expect((await lms.listLabCosts({ lab_job_id: id }))[0]).toMatchObject({
          written_off_by: me.id,
          written_off_reason: REASON,
        });
        expect(JSON.stringify(first.data)).not.toMatch(/Secretname/);
        // The lab account sees that it was written off, never why. (Who did
        // it is in the history, as for every step.)
        const after = await call("GET", `/admin/lab-jobs/${id}/production`, lab);
        expect(after.data.costs[0].written_off_at).not.toBeNull();
        expect(JSON.stringify(after.data)).not.toMatch(/Secretname|written_off_reason/);
      });

      it("is refused, by this check, on every admin route except the ones listed for it", async () => {
        expect(ALL_ADMIN.length).toBeGreaterThan(250);
        const wrong: string[] = [];
        for (const [method, route] of ALL_ADMIN) {
          const url = route.replace(/:[^/]+/g, "id_123");
          const res = await call(method, url, lab);
          const refusedByGate = res.status === 403 && res.data?.message === REFUSAL;
          const listed = allowed.has(`${method} ${route}`);
          // The two requests the admin page needs get a fixed, empty answer.
          const canned = ANSWERED_FOR_THE_PAGE.find(([m, p]) => m === method && p === route);
          if (canned) {
            if (res.status !== 200 || JSON.stringify(res.data) !== JSON.stringify(canned[2])) {
              wrong.push(`${method} ${route}: expected the fixed answer, got ${res.status}`);
            }
            continue;
          }
          if (listed === refusedByGate) {
            wrong.push(`${method} ${route}: ${res.status} ${JSON.stringify(res.data).slice(0, 80)}`);
          }
        }
        expect(wrong).toEqual([]);
      });

      it("is refused however the address is written", async () => {
        // Sent raw: an HTTP client would tidy `/../` away before sending.
        for (const url of [
          "/ADMIN/orders",
          "/Admin/Orders",
          "/admin/orders/",
          "/admin//orders",
          "//admin/orders",
          "/admin/./orders",
          "/admin/lab-jobs/../orders",
          "/admin/lab-jobs/%2e%2e/orders",
          "/admin/lab-queue/../orders",
          "/admin/users/me/../../orders",
          "/admin/%6frders",
          "/admin/orders;x=/admin/lab-queue",
          "/admin/orders?x=/admin/lab-queue",
          "/admin/orders.json",
        ]) {
          for (const method of ["GET", "HEAD", "OPTIONS"]) {
            const res = await raw(method, url, lab.headers);
            // Refused by the check, or not a route at all. Never an answer.
            expect([method, url, res.status === 403 || res.status === 404]).toEqual([method, url, true]);
            expect([method, url, /"orders"\s*:/.test(res.body)]).toEqual([method, url, false]);
          }
        }
        // A method named in a header is not the method.
        const override = await raw("POST", "/admin/orders", {
          ...lab.headers,
          "x-http-method-override": "GET",
        });
        expect(override.status).toBe(403);
      });

      it("can do its own work, and is told who it is", async () => {
        const queue = await call("GET", "/admin/lab-queue", lab);
        expect(queue.status).toBe(200);
        expect(queue.data.jobs).toEqual([]);
        const me = await call("GET", "/admin/users/me", lab);
        expect(me.status).toBe(200);
        expect(me.data.user.email).toBe("lab@example.test");
        expect((await call("GET", "/admin/lab-reports", lab)).status).toBe(200);
      });

      it("cannot lift itself out, make a key, or invite someone", async () => {
        const me = (await call("GET", "/admin/users/me", lab)).data.user;
        for (const [method, url] of [
          ["POST", `/admin/users/${me.id}`],
          ["DELETE", `/admin/users/${me.id}`],
          ["POST", "/admin/api-keys"],
          ["POST", "/admin/invites"],
        ]) {
          const res = await call(method, url, lab);
          expect([url, res.status, res.data?.message]).toEqual([url, 403, REFUSAL]);
        }
        // And is still a lab account at the next sign-in, and after its
        // token is renewed.
        const again = await signIn("lab@example.test");
        expect((await call("GET", "/admin/orders", again)).status).toBe(403);
        const renewed = await api.post("/auth/token/refresh", {}, lab);
        const fresh = { headers: { authorization: `Bearer ${renewed.data.token}` } };
        expect((await call("GET", "/admin/orders", fresh)).status).toBe(403);
      });

      it("leaves an ordinary admin account exactly as it was", async () => {
        const orders = await call("GET", "/admin/orders", owner);
        expect(orders.status).toBe(200);
        // The owner gets the real store, not the lab's stand-in.
        const stores = await call("GET", "/admin/stores", owner);
        expect(stores.data.stores[0].id).not.toBe("store_lab");
        expect((await call("GET", "/admin/lab-queue", owner)).status).toBe(200);
        expect((await call("GET", "/admin/users/me", owner)).data.user.email).toBe("owner@example.test");
      });

      it("takes the mark away again, at once", async () => {
        const result = await setLabAccount(getContainer(), "lab@example.test", false);
        expect(result.outcome).toBe("unmarked");
        expect((await call("GET", "/admin/orders", lab)).status).toBe(200);
        expect((await setLabAccount(getContainer(), "lab@example.test", false)).outcome).toBe("unchanged");
      });

      it("marks an account whatever the capitals in its stored email", async () => {
        // Medusa stores an email as typed and matches it exactly.
        await makeUser("Lab.Tech@Example.test");
        const before = await signIn("Lab.Tech@Example.test");
        expect((await call("GET", "/admin/orders", before)).status).toBe(200);
        for (const typed of ["lab.tech@example.test", "LAB.TECH@EXAMPLE.TEST"]) {
          await setLabAccount(getContainer(), "Lab.Tech@Example.test", false);
          const result = await setLabAccount(getContainer(), typed, true);
          expect([typed, result.outcome]).toEqual([typed, "marked"]);
          expect((await call("GET", "/admin/orders", before)).status).toBe(403);
        }
        expect(await listAdminAccounts(getContainer())).toContainEqual({
          email: "Lab.Tech@Example.test",
          lab: true,
        });
      });

      it("lists every admin account with whether it is a lab account", async () => {
        expect(await listAdminAccounts(getContainer())).toEqual([
          { email: "lab@example.test", lab: true },
          { email: "owner@example.test", lab: false },
        ]);
      });

      it("answers plainly for an email that is not an admin user", async () => {
        expect(await setLabAccount(getContainer(), "nobody@example.test", true)).toEqual({
          outcome: "no_such_user",
        });
        expect((await setLabAccount(getContainer(), "LAB@example.test ", true)).outcome).toBe("unchanged");
      });

      it("refuses a caller with no sign-in as Medusa always did", async () => {
        const res = await call("GET", "/admin/lab-queue", { headers: {} });
        expect(res.status).toBe(401);
      });
    });
  },
});
