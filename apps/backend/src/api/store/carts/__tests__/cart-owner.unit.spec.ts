import { attachCartBeforeEmail, guestCustomerFor, ownerForEmail, signedInCustomerId } from "../cart-owner";
import middlewares from "../../../middlewares";

type Row = { id: string; email: string | null; has_account: boolean };

/** A tiny customer module: rows in memory, with the (email, has_account) uniqueness the database has. */
function customerModule(rows: Row[], opts: { raceOnCreate?: Row } = {}) {
  let n = 0;
  const listCustomers = jest.fn(async (f: { id?: string; email?: string; has_account?: boolean }) =>
    rows.filter(
      (r) =>
        (f.id === undefined || r.id === f.id) &&
        (f.email === undefined || r.email === f.email) &&
        (f.has_account === undefined || r.has_account === f.has_account),
    ),
  );
  const createCustomers = jest.fn(async ({ email }: { email: string }) => {
    if (opts.raceOnCreate) {
      // Another request made the guest a moment ago.
      rows.push(opts.raceOnCreate);
      throw new Error("Customer with email already exists");
    }
    const made = { id: `cus_new${++n}`, email, has_account: false };
    rows.push(made);
    return made;
  });
  return { listCustomers, createCustomers };
}

function scopeWith(services: Record<string, unknown>) {
  return { resolve: (k: string) => services[k] } as never;
}

describe("signedInCustomerId", () => {
  it("is the customer's id only for a signed-in customer", () => {
    expect(signedInCustomerId({ auth_context: { actor_id: "cus_me", actor_type: "customer" } })).toBe("cus_me");
    expect(signedInCustomerId({})).toBeUndefined();
    expect(signedInCustomerId({ auth_context: { actor_id: "user_1", actor_type: "user" } })).toBeUndefined();
    // A registration token, before the customer exists, has an empty id.
    expect(signedInCustomerId({ auth_context: { actor_id: "", actor_type: "customer" } })).toBeUndefined();
  });
});

describe("ownerForEmail", () => {
  const me = { id: "cus_me", email: "me@example.test", has_account: true };

  it("gives the cart to the signed-in customer only for their own email, in any letter case", () => {
    expect(ownerForEmail("me@example.test", me)).toBe("signed-in");
    expect(ownerForEmail("ME@Example.test", me)).toBe("signed-in");
  });

  it("makes every other case a guest cart", () => {
    expect(ownerForEmail("other@example.test", me)).toBe("guest");
    expect(ownerForEmail("me@example.test", null)).toBe("guest");
    expect(ownerForEmail("me@example.test", { ...me, has_account: false })).toBe("guest");
    expect(ownerForEmail("me@example.test", { ...me, email: null })).toBe("guest");
  });
});

describe("guestCustomerFor", () => {
  it("reuses the guest an email already has, never the account", async () => {
    const mod = customerModule([
      { id: "cus_account", email: "a@example.test", has_account: true },
      { id: "cus_guest", email: "a@example.test", has_account: false },
    ]);
    const got = await guestCustomerFor(scopeWith({ customer: mod }), "A@Example.test");
    expect(got.id).toBe("cus_guest");
    expect(mod.createCustomers).not.toHaveBeenCalled();
  });

  it("makes a guest, in lower case, when the email has only an account", async () => {
    const mod = customerModule([{ id: "cus_account", email: "a@example.test", has_account: true }]);
    const got = await guestCustomerFor(scopeWith({ customer: mod }), "A@Example.test");
    expect(got).toEqual({ id: "cus_new1", email: "a@example.test", has_account: false });
  });

  it("takes the guest another request made at the same moment", async () => {
    const mod = customerModule([], { raceOnCreate: { id: "cus_raced", email: "r@example.test", has_account: false } });
    expect((await guestCustomerFor(scopeWith({ customer: mod }), "r@example.test")).id).toBe("cus_raced");
  });

  it("passes on a failure to make the guest that was not a race", async () => {
    const mod = customerModule([]);
    mod.createCustomers.mockRejectedValueOnce(new Error("database down"));
    await expect(guestCustomerFor(scopeWith({ customer: mod }), "x@example.test")).rejects.toThrow("database down");
  });
});

describe("attachCartBeforeEmail", () => {
  const ROWS: Row[] = [
    { id: "cus_me", email: "me@example.test", has_account: true },
    { id: "cus_other", email: "other@example.test", has_account: true },
  ];

  async function run(opts: {
    cart?: { email?: string | null; customer_id?: string | null; completed_at?: unknown } | null;
    /** What the cart looks like when read again under the lock, if it changed meanwhile. */
    cartUnderLock?: { customer_id?: string | null };
    body?: Record<string, unknown>;
    actor?: string;
  }) {
    const cart = opts.cart === null ? undefined : { id: "cart_1", email: null, customer_id: null, ...opts.cart };
    const events: string[] = [];
    let locked = false;
    const graph = jest.fn(async () => {
      events.push(locked ? "read (locked)" : "read");
      const now = locked && cart && opts.cartUnderLock ? { ...cart, ...opts.cartUnderLock } : cart;
      return { data: now ? [now] : [] };
    });
    const updateCarts = jest.fn(async () => {
      events.push(locked ? "write (locked)" : "write");
      return [];
    });
    const execute = jest.fn(async (key: string, job: () => Promise<unknown>, _args?: unknown) => {
      events.push(`lock ${key}`);
      locked = true;
      try {
        return await job();
      } finally {
        locked = false;
        events.push(`unlock ${key}`);
      }
    });
    const customers = customerModule(ROWS.map((r) => ({ ...r })));
    const next = jest.fn(() => events.push("next"));
    const req = {
      params: { id: "cart_1" },
      validatedBody: opts.body ?? {},
      auth_context: opts.actor ? { actor_id: opts.actor, actor_type: "customer" } : undefined,
      scope: scopeWith({ query: { graph }, customer: customers, cart: { updateCarts }, locking: { execute } }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await attachCartBeforeEmail(req as any, {} as any, next);
    expect(next).toHaveBeenCalledTimes(1);
    return { updateCarts, customers, events, execute };
  }

  it("reads the cart again and writes it only while holding the cart's lock, then lets Medusa go on", async () => {
    const { events } = await run({ body: { email: "other@example.test" } });
    expect(events).toEqual(["read", "lock cart_1", "read (locked)", "write (locked)", "unlock cart_1", "next"]);
  });

  it("leaves a cart that was attached between the first look and the lock", async () => {
    // A signed-in customer's attach (POST /store/carts/:id/customer) finished meanwhile.
    const { updateCarts, customers, events } = await run({
      body: { email: "other@example.test" },
      cartUnderLock: { customer_id: "cus_me" },
    });
    expect(updateCarts).not.toHaveBeenCalled();
    expect(customers.createCustomers).not.toHaveBeenCalled();
    expect(events).toEqual(["read", "lock cart_1", "read (locked)", "unlock cart_1", "next"]);
  });

  it("does not take the lock for an update it leaves alone", async () => {
    const { execute } = await run({ cart: { customer_id: "cus_me" }, body: { email: "other@example.test" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("gives a guest who types an account's email a guest customer", async () => {
    const { updateCarts } = await run({ body: { email: "other@example.test" } });
    expect(updateCarts).toHaveBeenCalledWith([{ id: "cart_1", customer_id: "cus_new1" }]);
  });

  it("gives a signed-in customer typing their own email the cart", async () => {
    const { updateCarts } = await run({ body: { email: "me@example.test" }, actor: "cus_me" });
    expect(updateCarts).toHaveBeenCalledWith([{ id: "cart_1", customer_id: "cus_me" }]);
  });

  it("gives a signed-in customer typing another account's email a guest customer", async () => {
    const { updateCarts } = await run({ body: { email: "other@example.test" }, actor: "cus_me" });
    expect(updateCarts).toHaveBeenCalledWith([{ id: "cart_1", customer_id: "cus_new1" }]);
  });

  it("leaves the cart alone when the body has no email, even if the cart has one (Medusa attaches nobody then)", async () => {
    const { updateCarts, customers, execute } = await run({ cart: { email: "other@example.test" }, body: {} });
    expect(updateCarts).not.toHaveBeenCalled();
    expect(customers.createCustomers).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("treats an email of null in the body as the cart's own email, as Medusa does", async () => {
    // Medusa: the email is `body.email ?? cart.email`, and a body email of
    // null still counts as "an email was sent", so Medusa attaches a customer.
    const { updateCarts } = await run({ cart: { email: "other@example.test" }, body: { email: null } });
    expect(updateCarts).toHaveBeenCalledWith([{ id: "cart_1", customer_id: "cus_new1" }]);
  });

  it("holds the cart's lock for at most 5 seconds, as long as Medusa's cart workflows wait", async () => {
    const { execute } = await run({ body: { email: "other@example.test" } });
    expect(execute).toHaveBeenCalledWith("cart_1", expect.any(Function), { timeout: 5 });
  });

  it("leaves to Medusa carts that already have a customer, completed carts, missing carts and no email", async () => {
    for (const opts of [
      { cart: { customer_id: "cus_me" }, body: { email: "other@example.test" } },
      { cart: { completed_at: new Date() }, body: { email: "other@example.test" } },
      { cart: null, body: { email: "other@example.test" } },
      { body: {} },
      { body: { email: null } },
    ]) {
      const { updateCarts, customers } = await run(opts);
      expect([opts, updateCarts.mock.calls.length]).toEqual([opts, 0]);
      expect(customers.createCustomers).not.toHaveBeenCalled();
    }
  });

  it("is mounted on the cart update route, for POST, and on nothing wider", () => {
    const entries = (middlewares.routes ?? []).filter((r) =>
      (r.middlewares ?? []).includes(attachCartBeforeEmail as never),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].matcher).toBe("/store/carts/:id");
    expect(entries[0].methods).toEqual(["POST"]);
  });
});
