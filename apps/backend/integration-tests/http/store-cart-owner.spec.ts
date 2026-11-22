// Who a cart (and so the order made from it) belongs to, against the real
// server: the whole backend is started on a scratch database, customers sign
// in the way the website signs a customer in, and carts are created and given
// an email the way the website's checkout does.
//
// The rule: a cart is attached to a customer who has an account only when the
// caller is signed in as that customer. Anyone else who types an account's
// email gets a guest order under that email.
//
// Needs a Postgres: DB_HOST (the literal "localhost") / DB_PORT /
// DB_USERNAME / DB_PASSWORD.   npm run test:integration:http

import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";

jest.setTimeout(300_000);

type Headers = Record<string, string>;
type Owner = { customer_id: string | null; email: string | null; has_account: boolean | null; owner_email: string | null };

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    const PASSWORD = "integration-test-only-1";
    let key: Headers;
    let regionId: string;
    let keyChannelId: string;

    /** A publishable key, as the storefront sends with every request. */
    async function publishableKey(): Promise<Headers> {
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
      keyChannelId = channel.id;
      return { "x-publishable-api-key": created.token };
    }

    /** A Thai region, as the project's seed makes (the test runner does not run the seed). */
    async function region(): Promise<string> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const regions = getContainer().resolve(Modules.REGION) as any;
      const made = await regions.createRegions({ name: "Thailand", currency_code: "thb", countries: ["th"] });
      return made.id as string;
    }

    /** A customer who can sign in, and the headers their requests carry. */
    async function customer(email: string): Promise<{ id: string; headers: Headers }> {
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

    async function guestCustomer(email: string): Promise<string> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customers = getContainer().resolve(Modules.CUSTOMER) as any;
      return ((await customers.createCustomers({ email })) as { id: string }).id;
    }

    async function customersWithEmail(email: string): Promise<{ id: string; has_account: boolean }[]> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customers = getContainer().resolve(Modules.CUSTOMER) as any;
      return customers.listCustomers({ email });
    }

    const post = (url: string, body: unknown, headers: Headers) =>
      api.post(url, body, { headers, validateStatus: () => true });

    async function newCart(headers: Headers, body: Record<string, unknown> = {}): Promise<string> {
      const res = await post("/store/carts", { region_id: regionId, ...body }, headers);
      expect([res.status, res.data?.message]).toEqual([200, undefined]);
      return res.data.cart.id as string;
    }

    async function setEmail(cartId: string, email: string, headers: Headers): Promise<void> {
      const res = await post(`/store/carts/${cartId}`, { email }, headers);
      expect([email, res.status, res.data?.message]).toEqual([email, 200, undefined]);
    }

    /** The cart's owner, read straight from the database (not from the API answer). */
    async function owner(cartId: string): Promise<Owner> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const carts = getContainer().resolve(Modules.CART) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const customers = getContainer().resolve(Modules.CUSTOMER) as any;
      const cart = await carts.retrieveCart(cartId, { select: ["id", "email", "customer_id"] });
      const who = cart.customer_id ? await customers.retrieveCustomer(cart.customer_id) : null;
      return {
        customer_id: cart.customer_id ?? null,
        email: cart.email ?? null,
        has_account: who ? Boolean(who.has_account) : null,
        owner_email: who?.email ?? null,
      };
    }

    /** Places the order. The cart is empty, so its total is 0 and Medusa skips payment and shipping. */
    async function complete(cartId: string): Promise<{ id: string; customer_id: string | null; email: string | null }> {
      const res = await post(`/store/carts/${cartId}/complete`, {}, key);
      expect([res.status, res.data?.type, res.data?.error?.message]).toEqual([200, "order", undefined]);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const orders = getContainer().resolve(Modules.ORDER) as any;
      const order = await orders.retrieveOrder(res.data.order.id, { select: ["id", "customer_id", "email"] });
      return { id: order.id, customer_id: order.customer_id ?? null, email: order.email ?? null };
    }

    async function orderIdsOf(headers: Headers): Promise<string[]> {
      const res = await api.get("/store/orders", { headers });
      return res.data.orders.map((o: { id: string }) => o.id);
    }

    describe("who a cart belongs to", () => {
      let me: { id: string; headers: Headers };
      let other: { id: string; headers: Headers };

      beforeEach(async () => {
        key = await publishableKey();
        regionId = await region();
        me = await customer("me@example.test");
        other = await customer("other@example.test");
      });

      describe("a guest (nobody signed in)", () => {
        it("who types an account's email gets a guest order under that email, not the account's", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "other@example.test", key);
          const got = await owner(cart);
          expect(got.customer_id).not.toBe(other.id);
          expect(got).toEqual(
            expect.objectContaining({ email: "other@example.test", has_account: false, owner_email: "other@example.test" }),
          );

          const order = await complete(cart);
          expect(order).toEqual({ id: order.id, customer_id: got.customer_id, email: "other@example.test" });
          // The account holder does not see the guest's order (delivery name, address, phone).
          expect(await orderIdsOf(other.headers)).toEqual([]);
        });

        it("who types an account's email in other letter case still gets a guest order", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "Other@Example.TEST", key);
          const got = await owner(cart);
          expect(got.customer_id).not.toBe(other.id);
          expect(got.has_account).toBe(false);
          expect(got.email).toBe("other@example.test");
        });

        it("who creates the cart with an account's email gets a guest cart", async () => {
          const cart = await newCart(key, { email: "other@example.test" });
          const got = await owner(cart);
          expect(got.customer_id).not.toBe(other.id);
          expect(got).toEqual(expect.objectContaining({ email: "other@example.test", has_account: false }));
          const order = await complete(cart);
          expect(order.customer_id).toBe(got.customer_id);
          expect(order.email).toBe("other@example.test");
        });

        it("who types an account's email reuses the guest customer that email already has", async () => {
          const guest = await guestCustomer("other@example.test");
          const first = await newCart(key);
          await setEmail(first, "other@example.test", key);
          const second = await newCart(key, { email: "other@example.test" });
          expect((await owner(first)).customer_id).toBe(guest);
          expect((await owner(second)).customer_id).toBe(guest);
          // Exactly one guest and one account share that email.
          const all = await customersWithEmail("other@example.test");
          expect(all.map((c) => c.has_account).sort()).toEqual([false, true]);
        });

        it("who types an email nobody has gets a new guest customer, as before", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "new@example.test", key);
          const got = await owner(cart);
          expect(got).toEqual(expect.objectContaining({ email: "new@example.test", has_account: false }));
          expect((await customersWithEmail("new@example.test")).length).toBe(1);
          const order = await complete(cart);
          expect(order).toEqual({ id: order.id, customer_id: got.customer_id, email: "new@example.test" });
        });

        it("who types an email that already has a guest customer reuses it, as before", async () => {
          const guest = await guestCustomer("returning@example.test");
          const cart = await newCart(key);
          await setEmail(cart, "returning@example.test", key);
          expect((await owner(cart)).customer_id).toBe(guest);
          expect((await customersWithEmail("returning@example.test")).length).toBe(1);
        });

        it("who changes the email to another address and back never lands on the account", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "other@example.test", key);
          const firstGuest = (await owner(cart)).customer_id;
          await setEmail(cart, "elsewhere@example.test", key);
          const elsewhere = await owner(cart);
          expect(elsewhere).toEqual(expect.objectContaining({ email: "elsewhere@example.test", has_account: false }));
          await setEmail(cart, "other@example.test", key);
          const back = await owner(cart);
          expect(back.customer_id).toBe(firstGuest);
          expect(back.customer_id).not.toBe(other.id);
          expect(back).toEqual(expect.objectContaining({ email: "other@example.test", has_account: false }));
        });

        it("whose request Medusa refuses leaves the cart and the customers as they were", async () => {
          // Medusa checks the body before the project's code runs: a refused
          // request makes no guest customer and attaches nothing.
          const cart = await newCart(key);
          const bad = await post(`/store/carts/${cart}`, { email: "refused@example.test", not_a_field: 1 }, key);
          expect(bad.status).toBe(400);
          const badCreate = await post("/store/carts", { region_id: regionId, email: "refused@example.test", nope: 1 }, key);
          expect(badCreate.status).toBe(400);
          expect((await owner(cart)).customer_id).toBeNull();
          expect(await customersWithEmail("refused@example.test")).toEqual([]);
        });

        it("on a cart that has an account's email but no customer: no email in the body attaches nobody, a null email attaches a guest", async () => {
          // Such carts are not made by the storefront (made in admin, or older
          // carts). Medusa attaches a customer only when the body has an
          // `email` key, then using `body.email ?? cart.email`; so does the
          // middleware.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const carts = getContainer().resolve(Modules.CART) as any;
          const made = await carts.createCarts({
            currency_code: "thb",
            region_id: regionId,
            sales_channel_id: keyChannelId,
            email: "other@example.test",
          });
          const noEmail = await post(`/store/carts/${made.id}`, { metadata: { note: "x" } }, key);
          expect([noEmail.status, noEmail.data?.message]).toEqual([200, undefined]);
          expect((await owner(made.id)).customer_id).toBeNull();
          expect((await customersWithEmail("other@example.test")).map((c) => c.has_account)).toEqual([true]);

          const nullEmail = await post(`/store/carts/${made.id}`, { email: null }, key);
          expect([nullEmail.status, nullEmail.data?.message]).toEqual([200, undefined]);
          const got = await owner(made.id);
          expect(got.customer_id).not.toBe(other.id);
          expect(got).toEqual(expect.objectContaining({ has_account: false, owner_email: "other@example.test" }));
        });

        it("creating a cart still goes through Medusa's sales-channel checks for the publishable key", async () => {
          // The project replaces Medusa's handler for creating a cart; Medusa's
          // checks on that route must still run in front of it.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const channels = getContainer().resolve(Modules.SALES_CHANNEL) as any;
          const foreign = await channels.createSalesChannels({ name: "not this key's" });
          const refused = await post("/store/carts", { region_id: regionId, sales_channel_id: foreign.id }, key);
          expect(refused.status).toBe(400);
          const made = await post("/store/carts", { region_id: regionId }, key);
          expect(made.status).toBe(200);
          // Medusa's key-scope check fills in the key's own channel.
          expect(made.data.cart.sales_channel_id).toBe(keyChannelId);
        });

        it("on two carts at once with the same new email both get the one guest customer", async () => {
          const [a, b] = [await newCart(key), await newCart(key)];
          const [ra, rb] = await Promise.all([
            post(`/store/carts/${a}`, { email: "race@example.test" }, key),
            post(`/store/carts/${b}`, { email: "race@example.test" }, key),
          ]);
          expect([ra.status, rb.status]).toEqual([200, 200]);
          const guests = await customersWithEmail("race@example.test");
          expect(guests.length).toBe(1);
          expect((await owner(a)).customer_id).toBe(guests[0].id);
          expect((await owner(b)).customer_id).toBe(guests[0].id);
        });
      });

      describe("a signed-in customer", () => {
        it("whose cart was attached to them keeps it whatever email they type (the storefront's planned flow)", async () => {
          // The website creates the cart with no token, then (planned) attaches it.
          const cart = await newCart(key);
          const attached = await post(`/store/carts/${cart}/customer`, {}, me.headers);
          expect(attached.status).toBe(200);
          expect((await owner(cart)).customer_id).toBe(me.id);

          for (const email of ["me@example.test", "unrelated@example.test", "other@example.test"]) {
            await setEmail(cart, email, me.headers);
            const got = await owner(cart);
            expect([email, got.customer_id, got.email]).toEqual([email, me.id, email]);
          }
          const order = await complete(cart);
          expect(order).toEqual({ id: order.id, customer_id: me.id, email: "other@example.test" });
          expect(await orderIdsOf(me.headers)).toEqual([order.id]);
          expect(await orderIdsOf(other.headers)).toEqual([]);
        });

        it("whose cart was attached to them keeps it when an email is set without their token", async () => {
          const cart = await newCart(key);
          await post(`/store/carts/${cart}/customer`, {}, me.headers);
          await setEmail(cart, "other@example.test", key);
          expect((await owner(cart)).customer_id).toBe(me.id);
        });

        it("who types their own email on a cart made without a token gets the cart, as today", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "me@example.test", me.headers);
          expect(await owner(cart)).toEqual(
            expect.objectContaining({ customer_id: me.id, email: "me@example.test", has_account: true }),
          );
          const order = await complete(cart);
          expect(order).toEqual({ id: order.id, customer_id: me.id, email: "me@example.test" });
        });

        it("who types another account's email on a cart made without a token gets a guest order under it", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "other@example.test", me.headers);
          const got = await owner(cart);
          expect(got.customer_id).not.toBe(other.id);
          expect(got.customer_id).not.toBe(me.id);
          expect(got).toEqual(expect.objectContaining({ email: "other@example.test", has_account: false }));
          const order = await complete(cart);
          expect(order.customer_id).toBe(got.customer_id);
          expect(await orderIdsOf(other.headers)).toEqual([]);
        });

        it("who types an email nobody has on a cart made without a token gets a new guest customer", async () => {
          const cart = await newCart(key);
          await setEmail(cart, "nobody@example.test", me.headers);
          const got = await owner(cart);
          expect(got.customer_id).not.toBe(me.id);
          expect(got).toEqual(expect.objectContaining({ email: "nobody@example.test", has_account: false }));
          expect((await customersWithEmail("nobody@example.test")).length).toBe(1);
        });

        it("who types an email that already has a guest customer on a cart made without a token gets that guest", async () => {
          const guest = await guestCustomer("known-guest@example.test");
          const cart = await newCart(key);
          await setEmail(cart, "known-guest@example.test", me.headers);
          expect((await owner(cart)).customer_id).toBe(guest);
          expect((await customersWithEmail("known-guest@example.test")).length).toBe(1);
        });

        it("who attaches the cart while an email is being set keeps it: the email waits for the cart's lock", async () => {
          // Medusa's attach (`POST /store/carts/:id/customer`) writes the
          // customer while holding the cart's lock. Holding that lock here
          // stands in for an attach in progress: the email update must not
          // touch the cart until the lock is free, and must then see the
          // customer the attach wrote and leave it.
          //
          // No sleeping on a guess: the server shares this process's locking
          // service, so the test wraps its `execute` and waits until the
          // email update has actually asked for this cart's lock (it has
          // then made its first, unlocked read and is waiting). Only then
          // does the "attach" write. Without the lock in the middleware,
          // `execute` is never asked for and the test fails at that wait.
          const cart = await newCart(key);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const locking = getContainer().resolve(Modules.LOCKING) as any;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const carts = getContainer().resolve(Modules.CART) as any;
          let askedForLock: () => void = () => undefined;
          const lockAsked = new Promise<void>((resolve) => (askedForLock = resolve));
          const realExecute = locking.execute;
          locking.execute = (keys: unknown, ...rest: unknown[]) => {
            if (keys === cart) askedForLock();
            return realExecute.call(locking, keys, ...rest);
          };
          await locking.acquire(cart, { expire: 10 });
          let pending: Promise<{ status: number; data: { message?: string } }> | undefined;
          try {
            pending = post(`/store/carts/${cart}`, { email: "other@example.test" }, key);
            const waited = await Promise.race([
              lockAsked.then(() => "asked for the lock"),
              new Promise((r) => setTimeout(() => r("never asked for the lock"), 4000)),
            ]);
            expect(waited).toBe("asked for the lock");
            // While the lock is held, nothing has been written.
            expect((await owner(cart)).customer_id).toBeNull();
            expect(await customersWithEmail("other@example.test")).toEqual([
              expect.objectContaining({ id: other.id, has_account: true }),
            ]);
            // The "attach" finishes under the lock.
            await carts.updateCarts([{ id: cart, customer_id: me.id, email: "me@example.test" }]);
          } finally {
            await locking.release(cart);
            locking.execute = realExecute;
          }
          const res = await pending;
          expect([res?.status, res?.data?.message]).toEqual([200, undefined]);
          expect((await owner(cart)).customer_id).toBe(me.id);
        });

        it("who creates a cart with their token keeps it, whatever email the cart is created with", async () => {
          const cart = await newCart(me.headers, { email: "other@example.test" });
          expect(await owner(cart)).toEqual(
            expect.objectContaining({ customer_id: me.id, email: "other@example.test", has_account: true }),
          );
        });
      });
    });
  },
});
