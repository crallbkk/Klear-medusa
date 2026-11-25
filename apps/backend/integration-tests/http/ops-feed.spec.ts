// The commerce feed (contract 1) and the stock sync routes (contract 5)
// against the real server: the whole backend is started on a scratch
// database, real orders and fulfillments are made through Medusa's own
// modules, and the feed is paged through with its cursor.
//
// The feed holds back anything updated in the last 60 seconds. Rather than
// wait, a test moves a record's updated time into the past with SQL, after
// checking that Medusa itself moved it.
//
// Needs a Postgres: DB_HOST (the literal "localhost") / DB_PORT /
// DB_USERNAME / DB_PASSWORD.   npm run test:integration:http

import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";

jest.setTimeout(300_000);

const FEED = "feed-secret-for-the-integration-test-0001";
const SYNC = "sync-secret-for-the-integration-test-0001";
const LENS = "lens-secret-for-the-integration-test-0001";
process.env.KLEAR_OPS_FEED_SECRET = FEED;
process.env.KLEAR_STOCK_SYNC_SECRET = SYNC;
process.env.KLEAR_LENS_SNAPSHOT_SECRET = LENS;

// Every one of these is written into the orders and fulfillments below, in
// the places that must stay in Medusa. None may appear in any answer.
const SECRETS = [
  "SECRET-RX-ID-7731",
  "SECRET-SIG-AAAA",
  "SECRET-ORDER-META",
  "SECRET-LINE-META",
  "secret.person@example.test",
  "Secretsurname",
  "99 Secret Soi",
  "+66899990000",
  "SECRET-TRACKING-SP999",
  "SECRET-COURIER-TH999",
  "SECRET-PUBLIC-CODE",
];
const leaks = (body: unknown) => SECRETS.filter((s) => JSON.stringify(body).includes(s));

medusaIntegrationTestRunner({
  testSuite: ({ api, getContainer }) => {
    const PASSWORD = "integration-test-only-1";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolve = (key: string) => getContainer().resolve(key) as any;
    const pg = () => resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const get = (url: string, headers: Record<string, string> = { authorization: `Bearer ${FEED}` }) =>
      api.get(url, { headers, validateStatus: () => true });
    const post = (url: string, body: unknown, secret: string) =>
      api.post(url, body, { headers: { authorization: `Bearer ${secret}` }, validateStatus: () => true });

    const ADDRESS = {
      first_name: "Somchai",
      last_name: "Secretsurname",
      address_1: "99 Secret Soi",
      city: "Bangkok",
      country_code: "th",
      phone: "+66899990000",
    };

    /** A real order with a cart, a frame line and a lens line, and every
     *  kind of value that must not cross. */
    async function order(): Promise<{ id: string; lines: string[]; cart: string }> {
      const orders = resolve(Modules.ORDER);
      const carts = resolve(Modules.CART);
      const created = await orders.createOrders({
        currency_code: "thb",
        email: "secret.person@example.test",
        metadata: {
          klear_prescription_id: "SECRET-RX-ID-7731",
          klear_prescription_sig: "SECRET-SIG-AAAA",
          note: "SECRET-ORDER-META",
          public_code: "SECRET-PUBLIC-CODE",
        },
        shipping_address: ADDRESS,
        billing_address: ADDRESS,
        items: [
          {
            title: "Klear Frame",
            subtitle: "Black",
            variant_sku: "KLR-F1",
            quantity: 1,
            unit_price: 1290,
            adjustments: [{ code: "TEST100", amount: 100 }],
            metadata: {
              klear_kind: "frame",
              klear_prescription_id: "SECRET-RX-ID-7731",
              klear_prescription_sig: "SECRET-SIG-AAAA",
              other: "SECRET-LINE-META",
            },
          },
          {
            title: "Klear Lenses",
            variant_sku: "KLR-LENS-SV167",
            quantity: 1,
            unit_price: 590.5,
            metadata: { klear_kind: "lens", other: "SECRET-LINE-META" },
          },
        ],
        // A 20 baht shipping discount, so discount_total must include it.
        shipping_methods: [{ name: "Flash Express", amount: 50, adjustments: [{ code: "SHIP20", amount: 20 }] }],
      });
      const cart = await carts.createCarts({ currency_code: "thb", email: "secret.person@example.test" });
      await resolve(ContainerRegistrationKeys.LINK).create({
        [Modules.ORDER]: { order_id: created.id },
        [Modules.CART]: { cart_id: cart.id },
      });
      const full = await orders.retrieveOrder(created.id, { relations: ["items"] });
      return { id: created.id, lines: full.items.map((i: { id: string }) => i.id), cart: cart.id };
    }

    /** A fulfillment of an order, made by the fulfillment module with the
     *  manual provider, then given the data the Shippop adapter stores. */
    async function fulfillment(
      orderId: string | null,
      items: Array<{ line_item_id: string; sku: string; quantity?: number; inventory_item_id?: string }>,
    ): Promise<string> {
      const created = await resolve(Modules.FULFILLMENT).createFulfillment({
        location_id: "sloc_test",
        provider_id: "manual_manual",
        delivery_address: ADDRESS,
        items: items.map((i) => ({
          title: "Secretsurname",
          sku: i.sku,
          barcode: "",
          quantity: i.quantity ?? 1,
          line_item_id: i.line_item_id,
          inventory_item_id: i.inventory_item_id ?? null,
        })),
        labels: [
          { tracking_number: "SECRET-TRACKING-SP999", tracking_url: "https://x.test", label_url: "https://x.test" },
        ],
        order: {},
      });
      await pg().raw(`update "fulfillment" set "data" = ?::jsonb where "id" = ?`, [
        JSON.stringify({
          shippop_tracking_code: "SECRET-TRACKING-SP999",
          courier_tracking_code: "SECRET-COURIER-TH999",
          cost_thb: 45.5,
        }),
        created.id,
      ]);
      if (orderId) {
        await resolve(ContainerRegistrationKeys.LINK).create({
          [Modules.ORDER]: { order_id: orderId },
          [Modules.FULFILLMENT]: { fulfillment_id: created.id },
        });
      }
      return created.id as string;
    }

    /** The microsecond text of a row's updated time, read from the table. */
    async function updatedAt(table: string, id: string): Promise<string> {
      const { rows } = await pg().raw(
        `select to_char("updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t
           from "${table}" where "id" = ?`,
        [id],
      );
      return rows[0].t;
    }

    /** Put rows' updated time `secondsAgo` in the past, all to the same
     *  instant, so the feed's 60-second hold has passed. Their created
     *  time goes back with it (never after the updated time), as it would
     *  have been for a record really made that long ago. */
    async function age(table: string, ids: string[], secondsAgo: number): Promise<void> {
      await pg().raw(
        `update "${table}"
            set "updated_at" = date_trunc('second', now()) - (? * interval '1 second'),
                "created_at" = least("created_at", date_trunc('second', now()) - (? * interval '1 second'))
          where "id" in (${ids.map(() => "?").join(", ")})`,
        [secondsAgo, secondsAgo, ...ids],
      );
    }

    /** Page through a stream with a small page size until it says there
     *  is no more. */
    async function drain(stream: "orders" | "fulfillments", after?: string | null, limit = 2) {
      const seen: Array<Record<string, unknown>> = [];
      const bodies: unknown[] = [];
      let cursor = after ?? null;
      for (let i = 0; i < 100; i++) {
        const q = new URLSearchParams({ limit: String(limit) });
        if (cursor) q.set("after", cursor);
        const res = await get(`/ops-feed/${stream}?${q.toString()}`);
        expect(res.status).toBe(200);
        bodies.push(res.data);
        seen.push(...res.data[stream]);
        cursor = res.data.next_after;
        if (!res.data.has_more) return { seen, cursor, last: res.data, bodies };
      }
      throw new Error("the feed never said it was done");
    }

    describe("who can read the feed", () => {
      it("only the bearer of the feed secret: not an admin, a customer, a publishable key or another secret", async () => {
        const users = resolve(Modules.USER);
        const auth = resolve(Modules.AUTH);
        const user = await users.createUsers({ email: "admin@example.test" });
        const registered = await auth.register("emailpass", {
          body: { email: "admin@example.test", password: PASSWORD },
        });
        await auth.updateAuthIdentities({ id: registered.authIdentity.id, app_metadata: { user_id: user.id } });
        const admin = (await api.post("/auth/user/emailpass", { email: "admin@example.test", password: PASSWORD }))
          .data.token;
        const customer = (
          await api.post("/auth/customer/emailpass/register", { email: "c@example.test", password: PASSWORD })
        ).data.token;
        const key = await resolve(Modules.API_KEY).createApiKeys({
          title: "pk",
          type: "publishable",
          created_by: "test",
        });
        const secretKey = await resolve(Modules.API_KEY).createApiKeys({
          title: "sk",
          type: "secret",
          created_by: "test",
        });
        const o = await order();
        await age("order", [o.id], 600);

        for (const stream of ["orders", "fulfillments"]) {
          for (const headers of [
            {},
            { authorization: `Bearer ${admin}` },
            { authorization: `Bearer ${customer}` },
            { "x-publishable-api-key": key.token },
            { authorization: `Basic ${Buffer.from(`${secretKey.token}:`).toString("base64")}` },
            { authorization: `Bearer ${SYNC}` },
            { authorization: `Bearer ${LENS}` },
          ] as Array<Record<string, string>>) {
            const res = await get(`/ops-feed/${stream}`, headers);
            expect([stream, Object.keys(headers), res.status]).toEqual([stream, Object.keys(headers), 401]);
            expect(leaks(res.data)).toEqual([]);
            expect(JSON.stringify(res.data)).not.toContain(o.id);
          }
        }
        // The admin's session is real: it opens Medusa's own admin routes.
        expect((await get("/admin/users/me", { authorization: `Bearer ${admin}` })).status).toBe(200);
        // And the feed's own secret opens the feed.
        expect((await get("/ops-feed/orders")).status).toBe(200);
      });

      it("the stock sync routes open only to their own secrets, and the feed secret writes nothing", async () => {
        const frames = { watermark: null, frames: [{ inventory_item_id: "iitem_none", on_hand: 1 }] };
        const lenses = { as_of: "2026-11-08", lenses: [{ sku: "LENS-A", on_hand: 1 }] };
        for (const secret of [FEED, LENS]) {
          expect((await post("/ops-sync/frame-stock", frames, secret)).status).toBe(401);
        }
        for (const secret of [FEED, SYNC]) {
          expect((await post("/ops-sync/lens-stock", lenses, secret)).status).toBe(401);
        }
        const { rows } = await pg().raw(`select count(*)::int as n from "lens_stock_snapshot"`);
        expect(rows[0].n).toBe(0);
        // And the feed routes take no writes at all.
        const write = await api.post("/ops-feed/orders", {}, {
          headers: { authorization: `Bearer ${FEED}` },
          validateStatus: () => true,
        });
        expect(write.status).toBe(404);
      });
    });

    describe("the orders stream", () => {
      it("serves the contract's fields, Medusa's totals in whole satang, and nothing that must not cross", async () => {
        const o = await order();
        await age("order", [o.id], 600);
        const { seen, bodies } = await drain("orders");
        expect(seen).toHaveLength(1);
        const rec = seen[0] as Record<string, unknown>;
        expect(Object.keys(rec).sort()).toEqual(
          [
            "id",
            "display_id",
            "cart_id",
            "placed_at",
            "currency_code",
            "item_total_satang",
            "discount_total_satang",
            "shipping_total_satang",
            "total_satang",
            "canceled_at",
            "sales_channel_id",
            "version",
            "updated_at",
            "lines",
          ].sort(),
        );
        expect(rec).toMatchObject({
          id: o.id,
          cart_id: o.cart,
          currency_code: "thb",
          // 1,290 + 590.50 less a 100 discount on the frame; 50 shipping
          // less a 20 shipping discount.
          item_total_satang: 178050,
          discount_total_satang: 12000,
          shipping_total_satang: 3000,
          total_satang: 181050,
          canceled_at: null,
        });
        expect(typeof rec.display_id).toBe("number");
        expect(rec.updated_at).toBe(await updatedAt("order", o.id));
        const lines = rec.lines as Array<Record<string, unknown>>;
        expect(lines.map((l) => Object.keys(l).sort())).toEqual([
          ["description", "discount_satang", "gross_satang", "id", "quantity", "sku"],
          ["description", "discount_satang", "gross_satang", "id", "quantity", "sku"],
        ]);
        expect(lines.map((l) => [l.sku, l.description, l.quantity, l.gross_satang, l.discount_satang]).sort()).toEqual(
          [
            ["KLR-F1", "Klear Frame / Black", 1, 129000, 10000],
            ["KLR-LENS-SV167", "Klear Lenses", 1, 59050, 0],
          ],
        );
        expect(lines.map((l) => l.id).sort()).toEqual([...o.lines].sort());
        expect(leaks(bodies)).toEqual([]);
        expect(JSON.stringify(bodies)).not.toMatch(/metadata|email|address|phone|customer|prescription/i);
      });

      it("holds back an order updated in the last 60 seconds", async () => {
        const o = await order();
        expect((await drain("orders")).seen).toEqual([]);
        await age("order", [o.id], 61);
        expect((await drain("orders")).seen.map((r) => r.id)).toEqual([o.id]);
      });

      it("serves an order exactly as placed, before and after part of a line comes back in a return", async () => {
        // The reviewer's case: a line of 2 at 1,290 with a 100 discount.
        const orders = resolve(Modules.ORDER);
        const created = await orders.createOrders({
          currency_code: "thb",
          email: "secret.person@example.test",
          shipping_address: ADDRESS,
          items: [
            {
              title: "Klear Frame",
              variant_sku: "KLR-F1",
              quantity: 2,
              unit_price: 1290,
              adjustments: [{ code: "TEST100", amount: 100 }],
              metadata: { other: "SECRET-LINE-META" },
            },
          ],
          shipping_methods: [{ name: "Flash Express", amount: 50 }],
        });
        const line = (await orders.retrieveOrder(created.id, { relations: ["items"] })).items[0].id;
        // Both pieces shipped (what Medusa's fulfillment workflow records on
        // the order), so one can come back.
        await orders.registerFulfillment({ order_id: created.id, items: [{ id: line, quantity: 2 }] });
        await age("order", [created.id], 600);
        const first = (await drain("orders")).seen[0];
        expect(first).toMatchObject({
          item_total_satang: 248000,
          discount_total_satang: 10000,
          shipping_total_satang: 5000,
          total_satang: 253000,
          lines: [{ id: line, quantity: 2, gross_satang: 258000, discount_satang: 10000 }],
        });

        // One piece comes back: Medusa's own return, created and received.
        const ret = await orders.createReturn({ order_id: created.id, items: [{ id: line, quantity: 1 }] });
        await orders.receiveReturn({ return_id: ret.id, items: [{ id: line, quantity: 1 }] });
        const after = await orders.retrieveOrder(created.id, { relations: ["items"] });
        expect(Number(after.items[0].detail.return_received_quantity)).toBe(1);
        // Medusa's own figures for the line have shrunk; the feed's must not.
        const graph = await resolve(ContainerRegistrationKeys.QUERY).graph({
          entity: "order",
          fields: ["items.*", "items.adjustments.*", "items.detail.*", "total"],
          filters: { id: [created.id] },
        });
        expect(Number(graph.data[0].items[0].subtotal)).toBe(1290);

        await age("order", [created.id], 300);
        const again = (await drain("orders")).seen[0];
        const { updated_at: _a, version: v1, ...firstRest } = first;
        const { updated_at: _b, version: v2, ...againRest } = again;
        expect(JSON.stringify(againRest)).toBe(JSON.stringify(firstRest));
        expect(Number(v2)).toBeGreaterThan(Number(v1));
      });

      it("serves an order as placed through a return, two claims, an exchange and an edit, and says its version rose", async () => {
        const orders = resolve(Modules.ORDER);
        const o = await order();
        // Both of its lines shipped, as Medusa's fulfillment workflow records.
        await orders.registerFulfillment({
          order_id: o.id,
          items: [
            { id: o.lines[0], quantity: 1 },
            { id: o.lines[1], quantity: 1 },
          ],
        });
        await age("order", [o.id], 3600);
        const first = (await drain("orders")).seen[0];
        expect(first).toMatchObject({
          item_total_satang: 178050,
          discount_total_satang: 12000,
          shipping_total_satang: 3000,
          total_satang: 181050,
        });
        // What must never move: everything but the clock and the version.
        const amounts = (r: Record<string, unknown>) => {
          const { updated_at: _u, version: _v, ...rest } = r;
          return JSON.stringify(rest);
        };
        let last = first;
        let ago = 3000;
        const reserved = async (step: string) => {
          ago -= 300;
          await age("order", [o.id], ago);
          const again = (await drain("orders")).seen[0];
          expect([step, String(again.updated_at) > String(last.updated_at)]).toEqual([step, true]);
          expect([step, Number(again.version) > Number(last.version)]).toEqual([step, true]);
          expect([step, amounts(again)]).toEqual([step, amounts(first)]);
          last = again;
        };

        // 1. A return is NOT received on this order. Medusa 2.14's order
        //    module refuses to receive a return on an order with a shipping
        //    discount ("Order shipping method adjustment with version: 4 ...
        //    already exists": it copies the shipping adjustment twice into
        //    one version). That is Medusa's fault, not the feed's, and it is
        //    reported. The return case is the test above, on an order with
        //    a line discount only.

        // 2. A claim that adds a new line.
        await orders.createClaim({
          order_id: o.id,
          type: "replace",
          claim_items: [{ id: o.lines[0], quantity: 1, reason: "production_failure" }],
          additional_items: [{ title: "Replacement Frame", variant_sku: "KLR-F1", quantity: 1, unit_price: 1290 }],
        });
        await reserved("claim with a new line");

        // 3. A claim that tops up the existing lens line.
        await orders.createClaim({
          order_id: o.id,
          type: "replace",
          claim_items: [{ id: o.lines[1], quantity: 1, reason: "production_failure" }],
          additional_items: [{ id: o.lines[1], quantity: 1 }],
        });
        await reserved("claim topping up a line");

        // 4. An exchange, with its return shipping.
        await orders.registerFulfillment({ order_id: o.id, items: [{ id: o.lines[1], quantity: 1 }] });
        await orders.createExchange({
          order_id: o.id,
          additional_items: [{ title: "Exchanged Lenses", variant_sku: "KLR-LENS-SV150", quantity: 1, unit_price: 300 }],
          return_items: [{ id: o.lines[1], quantity: 1 }],
          return_shipping: { name: "Return", amount: 40 },
        });
        await reserved("exchange with return shipping");

        // 5. An order edit: a new line, a changed quantity and price.
        const [added] = await orders.createOrderLineItems([{ title: "Case", variant_sku: "KLR-CASE", quantity: 1, unit_price: 150 }]);
        const edit = await orders.createOrderChange({ order_id: o.id, change_type: "edit" });
        await orders.addOrderAction([
          {
            order_change_id: edit.id,
            order_id: o.id,
            version: edit.version,
            action: "ITEM_ADD",
            details: { reference_id: added.id, quantity: 1, unit_price: 150 },
          },
          {
            order_change_id: edit.id,
            order_id: o.id,
            version: edit.version,
            action: "ITEM_UPDATE",
            details: { reference_id: o.lines[1], quantity: 4, unit_price: 999 },
          },
        ]);
        await orders.confirmOrderChange(edit.id);
        await reserved("order edit");

        // 6. A promotion refresh that resets the current adjustments.
        await orders.setOrderLineItemAdjustments(o.id, []);
        // (It writes no new version, so the order is not re-served for it.)
        const after = await drain("orders");
        expect(amounts(after.seen[0])).toBe(amounts(first));

        // Medusa's own view has moved: more lines, other totals.
        const now = await orders.retrieveOrder(o.id, { relations: ["items"] });
        expect(now.items.length).toBeGreaterThan(2);

        // A backfill from the very start gives the same record.
        const backfill = (await drain("orders", null, 1)).seen.find((r) => r.id === o.id)!;
        expect(amounts(backfill)).toBe(amounts(first));
        expect(Number(backfill.version)).toBe(Number(last.version));
      });

      it("serves a line and shipping that were tax-inclusive at 7 % at what the customer paid", async () => {
        const orders = resolve(Modules.ORDER);
        const created = await orders.createOrders({
          currency_code: "thb",
          email: "secret.person@example.test",
          shipping_address: ADDRESS,
          items: [
            {
              title: "Klear Frame",
              variant_sku: "KLR-F1",
              quantity: 1,
              unit_price: 1290,
              is_tax_inclusive: true,
              tax_lines: [{ code: "VAT", rate: 7, description: "VAT" }],
            },
          ],
          shipping_methods: [
            { name: "Flash Express", amount: 50, is_tax_inclusive: true, tax_lines: [{ code: "VAT", rate: 7, description: "VAT" }] },
          ],
        });
        await age("order", [created.id], 600);
        const { rows } = await pg().raw(
          `select t."rate"::text as rate from "order_line_item_tax_line" t
             join "order_item" oi on oi."item_id" = t."item_id" where oi."order_id" = ?`,
          [created.id],
        );
        expect(rows.map((r: { rate: string }) => Number(r.rate))).toEqual([7]);
        const res = await get("/ops-feed/orders");
        expect(res.status).toBe(200);
        expect(res.data.orders[0]).toMatchObject({
          item_total_satang: 129000,
          shipping_total_satang: 5000,
          total_satang: 134000,
          lines: [{ gross_satang: 129000, discount_satang: 0 }],
        });
      });

      it("refuses tax charged on top of a price, naming only the order, and still serves nothing wrong", async () => {
        const orders = resolve(Modules.ORDER);
        const created = await orders.createOrders({
          currency_code: "thb",
          items: [
            { title: "F", quantity: 1, unit_price: 100, is_tax_inclusive: false, tax_lines: [{ code: "VAT", rate: 7 }] },
          ],
        });
        await age("order", [created.id], 600);
        const logged = jest.spyOn(console, "error").mockImplementation(() => undefined);
        try {
          const res = await get("/ops-feed/orders");
          expect(res.status).toBe(500);
          expect(JSON.stringify(res.data)).not.toContain(created.id);
          expect(JSON.stringify(logged.mock.calls)).toContain(created.id);
        } finally {
          logged.mockRestore();
        }
      });

      it("pages in (updated time, id) order, skipping and repeating nothing, also among orders that share a time", async () => {
        const made: string[] = [];
        for (let i = 0; i < 7; i++) made.push((await order()).id);
        // Four share one instant; the others are a second apart around it.
        await age("order", made.slice(0, 4), 600);
        await age("order", [made[4]], 601);
        await age("order", [made[5]], 599);
        await age("order", [made[6]], 598);
        const { rows } = await pg().raw(`select "id" from "order" order by "updated_at", "id"`);
        const expected = rows.map((r: { id: string }) => r.id);

        for (const limit of [1, 2, 3, 7, 50]) {
          const { seen, last } = await drain("orders", null, limit);
          expect([limit, seen.map((r) => r.id)]).toEqual([limit, expected]);
          expect(last.polled_through).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/));
        }
        // From a cursor in the middle of the shared instant: exactly the rest.
        const two = await get("/ops-feed/orders?limit=2");
        expect(two.data.has_more).toBe(true);
        expect(two.data.polled_through).toBeNull();
        const rest = await drain("orders", two.data.next_after, 2);
        expect(rest.seen.map((r) => r.id)).toEqual(expected.slice(2));
        // Nothing new: the cursor stays where it was.
        const after = await get(`/ops-feed/orders?after=${encodeURIComponent(rest.cursor!)}`);
        expect(after.data).toMatchObject({ orders: [], next_after: rest.cursor, has_more: false });
      });

      it("serves an order again, with its cancelled date, when it is cancelled after it was served", async () => {
        const o = await order();
        await age("order", [o.id], 600);
        const first = await drain("orders");
        expect(first.seen.map((r) => r.canceled_at)).toEqual([null]);
        const before = await updatedAt("order", o.id);

        await resolve(Modules.ORDER).cancel(o.id);
        // Medusa moved the order's updated time itself.
        const moved = await updatedAt("order", o.id);
        expect(moved > before).toBe(true);
        // Held back while it is fresh, then served again past the cursor.
        expect((await drain("orders", first.cursor)).seen).toEqual([]);
        await age("order", [o.id], 61);
        const again = await drain("orders", first.cursor);
        expect(again.seen.map((r) => r.id)).toEqual([o.id]);
        expect(again.seen[0].canceled_at).toEqual(expect.stringMatching(/^\d{4}-.*Z$/));
        // The lines are what they were: frozen content does not change.
        expect(again.seen[0].lines).toEqual(first.seen[0].lines);
      });

      it("re-reads from a moment when given a time and no id", async () => {
        const o = await order();
        await age("order", [o.id], 600);
        const { seen } = await drain("orders");
        const at = String(seen[0].updated_at);
        expect((await drain("orders", `${at}|`)).seen.map((r) => r.id)).toEqual([o.id]);
        expect((await drain("orders", `${at}|${o.id}`)).seen).toEqual([]);
      });

      it("does not serve a draft order", async () => {
        const o = await order();
        await pg().raw(`update "order" set "is_draft_order" = true, "status" = 'draft' where "id" = ?`, [o.id]);
        await age("order", [o.id], 600);
        expect((await drain("orders")).seen).toEqual([]);
      });

      it("refuses a field list and a bad cursor", async () => {
        expect((await get("/ops-feed/orders?fields=*shipping_address")).status).toBe(400);
        expect((await get("/ops-feed/orders?after=yesterday")).status).toBe(400);
      });
    });

    describe("the fulfillments stream", () => {
      it("serves a fulfillment of an order with its lines and quoted cost, and no tracking or address", async () => {
        const o = await order();
        const f = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]);
        // A return's inbound fulfillment belongs to no order and ships nothing.
        const inbound = await fulfillment(null, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]);
        await age("fulfillment", [f, inbound], 600);
        const { seen, bodies } = await drain("fulfillments");
        expect(seen).toEqual([
          {
            id: f,
            order_id: o.id,
            created_at: expect.stringMatching(/^\d{4}-.*\.\d{6}Z$/),
            kind: "original",
            quoted_shipping_satang: 4550,
            canceled_at: null,
            delivered_at: null,
            updated_at: await updatedAt("fulfillment", f),
            lines: [{ line_item_id: o.lines[0], sku: "KLR-F1", quantity: 1 }],
          },
        ]);
        expect(leaks(bodies)).toEqual([]);
      });

      it("serves a fulfillment again when it is delivered, and again when another is cancelled", async () => {
        const o = await order();
        const delivered = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]);
        const cancelled = await fulfillment(o.id, [{ line_item_id: o.lines[1], sku: "KLR-LENS-SV167" }]);
        await age("fulfillment", [delivered, cancelled], 600);
        const first = await drain("fulfillments");
        expect(first.seen).toHaveLength(2);

        const fulfillments = resolve(Modules.FULFILLMENT);
        const b1 = await updatedAt("fulfillment", delivered);
        await fulfillments.updateFulfillment(delivered, { delivered_at: new Date() });
        expect((await updatedAt("fulfillment", delivered)) > b1).toBe(true);
        const b2 = await updatedAt("fulfillment", cancelled);
        await fulfillments.cancelFulfillment(cancelled);
        expect((await updatedAt("fulfillment", cancelled)) > b2).toBe(true);

        await age("fulfillment", [delivered, cancelled], 61);
        const again = await drain("fulfillments", first.cursor);
        const byId = new Map(again.seen.map((r) => [r.id, r]));
        expect([...byId.keys()].sort()).toEqual([delivered, cancelled].sort());
        expect(byId.get(delivered)).toMatchObject({ delivered_at: expect.any(String), canceled_at: null });
        expect(byId.get(cancelled)).toMatchObject({ canceled_at: expect.any(String), delivered_at: null });
      });

      it("calls a fulfillment that ships a claim's or an exchange's item a replacement, and leaves the original as it was", async () => {
        const orders = resolve(Modules.ORDER);
        const actionsAgo = async (orderId: string, seconds: number) =>
          pg().raw(
            `update "order_change_action" set "created_at" = now() - (? * interval '1 second') where "order_id" = ?`,
            [seconds, orderId],
          );
        const linesOf = async (orderId: string) =>
          (await orders.retrieveOrder(orderId, { relations: ["items"] })).items.map((i: { id: string }) => i.id);

        // A claim through Medusa's order module (the same bundled action the
        // claim workflows confirm): the frame is replaced by the same line
        // again and by a new line.
        const o = await order();
        const shippedFirst = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]);
        await orders.registerFulfillment({ order_id: o.id, items: [{ id: o.lines[0], quantity: 1 }] });
        await age("fulfillment", [shippedFirst], 1800);
        await orders.createClaim({
          order_id: o.id,
          type: "replace",
          claim_items: [{ id: o.lines[0], quantity: 1, reason: "production_failure" }],
          additional_items: [
            { id: o.lines[0], quantity: 1 },
            { title: "Replacement Frame", variant_sku: "KLR-F1", quantity: 1, unit_price: 0 },
          ],
        });
        await actionsAgo(o.id, 1200);
        const newLine = (await linesOf(o.id)).find((id: string) => !o.lines.includes(id))!;
        expect(newLine).toBeDefined();
        const sameLineAgain = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]);
        const newItem = await fulfillment(o.id, [{ line_item_id: newLine, sku: "KLR-F1" }]);
        const lens = await fulfillment(o.id, [{ line_item_id: o.lines[1], sku: "KLR-LENS-SV167" }]);

        // An exchange through the same module.
        const x = await order();
        await orders.registerFulfillment({ order_id: x.id, items: [{ id: x.lines[0], quantity: 1 }] });
        await orders.createExchange({
          order_id: x.id,
          additional_items: [{ title: "Exchanged Frame", variant_sku: "KLR-F2", quantity: 1, unit_price: 1290 }],
          return_items: [{ id: x.lines[0], quantity: 1 }],
          // The module's exchange needs a return shipping method.
          return_shipping: { name: "Return", amount: 0 },
        });
        await actionsAgo(x.id, 1200);
        const exchangedLine = (await linesOf(x.id)).find((id: string) => !x.lines.includes(id))!;
        expect(exchangedLine).toBeDefined();
        const exchanged = await fulfillment(x.id, [{ line_item_id: exchangedLine, sku: "KLR-F2" }]);

        await age("fulfillment", [sameLineAgain, newItem, lens, exchanged], 600);
        const kinds = new Map((await drain("fulfillments")).seen.map((r) => [r.id, r.kind]));
        expect({
          shippedFirst: kinds.get(shippedFirst),
          sameLineAgain: kinds.get(sameLineAgain),
          newItem: kinds.get(newItem),
          lens: kinds.get(lens),
          exchanged: kinds.get(exchanged),
        }).toEqual({
          // Shipped before the claim: still the original sale.
          shippedFirst: "original",
          sameLineAgain: "replacement",
          newItem: "replacement",
          lens: "original",
          exchanged: "replacement",
        });
      });

      it("pages fulfillments that share a time without skipping or repeating", async () => {
        const o = await order();
        const made: string[] = [];
        for (let i = 0; i < 5; i++) made.push(await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1" }]));
        await age("fulfillment", made, 600);
        const { rows } = await pg().raw(
          `select f."id" from "fulfillment" f order by f."updated_at", f."id"`,
        );
        for (const limit of [1, 2, 4]) {
          expect((await drain("fulfillments", null, limit)).seen.map((r) => r.id)).toEqual(
            rows.map((r: { id: string }) => r.id),
          );
        }
      });
    });

    describe("the frame stock comparison (report-only)", () => {
      const inventoryOf = () => resolve(Modules.INVENTORY);
      async function frameItem(sku: string, stocked: number): Promise<string> {
        const item = await inventoryOf().createInventoryItems({ sku });
        await inventoryOf().createInventoryLevels({
          inventory_item_id: item.id,
          location_id: "sloc_test",
          stocked_quantity: stocked,
        });
        return item.id as string;
      }
      async function ask(watermark: string | null, frames: Array<{ inventory_item_id: string; on_hand: number }>) {
        const res = await post("/ops-sync/frame-stock", { watermark, frames }, SYNC);
        expect(res.status).toBe(200);
        expect(res.data.mode).toBe("report_only");
        return res.data.frames as Array<Record<string, unknown>>;
      }
      const cursorOf = async (id: string) => `${await updatedAt("fulfillment", id)}|${id}`;

      it("reports a difference only once everything Medusa did is behind the watermark, and writes nothing", async () => {
        const item = await frameItem("KLR-F1", 10);
        const o = await order();
        const level = async () =>
          Number((await inventoryOf().listInventoryLevels({ inventory_item_id: item }))[0].stocked_quantity);

        // Nothing has shipped: settled, and the two agree at 10.
        expect(await ask(null, [{ inventory_item_id: item, on_hand: 10 }, { inventory_item_id: "iitem_none", on_hand: 1 }])).toEqual([
          { inventory_item_id: item, known: true, settled: true, medusa_stocked: 10, expected: 10, difference: 0, written: false },
          { inventory_item_id: "iitem_none", known: false, settled: false, medusa_stocked: null, expected: null, difference: null, written: false },
        ]);

        // Medusa ships one, as its workflow would: the fulfillment, the stock.
        const shipped = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1", inventory_item_id: item }]);
        await inventoryOf().adjustInventory(item, "sloc_test", -1);
        // Inside the hold-back, and after the ledger's watermark: no difference.
        expect((await ask(null, [{ inventory_item_id: item, on_hand: 10 }]))[0]).toMatchObject({
          settled: false,
          medusa_stocked: 9,
          expected: null,
          difference: null,
        });
        await age("fulfillment", [shipped], 600);
        expect((await ask(null, [{ inventory_item_id: item, on_hand: 10 }]))[0]).toMatchObject({ settled: false });
        // The ledger takes it in: its watermark passes it, its on-hand is 9.
        let { cursor } = await drain("fulfillments");
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 9 }]))[0]).toMatchObject({
          settled: true,
          expected: 9,
          difference: 0,
        });

        // A delivery scan updates the fulfillment: not settled until the
        // ledger has read it again, and never counted twice.
        await resolve(Modules.FULFILLMENT).updateFulfillment(shipped, { delivered_at: new Date() });
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 9 }]))[0]).toMatchObject({ settled: false });
        await age("fulfillment", [shipped], 300);
        ({ cursor } = await drain("fulfillments", cursor));
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 9 }]))[0]).toMatchObject({
          settled: true,
          difference: 0,
        });

        // A hand edit in Medusa Admin: a difference, reported and left alone.
        await inventoryOf().adjustInventory(item, "sloc_test", 3);
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 9 }]))[0]).toMatchObject({
          settled: true,
          medusa_stocked: 12,
          expected: 9,
          difference: 3,
        });
        expect(await level()).toBe(12);
      });

      it("the reviewer's case: a fulfillment made before the watermark's record but updated after it is not taken as read", async () => {
        const itemF = await frameItem("KLR-F1", 10);
        const itemX = await frameItem("KLR-F2", 10);
        const o = await order();
        // F is made first, X later.
        const f = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F1", inventory_item_id: itemF }]);
        await inventoryOf().adjustInventory(itemF, "sloc_test", -1);
        await age("fulfillment", [f], 900);
        const xf = await fulfillment(o.id, [{ line_item_id: o.lines[1], sku: "KLR-F2", inventory_item_id: itemX }]);
        await inventoryOf().adjustInventory(itemX, "sloc_test", -1);
        await age("fulfillment", [xf], 600);
        // F is updated after X, and is now past X in the feed's order.
        await resolve(Modules.FULFILLMENT).updateFulfillment(f, { delivered_at: new Date() });
        await age("fulfillment", [f], 300);
        // The ledger has read up to X. It has never been served F, so its
        // on-hand for F's frame is still 10.
        const watermark = await cursorOf(xf);
        const frames = await ask(watermark, [
          { inventory_item_id: itemF, on_hand: 10 },
          { inventory_item_id: itemX, on_hand: 9 },
        ]);
        expect(frames[0]).toMatchObject({ inventory_item_id: itemF, settled: false, expected: null, difference: null });
        expect(frames[1]).toMatchObject({ inventory_item_id: itemX, settled: true, expected: 9, difference: 0 });
      });

      it("holds a frame back while a new fulfillment is not yet linked to its order", async () => {
        const item = await frameItem("KLR-F3", 5);
        const o = await order();
        // Medusa takes the stock off before it links the fulfillment.
        const f = await fulfillment(null, [{ line_item_id: o.lines[0], sku: "KLR-F3", inventory_item_id: item }]);
        await inventoryOf().adjustInventory(item, "sloc_test", -1);
        expect((await ask(null, [{ inventory_item_id: item, on_hand: 5 }]))[0]).toMatchObject({
          settled: false,
          difference: null,
        });
        expect(f).toBeDefined();
      });

      it("settles again after a cancelled fulfillment has been read, with the frame back", async () => {
        const item = await frameItem("KLR-F4", 4);
        const o = await order();
        const f = await fulfillment(o.id, [{ line_item_id: o.lines[0], sku: "KLR-F4", inventory_item_id: item }]);
        await inventoryOf().adjustInventory(item, "sloc_test", -1);
        await age("fulfillment", [f], 600);
        let { cursor } = await drain("fulfillments");
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 3 }]))[0]).toMatchObject({ settled: true, difference: 0 });
        await resolve(Modules.FULFILLMENT).cancelFulfillment(f);
        await inventoryOf().adjustInventory(item, "sloc_test", 1);
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 3 }]))[0]).toMatchObject({ settled: false });
        await age("fulfillment", [f], 300);
        ({ cursor } = await drain("fulfillments", cursor));
        // The ledger reversed it: on-hand 4 again.
        expect((await ask(cursor, [{ inventory_item_id: item, on_hand: 4 }]))[0]).toMatchObject({
          settled: true,
          medusa_stocked: 4,
          expected: 4,
          difference: 0,
          written: false,
        });
      });
    });

    describe("the lens snapshot", () => {
      it("is stored for the lab, and an older one is refused", async () => {
        const first = await post(
          "/ops-sync/lens-stock",
          { as_of: "2026-11-15", lenses: [{ sku: "LENS-A", on_hand: 4 }, { sku: "LENS-B", on_hand: 0 }] },
          LENS,
        );
        expect(first.status).toBe(200);
        expect(first.data).toEqual({ as_of: "2026-11-15", stored: 2 });
        const older = await post("/ops-sync/lens-stock", { as_of: "2026-11-08", lenses: [{ sku: "LENS-A", on_hand: 9 }] }, LENS);
        expect(older.status).toBe(409);
        const { rows } = await pg().raw(`select "sku", "on_hand", "as_of" from "lens_stock_snapshot" order by "sku"`);
        expect(rows).toEqual([
          { sku: "LENS-A", on_hand: 4, as_of: "2026-11-15" },
          { sku: "LENS-B", on_hand: 0, as_of: "2026-11-15" },
        ]);
        expect((await post("/ops-sync/lens-stock", { as_of: "x", lenses: [] }, LENS)).status).toBe(400);
      });
    });
  },
});
