import { errorHandler } from "@medusajs/framework/http";
import type {
  MedusaErrorHandlerFunction,
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http";
import { captureException } from "./sentry";

const coreErrorHandler = errorHandler();

/**
 * Medusa's own error handler, plus a Sentry report for every response it
 * answers with a 5xx.
 *
 * Without this, an error thrown inside a core route or workflow (cart
 * complete, order edit, an admin action) is only written to the Railway log:
 * Medusa catches it, so it never reaches Sentry as an unhandled error. 4xx
 * answers (validation, not found, conflicts) are the caller's problem and are
 * not reported.
 *
 * PDPA: only the method and the matched route pattern go to Sentry, never
 * the body, query or headers. The error itself still passes through the
 * scrubber in `sentry.ts`.
 */
export const sentryErrorHandler: MedusaErrorHandlerFunction = (
  err: unknown,
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) => {
  try {
    coreErrorHandler(err, req, res, next);
  } finally {
    try {
      if (res.statusCode >= 500) {
        captureException(err, {
          tags: {
            source: "http",
            method: String(req.method ?? ""),
            route: routePattern(req),
          },
        });
      }
    } catch {
      // Observability must never break the response.
    }
  }
};

/** The route pattern (`/store/carts/:id/complete`), not the concrete path:
 *  it groups events and carries no ids. */
function routePattern(req: MedusaRequest): string {
  const r = (req as { route?: { path?: unknown } }).route;
  if (r && typeof r.path === "string") return `${req.baseUrl ?? ""}${r.path}`;
  return "unmatched";
}
