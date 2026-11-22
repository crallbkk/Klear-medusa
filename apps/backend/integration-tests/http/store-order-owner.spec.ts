// `GET /store/orders/:id` against the real server: the whole backend is
// started on a scratch database, two customers sign in the way the website
// signs a customer in, and each asks for the other's order.
//
// Needs a Postgres: DB_HOST (the literal "localhost") / DB_PORT /
// DB_USERNAME / DB_PASSWORD.   npm run test:integration:http

import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";

jest.setTimeout(300_000);

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    const PASSWORD = "integration-test-only-1";
    let key: Record<string, string>;

    /** A publishable key, as the storefront sends with every request. */
    async function publishableKey(): Promise<Record<string, string>> {
      const container = getContainer();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const keys = container.resolve(Modules.API_KEY) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channels = container.resolve(Modules.SALES_CHANNEL) as any;
      const created = await keys.createApiKeys({ title: "test", type: "publishable", created_by: "test" });
      const channel = await channels.createSalesChannels({ name: "test" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const link = container.resolve("link") as any;
      await link.create({
        [Modules.API_KEY]: { publishable_key_id: created.id },
        [Modules.SALES_CHANNEL]: { sales_channel_id: channel.id },
      });
      return { "x-publishable-api-key": created.token };
    }

    /** A customer who can sign in, and the headers their requests carry. */
    async function customer(email: string): Promise<{ id: string; headers: Record<string, string> }> {
      const registered = await api.post("/auth/customer/emailpass/register", { email, password: PASSWORD });
      const made = await api.post(
        "/store/customers",
        { email },
        { headers: { ...key, authorization: `Bearer ${registered.data.token}` } },
      );
      const signedIn = await api.post("/auth/customer/emailpass", { email, password: PASSWORD });
      return {
        id: made.data.customer.id,
        headers: { ...key, authorization: `Bearer ${signedIn.data.token}` },
      };
    }

    async function order(customerId: string | null, email: string): Promise<string> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = getContainer().resolve(Modules.ORDER) as any;
      const created = await orders.createOrders({
        currency_code: "thb",
        email,
        customer_id: customerId,
        shipping_address: {
          first_name: "Somchai",
          last_name: "Secretname",
          address_1: "1 Secret Road",
          city: "Bangkok",
          country_code: "th",
          phone: "+66811112222",
        },
        items: [{ title: "Frame", quantity: 1, unit_price: 1000 }],
      });
      return created.id as string;
    }

    async function orderChanges(orderId: string): Promise<number> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = getContainer().resolve(Modules.ORDER) as any;
      return (await orders.listOrderChanges({ order_id: orderId })).length;
    }

    const get = (url: string, headers: Record<string, string>) =>
      api.get(url, { headers, validateStatus: () => true });

    describe("one order on the storefront API", () => {
      let me: { id: string; headers: Record<string, string> };
      let other: { id: string; headers: Record<string, string> };
      let mine: string;
      let theirs: string;

      beforeEach(async () => {
        key = await publishableKey();
        me = await customer("me@example.test");
        other = await customer("other@example.test");
        mine = await order(me.id, "me@example.test");
        theirs = await order(other.id, "other@example.test");
      });

      it("is shown to the customer who owns it", async () => {
        const res = await get(`/store/orders/${mine}`, me.headers);
        expect(res.status).toBe(200);
        expect(res.data.order.id).toBe(mine);
        expect(res.data.order.email).toBe("me@example.test");
      });

      it("is not shown to another signed-in customer, and reads exactly like a missing order", async () => {
        const foreign = await get(`/store/orders/${theirs}`, me.headers);
        const missing = await get("/store/orders/order_doesnotexist", me.headers);
        expect(foreign.status).toBe(404);
        expect(missing.status).toBe(404);
        expect(JSON.stringify(foreign.data)).not.toMatch(/Secretname|66811112222|other@example|Secret Road/);
        expect({ ...foreign.data, message: "" }).toEqual({ ...missing.data, message: "" });
      });

      it("is not shown to someone who is not signed in, though they hold its id", async () => {
        // The publishable key is in the website's public JavaScript.
        const res = await get(`/store/orders/${mine}`, key);
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.data)).not.toMatch(/Secretname|66811112222|me@example|Secret Road/);
      });

      it("is not shown for an order that belongs to no customer", async () => {
        const guest = await order(null, "guest@example.test");
        expect((await get(`/store/orders/${guest}`, me.headers)).status).toBe(404);
      });

      it("is refused however the address is written, and whatever fields are asked for", async () => {
        for (const url of [
          `/store/orders/${theirs}/`,
          `/STORE/ORDERS/${theirs}`,
          `/store/orders/${theirs}?fields=*shipping_address,email`,
          `/store//orders/${theirs}`,
        ]) {
          const res = await get(url, me.headers);
          expect([url, res.status === 404 || res.status === 401]).toEqual([url, true]);
          expect([url, /Secretname|66811112222|other@example/.test(JSON.stringify(res.data))]).toEqual([
            url,
            false,
          ]);
        }
      });

      it("cannot be had through Medusa's order transfers, by anyone", async () => {
        // On Medusa's own routes, `request` and `cancel` answer with the
        // whole order to any signed-in customer who is not its owner.
        const changesBefore = await orderChanges(theirs);
        for (const who of [me, other]) {
          for (const step of ["request", "cancel", "accept", "decline"]) {
            for (const id of [theirs, mine, "order_doesnotexist"]) {
              const res = await api.post(
                `/store/orders/${id}/transfer/${step}`,
                { token: "x" },
                { headers: who.headers, validateStatus: () => true },
              );
              expect([step, id, res.status]).toEqual([step, id, 404]);
              expect(JSON.stringify(res.data)).not.toMatch(/Secretname|66811112222|example\.test|Secret Road/);
            }
          }
        }
        // And nothing was written on the order by the attempts.
        expect(await orderChanges(theirs)).toBe(changesBefore);
      });

      it("leaves the customer's own list of orders as it was", async () => {
        const res = await get("/store/orders", me.headers);
        expect(res.status).toBe(200);
        expect(res.data.orders.map((o: { id: string }) => o.id)).toEqual([mine]);
      });
    });
  },
});
