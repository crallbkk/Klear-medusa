import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { captureException } from "../../lib/observability/sentry";
import { errorKind } from "../admin/lab-jobs/production-http";
import { FeedValueError, parseCursor, parseLimit, type FeedCursor } from "./commerce";

/**
 * The query a commerce feed route accepts: `after` (a cursor) and `limit`,
 * and nothing else. Any other parameter is refused, so a caller cannot even
 * appear to ask for fields (contract 1, "Must never cross", item 4).
 * Returns null when it has already answered 400.
 */
export function feedQuery(
  req: MedusaRequest,
  res: MedusaResponse,
): { after: FeedCursor | null; limit: number } | null {
  const query = (req.query ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(query).filter((k) => k !== "after" && k !== "limit");
  if (unknown.length > 0) {
    res.status(400).json({ error: "only after and limit are accepted" });
    return null;
  }
  const after = parseCursor(query.after);
  if (after === "invalid") {
    res.status(400).json({ error: "after must be a cursor this feed returned: <UTC time>|<id>" });
    return null;
  }
  return { after, limit: parseLimit(query.limit) };
}

/**
 * Any failure while serving an Operations route (a feed page or a stock
 * sync call). A database error's text holds the SQL and its values, so
 * only its kind (class, code, type) is logged and reported, and the caller
 * gets a fixed sentence. For a feed, the cursor did not move; the poller
 * tries again on its next run.
 */
export function answerFeedFailure(res: MedusaResponse, where: string, err: unknown): void {
  // Our own value errors name a field and hold no value; anything else is
  // reported by its kind only.
  // The record's Medusa id (and nothing else of it) says which one stops
  // the stream, so someone can look at it in Medusa.
  const value = err instanceof FeedValueError ? err : null;
  const kind = value ? `FeedValueError (${value.message})` : errorKind(err);
  console.error(`[${where}] failed: ${kind}`);
  captureException(new Error(`${where} failed: ${kind}`), {
    tags: { route: where },
    ...(value?.record_id ? { extra: { record_id: value.record_id } } : {}),
  });
  res.status(500).json({ error: "the request could not be completed; try again" });
}
