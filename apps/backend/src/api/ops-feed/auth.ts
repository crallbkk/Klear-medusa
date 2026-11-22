import { createHash, timingSafeEqual } from "crypto";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";

/**
 * Authentication for the routes Klear Operations calls: the feed routes it
 * polls (`/ops-feed/*`) and the two stock sync routes it pushes to
 * (`/ops-sync/*`).
 *
 * Each has its own bearer secret, used for nothing else (design 13.4):
 *
 * 1. `KLEAR_OPS_FEED_SECRET`: read the feed streams. Read-only.
 * 2. `KLEAR_STOCK_SYNC_SECRET`: report frame on-hand to one route.
 * 3. `KLEAR_LENS_SNAPSHOT_SECRET`: send lens on-hand to one LMS route.
 *
 * None is a Medusa admin key, and none opens another's route, so the
 * read-only feed secret can never write the lens snapshot.
 *
 * Closed by default: with a secret unset (or too short to be a secret)
 * every request to its routes is refused, so a deploy that forgets the
 * variable exposes nothing.
 *
 * Returns true when the request may proceed; otherwise it has already
 * answered.
 */
const VARIABLES = ["KLEAR_OPS_FEED_SECRET", "KLEAR_STOCK_SYNC_SECRET", "KLEAR_LENS_SNAPSHOT_SECRET"] as const;
type SecretVariable = (typeof VARIABLES)[number];

// Trimmed: a trailing newline pasted into the variable would otherwise
// pass the length check and then match nothing.
const configured = (variable: SecretVariable) => (process.env[variable] ?? "").trim();
const digest = (s: string) => createHash("sha256").update(s).digest();

export function authorizeBearer(
  req: MedusaRequest,
  res: MedusaResponse,
  variable: SecretVariable,
): boolean {
  const secret = configured(variable);
  if (secret.length < 32) {
    res.status(503).json({ error: "feed not configured" });
    return false;
  }
  // Two variables holding the same value would make the read-only feed
  // secret a write secret (or the other way round). Refuse both routes
  // until they differ, rather than pick one. Digests, compared in constant
  // time; no value is logged or answered.
  const mine = digest(secret);
  for (const other of VARIABLES) {
    if (other === variable) continue;
    const theirs = configured(other);
    if (theirs.length >= 32 && timingSafeEqual(mine, digest(theirs))) {
      // The caller gets the same answer as for an unset secret; the reason
      // is for whoever reads the log, by variable name only.
      console.error(`[ops-auth] ${variable} and ${other} hold the same value; both are closed until they differ`);
      res.status(503).json({ error: "feed not configured" });
      return false;
    }
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

/** The feed routes' check (`KLEAR_OPS_FEED_SECRET`). */
export function authorizeOpsFeed(req: MedusaRequest, res: MedusaResponse): boolean {
  return authorizeBearer(req, res, "KLEAR_OPS_FEED_SECRET");
}
