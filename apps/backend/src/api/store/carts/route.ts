// `POST /store/carts`: the project's own handler, in place of Medusa's.
//
// KEEP IN STEP WITH MEDUSA: this is a copy of Medusa's handler
// (`@medusajs/medusa/dist/api/store/carts/route.js`), and a unit test pins
// that file's hash (`__tests__/medusa-pins.unit.spec.ts`). When the test
// says Medusa's create-cart handler changed: compare it with this file,
// carry over any change, then update the hash in the test.
//
// It is Medusa's handler with one change: who the new cart belongs to (see
// `cart-owner.ts`). Medusa gives the cart to the signed-in customer if there
// is one, and so does this. With nobody signed in and an email given, Medusa
// would look up any customer with that email and attach the cart to their
// account; this hands Medusa a guest customer for that email instead.
//
// Medusa's own checks for this route (body and query checks, publishable key
// and sales channel) still run before this handler: they are attached to the
// path, not to the handler.

import { createCartWorkflow } from "@medusajs/core-flows";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { AdditionalData, CreateCartWorkflowInputDTO, HttpTypes } from "@medusajs/framework/types";
import { refetchCart } from "@medusajs/medusa/api/store/carts/helpers";
import { guestCustomerFor, signedInCustomerId } from "./cart-owner";

export const POST = async (
  req: MedusaRequest<HttpTypes.StoreCreateCart & AdditionalData, HttpTypes.SelectParams>,
  res: MedusaResponse<HttpTypes.StoreCartResponse>,
): Promise<void> => {
  const email = req.validatedBody.email;
  // Left as is, on purpose: if the workflow below then fails, a guest
  // customer made here for this email stays behind (Medusa's own step would
  // delete the one it made). That is harmless: a guest customer has no
  // account and nothing to sign in to, and the next cart with this email
  // reuses it. Deleting it is not safe for certain: in the same moment
  // another request may have found this guest and attached its cart to it,
  // and that cart would then point at a deleted customer.
  const customerId =
    signedInCustomerId(req) ?? (email ? (await guestCustomerFor(req.scope, email)).id : undefined);

  // The checked body is passed on as Medusa's own handler passes it; its
  // types allow `null` where the workflow's types say "absent", as in Medusa.
  const input = { ...req.validatedBody, customer_id: customerId } as CreateCartWorkflowInputDTO;
  const { result } = await createCartWorkflow(req.scope).run({ input });
  const cart = await refetchCart(result.id, req.scope, req.queryConfig.fields);
  res.status(200).json({ cart });
};
