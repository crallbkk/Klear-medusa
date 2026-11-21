import { createHash, timingSafeEqual } from "crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

/**
 * Authentication for the feed routes Klear Operations polls (`/ops-feed/*`).
 *
 * One bearer secret, `KLEAR_OPS_FEED_SECRET`, used for nothing else. It is
 * not a Medusa admin key: it opens these read-only routes and no others, and
 * these routes are written so that nothing personal can leave through them.
 *
 * Closed by default: with the secret unset (or too short to be a secret)
 * every request is refused, so a deploy that forgets the variable exposes
 * nothing.
 *
 * Returns true when the request may proceed; otherwise it has already
 * answered.
 */
export function authorizeOpsFeed(req: MedusaRequest, res: MedusaResponse): boolean {
  // Trimmed: a trailing newline pasted into the variable would otherwise
  // pass the length check and then match nothing.
  const secret = (process.env.KLEAR_OPS_FEED_SECRET ?? "").trim();
  if (secret.length < 32) {
    res.status(503).json({ error: "feed not configured" });
    return false;
  }
  const header = req.headers?.authorization;
  const given =
    typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  // Compare digests: equal length for timingSafeEqual whatever was sent,
  // and no early exit that would tell a caller how much it got right.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(secret).digest();
  if (given === "" || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}
