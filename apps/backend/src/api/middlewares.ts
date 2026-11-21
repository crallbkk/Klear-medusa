import { defineMiddlewares } from "@medusajs/framework/http";
import { sentryErrorHandler } from "../lib/observability/http-error-handler";
import { requirePackedBeforeLabel } from "./admin/orders/require-packed";

/**
 * Custom HTTP config.
 *
 * - The Shippop webhook keeps its raw urlencoded body (`req.rawBody`), so
 *   nested fields such as `data[datetime]` / `data[reason]` reach the parser
 *   exactly as Shippop sent them (see `webhooks/shippop/raw-body.ts`).
 * - Every 5xx response is reported to Sentry before Medusa's own error
 *   handler answers (dormant until SENTRY_DSN is set).
 * - Booking a shipping label is refused while the order's lab job is not
 *   packed, when LMS_REQUIRE_PACKED_BEFORE_LABEL=true (see
 *   `admin/orders/require-packed.ts`).
 */
export default defineMiddlewares({
  errorHandler: sentryErrorHandler,
  routes: [
    {
      matcher: "/webhooks/shippop/*",
      methods: ["POST"],
      bodyParser: { preserveRawBody: true },
    },
    {
      matcher: "/admin/orders/:id/fulfillments",
      methods: ["POST"],
      middlewares: [requirePackedBeforeLabel],
    },
  ],
});
