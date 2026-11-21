import { defineMiddlewares } from "@medusajs/framework/http";
import { sentryErrorHandler } from "../lib/observability/http-error-handler";
import { requirePackedBeforeLabel } from "./admin/orders/require-packed";
import { LAB_ACT, LAB_OPS, LAB_READ } from "./admin/lab-jobs/production-http";

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
    // The lab's routes and the permission each needs. Medusa enforces
    // `policies` only when its role module is on (MEDUSA_FF_RBAC); see
    // `admin/lab-jobs/production-http.ts`.
    { matcher: "/admin/lab-queue", methods: ["GET"], policies: [LAB_READ] },
    { matcher: "/admin/lab-reports", methods: ["GET"], policies: [LAB_READ] },
    { matcher: "/admin/lab-jobs", methods: ["GET"], policies: [LAB_READ] },
    { matcher: "/admin/lab-jobs/:id", methods: ["GET"], policies: [LAB_READ] },
    { matcher: "/admin/lab-jobs/:id/production", methods: ["GET"], policies: [LAB_READ] },
    { matcher: "/admin/lab-jobs/:id/packet", methods: ["POST"], policies: [LAB_READ] },
    { matcher: "/admin/lab-jobs/:id/actions", methods: ["POST"], policies: [LAB_ACT] },
    { matcher: "/admin/lab-jobs/:id/ops-actions", methods: ["POST"], policies: [LAB_OPS] },
    { matcher: "/admin/lab-jobs/:id/rx-changed", methods: ["POST"], policies: [LAB_OPS] },
    { matcher: "/admin/lab-jobs/:id/retry", methods: ["POST"], policies: [LAB_OPS] },
  ],
});
