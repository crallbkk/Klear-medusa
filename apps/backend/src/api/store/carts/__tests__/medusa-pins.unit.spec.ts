// Pins the Medusa files the cart-owner rule (`../cart-owner.ts`,
// `../route.ts`) copies or leans on. A Medusa upgrade that changes one of
// them fails here, so someone reads the change before it ships, instead of
// the project silently keeping old behaviour or losing a guarantee.
//
// Each file is read as published, with Windows line endings turned into
// Unix ones so the hash is the same on every machine.

import { createHash } from "crypto";
import { readdirSync, readFileSync } from "fs";
import { dirname, join, relative, sep } from "path";

const medusaRoot = dirname(require.resolve("@medusajs/medusa/package.json"));
// core-flows does not publish its package.json; its entry point is dist/index.js.
const coreFlowsDist = dirname(require.resolve("@medusajs/core-flows"));

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex");
}

const PINS: { file: string; hash: string; protects: string; todo: string }[] = [
  {
    file: join(medusaRoot, "dist/api/store/carts/route.js"),
    hash: "920208e656d4cb5afe1861b905f9a95e45cfe37885c02e792a7ab777db0c9a40",
    protects: "src/api/store/carts/route.ts is a copy of this handler with one change (who the cart belongs to).",
    todo:
      "Medusa's create-cart handler changed. Compare it with src/api/store/carts/route.ts, carry over any change, then update this hash.",
  },
  {
    file: join(coreFlowsDist, "cart/steps/find-or-create-customer.js"),
    hash: "ffc6f7f5c415de32d149c6243e2a19209d857c083edd765709d4b4fcaf96111c",
    protects:
      "A cart that already has a customer keeps it: given a customer id, the step uses that customer and looks " +
      "nobody up by email (an account customer is kept whatever the email; a guest moves only to another guest). " +
      "The rule works by giving an unattached cart its customer before this step runs.",
    todo:
      "Medusa's find-or-create-customer step changed. Check that a cart with a customer still keeps it and that a " +
      "guest customer still moves only to another guest (see src/api/store/carts/cart-owner.ts and " +
      "integration-tests/http/store-cart-owner.spec.ts), then update this hash.",
  },
  {
    file: join(coreFlowsDist, "cart/workflows/update-cart.js"),
    hash: "7db35c93a35a327094965647d7883587b0a5f66bf0094c3307f3184b89294752",
    protects:
      "The update workflow passes the cart's own customer_id to the step, and puts the step's customer on the " +
      "cart only when the body has an email key, using `input.email ?? cart.email` (the middleware acts in " +
      "exactly that case, with the same email).",
    todo:
      "Medusa's update-cart workflow changed. Check how it now picks the cart's customer and email against " +
      "src/api/store/carts/cart-owner.ts, then update this hash.",
  },
  {
    file: join(coreFlowsDist, "cart/workflows/transfer-cart-customer.js"),
    hash: "5aeb068e9b9c04798c35b491d9b49499d46efbc9a2e4d7821d45e8b67f77f5f3",
    protects:
      "Attaching a cart to the signed-in customer (POST /store/carts/:id/customer) writes the customer while " +
      "holding the cart's lock (key: the cart id). The middleware takes the same lock so it never overwrites " +
      "an attach with a guest.",
    todo:
      "Medusa's transfer-cart-customer workflow changed. Check it still writes the customer under the lock keyed " +
      "by the cart id (see attachCartBeforeEmail in src/api/store/carts/cart-owner.ts), then update this hash.",
  },
  {
    file: join(coreFlowsDist, "cart/workflows/create-carts.js"),
    hash: "94899d2f4e2ab521200d4b11b39f4577cc379b8e41c3d97a5dbfaeef5c1ac18a",
    protects:
      "The create workflow passes input.customer_id to the find-or-create step and puts the step's customer on " +
      "the new cart. The override hands it a guest customer id for a caller who is not signed in.",
    todo:
      "Medusa's create-cart workflow changed. Check it still passes customer_id to the find-or-create step and " +
      "keeps the result (see src/api/store/carts/route.ts), then update this hash.",
  },
  {
    file: join(medusaRoot, "dist/api/store/carts/[id]/route.js"),
    hash: "ed97b69c3bb1b73ea7705691e9bfa308d4a441351747f9746c4b777d2cfaa780",
    protects:
      "The cart update handler reads the checked body from req.validatedBody and does no validation of its own. " +
      "If validation moved into the handler, the middleware would see no validatedBody, attach nothing, and the " +
      "original bug would return.",
    todo:
      "Medusa's cart update handler changed. Check it still reads req.validatedBody that a route middleware " +
      "filled before it (see attachCartBeforeEmail in src/api/store/carts/cart-owner.ts), then update this hash.",
  },
  {
    file: join(medusaRoot, "dist/api/store/carts/middlewares.js"),
    hash: "977ff3165044c3234ab5782c797068d278ce5ba730afd9e383394b39326540d7",
    protects:
      "Medusa validates the body of POST /store/carts and POST /store/carts/:id in route middlewares, which run " +
      "before the project's middleware and fill req.validatedBody.",
    todo:
      "Medusa's store cart middlewares changed. Check that both cart routes still validate the body in a route " +
      "middleware (see src/api/store/carts/cart-owner.ts and route.ts), then update this hash.",
  },
  {
    file: join(medusaRoot, "dist/api/store/orders/middlewares.js"),
    hash: "4c7017b0f0ba34ceee6afc214315d7ae0beb9e74447fa2c5594c4c256e034aa9",
    protects: "The store order routes and their checks are the ones the ownership checks were written against.",
    todo:
      "Medusa's store order middlewares changed. Check every store order route still answers only the order's " +
      "owner (see src/api/store/orders/own-order.ts and src/api/middlewares.ts), then update this hash.",
  },
  {
    file: join(medusaRoot, "dist/api/store/orders/[id]/route.js"),
    hash: "d1f6285ee7bab39dac43d1c25445314f0a1720118d00602715d04f677e1ff852",
    protects: "GET /store/orders/:id is the handler requireOrderOwner guards.",
    todo:
      "Medusa's single-order handler changed. Check requireOrderOwner in src/api/store/orders/own-order.ts still " +
      "guards it, then update this hash.",
  },
];

/** Every route file Medusa has under /store/orders, as paths relative to that folder. */
const STORE_ORDER_ROUTES = [
  "[id]/route.js",
  "[id]/transfer/accept/route.js",
  "[id]/transfer/cancel/route.js",
  "[id]/transfer/decline/route.js",
  "[id]/transfer/request/route.js",
  "route.js",
];

function routeFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full, base);
    return entry.name === "route.js" ? [relative(base, full).split(sep).join("/")] : [];
  });
}

describe("Medusa's store order routes are the ones the ownership checks cover", () => {
  it("has no store order route the project has not looked at", () => {
    const found = routeFiles(join(medusaRoot, "dist/api/store/orders")).sort();
    if (JSON.stringify(found) !== JSON.stringify(STORE_ORDER_ROUTES)) {
      throw new Error(
        "Medusa's store order routes changed. For each new route decide whether it must answer only the " +
          "order's owner (see src/api/store/orders/own-order.ts and src/api/middlewares.ts), then update " +
          `STORE_ORDER_ROUTES in this test.\nPinned: ${JSON.stringify(STORE_ORDER_ROUTES)}\nNow:    ${JSON.stringify(found)}`,
      );
    }
  });
});

describe("the Medusa files the cart-owner rule depends on are the ones it was checked against", () => {
  for (const pin of PINS) {
    it(`${pin.file.split(/[\\/]/).slice(-3).join("/")}: ${pin.protects}`, () => {
      const actual = sha256(pin.file);
      if (actual !== pin.hash) {
        throw new Error(`${pin.todo}\nFile: ${pin.file}\nPinned: ${pin.hash}\nNow:    ${actual}`);
      }
    });
  }
});
