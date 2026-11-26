// The two flows between Medusa and the Website, against the real server:
//
//   contract 7  POST /order-cancel/:id    the Website cancels an order that
//               has not shipped, before it refunds
//   contract 6  the lab's production state, posted to the Website from the
//               production writer's commit, sent again until received
//
// The Website is a small HTTP server started by the test, which records what
// it is sent and answers as the test tells it to.
//
// Needs a Postgres: DB_HOST (the literal "localhost") / DB_PORT /
// DB_USERNAME / DB_PASSWORD.   npm run test:integration:http

import http from "http";
import type { AddressInfo } from "net";
import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { LMS_MODULE } from "../../src/modules/lms/service";
import healPendingRxJob from "../../src/jobs/heal-pending-rx";

jest.setTimeout(300_000);

const CANCEL = "cancel-secret-for-the-integration-test-01";
const PROJECTION = "projection-secret-for-the-integration-test";
const FEED = "feed-secret-for-the-integration-test-0001";
process.env.KLEAR_ORDER_CANCEL_SECRET = CANCEL;
process.env.KLEAR_OPS_FEED_SECRET = FEED;

const CUSTOMER_VALUES = ["secret.person@example.test", "Secretsurname", "99 Secret Soi", "+66899990000"];
const leaks = (body: unknown) => CUSTOMER_VALUES.filter((s) => JSON.stringify(body).includes(s));

type Received = { auth: string | undefined; body: Record<string, unknown> };

/** The Website, as far as these tests need it. */
function fakeWebsite() {
  const received: Received[] = [];
  const answers: Array<{ status: number; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (req.url !== "/api/webhooks/order-projection" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      received.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      const answer = answers.shift() ?? { status: 200, body: { ok: true, outcome: "applied" } };
      res.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify(answer.body));
    });
  });
  return { server, received, answers };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const website = fakeWebsite();

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = (key: string) => getContainer().resolve(key) as any;
    const lms = () => resolve(LMS_MODULE);
    const pg = () => resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const cancel = (id: string, secret = CANCEL) =>
      api.post(`/order-cancel/${encodeURIComponent(id)}`, undefined, {
        headers: { authorization: `Bearer ${secret}` },
        validateStatus: () => true,
      });

    const ADDRESS = {
      first_name: "Somchai",
      last_name: "Secretsurname",
      address_1: "99 Secret Soi",
      city: "Bangkok",
      country_code: "th",
      phone: "+66899990000",
    };

    async function order(): Promise<string> {
      const created = await resolve(Modules.ORDER).createOrders({
        currency_code: "thb",
        email: "secret.person@example.test",
        shipping_address: ADDRESS,
        billing_address: ADDRESS,
        items: [{ title: "Klear Frame", variant_sku: "KLR-F1", quantity: 1, unit_price: 1290 }],
      });
      return created.id as string;
    }

    async function labJob(orderId: string): Promise<string> {
      const job = await lms().createFromBuild({
        outcome: "ok",
        packet: {
          job_ref: `klear-${orderId}`,
          klear_order_id: orderId,
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
      return job.id as string;
    }

    async function labelled(orderId: string): Promise<void> {
      const made = await resolve(Modules.FULFILLMENT).createFulfillment({
        location_id: "sloc_test",
        provider_id: "manual_manual",
        delivery_address: ADDRESS,
        items: [{ title: "Klear Frame", sku: "KLR-F1", barcode: "", quantity: 1, line_item_id: "x", inventory_item_id: null }],
        labels: [],
        order: {},
      });
      await resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.ORDER]: { order_id: orderId },
        [Modules.FULFILLMENT]: { fulfillment_id: made.id },
      });
    }

    const orderStatus = async (id: string) =>
      (await pg().raw(`select status from "order" where id = ?`, [id])).rows[0]?.status;
    const jobRow = async (id: string) =>
      (
        await pg().raw(
          `select stage, projection_state, projection_seq, projection_sent_seq from lab_job where id = ?`,
          [id],
        )
      ).rows[0];

    describe("contract 7: cancelling an order that has not shipped", () => {
      it("cancels it, takes its lab job off the queue, and answers only the outcome", async () => {
        const id = await order();
        const job = await labJob(id);

        const first = await cancel(id);
        expect(first.status).toBe(200);
        expect(first.data).toEqual({ order_id: id, outcome: "cancelled" });
        expect(leaks(first.data)).toEqual([]);
        expect(await orderStatus(id)).toBe("canceled");
        // Medusa's order.canceled event reaches the lab subscriber.
        const after = await until(() => jobRow(job), (r) => r.stage === "cancelled");
        expect(after.stage).toBe("cancelled");

        // A retry is a success, and changes nothing.
        const again = await cancel(id);
        expect(again.status).toBe(200);
        expect(again.data).toEqual({ order_id: id, outcome: "already_cancelled" });
      });

      it("refuses once a label is booked, and leaves the order as it was", async () => {
        const id = await order();
        await labelled(id);
        const res = await cancel(id);
        expect(res.status).toBe(409);
        expect(res.data).toEqual({ order_id: id, outcome: "refused", reason: "fulfilled" });
        expect(await orderStatus(id)).not.toBe("canceled");
      });

      it("says when there is no such order, and refuses what is not an order id", async () => {
        const missing = await cancel("order_01NOSUCHORDER0000000000");
        expect(missing.status).toBe(404);
        expect(missing.data).toEqual({ order_id: "order_01NOSUCHORDER0000000000", outcome: "not_found" });
        const placeholder = await cancel("pending_cart_completion:cart_01X");
        expect(placeholder.status).toBe(400);
        expect(placeholder.data).toEqual({ outcome: "invalid_order_id" });
      });

      it("opens for its own secret only", async () => {
        const id = await order();
        for (const secret of ["wrong-secret-of-the-right-length-000001", FEED]) {
          const res = await cancel(id, secret);
          expect(res.status).toBe(401);
          expect(res.data).toEqual({ error: "unauthorized" });
        }
        expect(await orderStatus(id)).not.toBe("canceled");
      });
    });

    describe("contract 6: the production state, sent to the Website", () => {
      beforeAll(async () => {
        await new Promise<void>((r) => website.server.listen(0, "127.0.0.1", () => r()));
        const { port } = website.server.address() as AddressInfo;
        process.env.KLEAR_STOREFRONT_URL = `http://127.0.0.1:${port}`;
        process.env.KLEAR_PROJECTION_SECRET = PROJECTION;
      });
      afterAll(async () => {
        delete process.env.KLEAR_STOREFRONT_URL;
        delete process.env.KLEAR_PROJECTION_SECRET;
        await new Promise((r) => website.server.close(r));
      });

      it("is posted when a stage is recorded, and marked received when the Website applies it", async () => {
        website.received.length = 0;
        const id = await order();
        const job = await labJob(id); // the packet builds: ready
        const got = await until(async () => website.received.length, (n) => n >= 1);
        expect(got).toBe(1);
        const sent = website.received[0];
        expect(sent.auth).toBe(`Bearer ${PROJECTION}`);
        expect(Object.keys(sent.body).sort()).toEqual(
          ["medusa_order_id", "occurred_at", "sequence", "state", "warranty_cycle"],
        );
        expect(sent.body).toMatchObject({ medusa_order_id: id, state: "pending_lab", sequence: 1, warranty_cycle: 0 });
        expect(leaks(sent.body)).toEqual([]);
        expect((await until(() => jobRow(job), (r) => r.projection_sent_seq === 1)).projection_sent_seq).toBe(1);
      });

      it("is sent again by the sweep when the Website did not take it, and only then counts as received", async () => {
        website.received.length = 0;
        const id = await order();
        const job = await labJob(id);
        await until(async () => website.received.length, (n) => n >= 1);
        await until(() => jobRow(job), (r) => r.projection_sent_seq === 1);

        // The Website is down for the next one.
        website.answers.push({ status: 503, body: { ok: false, error: "service unavailable" } });
        const row = await lms().retrieveLabJob(job);
        await lms().applyProductionAction({
          job_id: job,
          action: "PRINTED",
          idempotency_key: `it-printed-${job}`,
          expected_version: row.stage_version,
          actor: { type: "user", id: "user_it" },
        });
        await until(async () => website.received.length, (n) => n >= 2);
        expect(website.received[1].body).toMatchObject({ state: "sent_to_lab", sequence: 2 });
        // Give a stray acknowledgement the chance to land; there must be none.
        await new Promise((r) => setTimeout(r, 300));
        expect((await jobRow(job)).projection_sent_seq).toBe(1);

        // Then it cannot apply it yet (the order is not known to it).
        website.answers.push({ status: 409, body: { ok: false, outcome: "not_ready" } });
        await healPendingRxJob(getContainer());
        expect(website.received.length).toBeGreaterThanOrEqual(3);
        expect((await jobRow(job)).projection_sent_seq).toBe(1);

        // And then it takes it.
        await healPendingRxJob(getContainer());
        const last = website.received[website.received.length - 1];
        expect(last.body).toMatchObject({ medusa_order_id: id, state: "sent_to_lab", sequence: 2 });
        expect((await jobRow(job)).projection_sent_seq).toBe(2);
      });
    });
  },
});
