// Who a cart, and so the order made from it, belongs to.
//
// The rule: a cart is attached to a customer who has an account ONLY when the
// caller is signed in as that customer. Anyone else who sets an email that
// belongs to an account gets a guest cart under that email: its customer is a
// guest customer (`has_account: false`) with that email, never the account.
//
// Why this is needed: when a cart has no customer yet and an email is set
// (creating the cart with an email, or setting the email at checkout),
// Medusa's `findOrCreateCustomerStep` looks up ANY customer with that email
// and, if the first one it finds has an account, attaches the cart to that
// account. It does not ask who is calling. So a guest who types someone
// else's email (by typo or on purpose) puts their order, with delivery name,
// address and phone, in that person's order list, and loses it themselves.
//
// The lookup by email happens only for a cart that has no customer yet. Once
// a cart has a customer, Medusa keeps an account customer whatever email is
// set, and moves a guest customer only to another GUEST customer. So it is
// enough to give an unattached cart its customer before Medusa looks:
//
// 1. `POST /store/carts` (create): Medusa attaches the cart to the signed-in
//    customer when there is one, which is right. With nobody signed in and an
//    email given, the project's own handler (`./route.ts`) hands Medusa a
//    guest customer for that email, so Medusa does not look one up.
// 2. `POST /store/carts/:id` (update): `attachCartBeforeEmail` below runs
//    after Medusa has checked the body and before Medusa's handler. For a cart
//    with no customer that is about to get an email, it attaches the cart to
//    the signed-in customer if the email is their own, otherwise to a guest
//    customer with that email. Medusa then keeps that customer.

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework";
import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules, validateEmail } from "@medusajs/framework/utils";

type CustomerRow = { id: string; email?: string | null; has_account?: boolean | null };

/**
 * The customer id the caller is signed in as, or undefined.
 *
 * A token made at registration, before the customer exists, carries an empty
 * id: that caller is treated as not signed in.
 */
export function signedInCustomerId(req: object): string | undefined {
  const auth = (req as { auth_context?: { actor_id?: string; actor_type?: string } }).auth_context;
  if (auth?.actor_type !== "customer") return undefined;
  return typeof auth.actor_id === "string" && auth.actor_id !== "" ? auth.actor_id : undefined;
}

/**
 * Which customer an unattached cart goes to when `email` is set on it.
 *
 * "signed-in" only when the caller is signed in to an account whose email is
 * this one. Every other caller, including a signed-in customer typing someone
 * else's email, gets a guest cart under that email: the same thing that
 * happens today when they type an address nobody has.
 */
export function ownerForEmail(email: string, signedIn: CustomerRow | null): "signed-in" | "guest" {
  if (!signedIn?.has_account || !signedIn.email) return "guest";
  return signedIn.email.toLowerCase() === email.toLowerCase() ? "signed-in" : "guest";
}

/**
 * The guest customer (`has_account: false`) for an email, found or made.
 *
 * The email is written the way Medusa writes it (lower case), so Medusa's own
 * later lookups find the same customer. The database allows one guest and
 * one account per email (unique on email + has_account), so two requests
 * that both try to make the guest cannot both succeed: the one that loses
 * takes the guest the other one made.
 */
export async function guestCustomerFor(scope: MedusaContainer, email: string): Promise<CustomerRow> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const customers = scope.resolve(Modules.CUSTOMER) as any;
  const normalized = validateEmail(email);
  const find = async (): Promise<CustomerRow | undefined> =>
    ((await customers.listCustomers({ email: normalized, has_account: false }, { take: 1 })) as CustomerRow[])[0];
  const found = await find();
  if (found) return found;
  try {
    return (await customers.createCustomers({ email: normalized })) as CustomerRow;
  } catch (err) {
    const raced = await find();
    if (raced) return raced;
    throw err;
  }
}

/**
 * Before Medusa's `POST /store/carts/:id`: gives a cart that has no customer
 * yet the right one, before Medusa would look one up by email.
 *
 * Runs after Medusa's body check, so `req.validatedBody` is the checked body.
 * It acts exactly when Medusa would attach a customer: when the body has an
 * `email` key (even `null`), using `body.email ?? cart.email`. A body with no
 * `email` key makes Medusa attach nobody (it looks a customer up but does not
 * put it on the cart), so this leaves such an update alone too. Carts that
 * already have a customer, completed carts and carts that do not exist are
 * left to Medusa untouched.
 *
 * The read and the write happen while holding the cart's lock, the same lock
 * (keyed by the cart id, through Medusa's locking module) that Medusa's cart
 * workflows hold while they write a cart. In particular Medusa's attach
 * (`POST /store/carts/:id/customer`) writes the signed-in customer under that
 * lock. Without it, an attach landing between this read ("no customer yet")
 * and this write would be overwritten with a guest, and the order would
 * never show in the customer's account. Under the lock, either the attach
 * has finished (this sees its customer and leaves the cart) or it has not
 * started writing (it writes after this, and the signed-in customer wins).
 *
 * Left as is, on purpose: if Medusa then refuses the rest of the request (a
 * shipping address in a country the region does not have, say: 400), the
 * cart stays attached to the guest customer without the new email. That is
 * harmless: a guest customer owns no account, and the next email update on
 * the cart, which checkout always sends again, sets the email and keeps or
 * moves the guest exactly as Medusa does for any guest cart. Checking every
 * reason Medusa might refuse the request before attaching would mean copying
 * Medusa's workflow here.
 */
export async function attachCartBeforeEmail(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const id = req.params?.id;
  const body = (req.validatedBody ?? {}) as { email?: string | null };
  if (typeof id !== "string" || id === "") return next();
  // No `email` key in the body: Medusa attaches no customer (see above).
  if (body.email === undefined) return next();

  // A first look without the lock, so the usual update (a cart that already
  // has a customer, or no email) costs one read and never waits.
  const first = await unattachedCartEmail(req, id, body);
  if (!first) return next();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locking = req.scope.resolve(Modules.LOCKING) as any;
  // `timeout: 5` bounds both the wait for the lock and how long the lock
  // lives, in the in-memory and the Redis provider alike. Without it the
  // Redis provider keeps the lock for a minute, so a process that died
  // inside the job (a deploy restart) would block the cart's own workflows
  // for that long. Medusa's cart workflows hold the same lock for 10 s.
  await locking.execute(id, async () => {
    // Read again under the lock: the cart may have been attached meanwhile.
    const email = await unattachedCartEmail(req, id, body);
    if (!email) return;

    const signedInId = signedInCustomerId(req);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customers = req.scope.resolve(Modules.CUSTOMER) as any;
    const signedIn: CustomerRow | null = signedInId
      ? (((await customers.listCustomers({ id: signedInId }, { take: 1 })) as CustomerRow[])[0] ?? null)
      : null;

    const customerId =
      ownerForEmail(email, signedIn) === "signed-in" && signedIn
        ? signedIn.id
        : (await guestCustomerFor(req.scope, email)).id;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const carts = req.scope.resolve(Modules.CART) as any;
    await carts.updateCarts([{ id, customer_id: customerId }]);
  }, { timeout: 5 });
  next();
}

/**
 * The email an unattached cart is about to get, or undefined when the cart
 * is missing, completed, already has a customer, or gets no email.
 */
async function unattachedCartEmail(
  req: MedusaRequest,
  id: string,
  body: { email?: string | null },
): Promise<string | undefined> {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: "cart",
    fields: ["id", "email", "customer_id", "completed_at"],
    filters: { id },
  });
  const cart = (data ?? [])[0] as
    | { id: string; email?: string | null; customer_id?: string | null; completed_at?: unknown }
    | undefined;
  if (!cart || cart.customer_id || cart.completed_at) return undefined;
  const email = body.email ?? cart.email;
  return typeof email === "string" && email !== "" ? email : undefined;
}
