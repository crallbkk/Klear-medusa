import { defineMiddlewares } from "@medusajs/framework/http";
import { sentryErrorHandler } from "../lib/observability/http-error-handler";
import { attachCartBeforeEmail } from "./store/carts/cart-owner";
import { refuseOrderTransfers, requireOrderOwner } from "./store/orders/own-order";

/**
 * Custom HTTP config.
 *
 * - The Shippop webhook keeps its raw urlencoded body (`req.rawBody`), so
 *   nested fields such as `data[datetime]` / `data[reason]` reach the parser
 *   exactly as Shippop sent them (see `webhooks/shippop/raw-body.ts`).
 * - Every 5xx response is reported to Sentry before Medusa's own error
 *   handler answers (dormant until SENTRY_DSN is set).
 * - `GET /store/orders/:id` answers only the order's owner (see
 *   `store/orders/own-order.ts`).
 * - A cart goes to an account only when its owner is the one signed in;
 *   anyone else typing that account's email gets a guest cart (see
 *   `store/carts/cart-owner.ts`).
 */
export default defineMiddlewares({
  errorHandler: sentryErrorHandler,
  routes: [
    // One order is shown only to the signed-in customer who owns it.
    // Medusa's own route shows it to anyone who has its id.
    { matcher: "/store/orders/:id", methods: ["GET"], middlewares: [requireOrderOwner] },
    // Medusa's order transfers hand the whole order to any signed-in
    // customer. The website does not use them; they are switched off.
    { matcher: "/store/orders/:id/transfer/*", middlewares: [refuseOrderTransfers] },
    // Setting an email on a cart that has no customer yet: give it its
    // customer first, so Medusa does not attach it to whichever account has
    // that email. Project middlewares run after Medusa's body check and
    // before Medusa's handler. Creating a cart is handled in
    // `store/carts/route.ts`.
    { matcher: "/store/carts/:id", methods: ["POST"], middlewares: [attachCartBeforeEmail] },
    {
      matcher: "/webhooks/shippop/*",
      methods: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
  ],
});
