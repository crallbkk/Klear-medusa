// A lab account can use the lab screens and nothing else in Medusa Admin.
//
// Why this exists and is not Medusa's role module: that module checks only
// routes that declare a permission. A route that declares none (and several
// of Medusa's own do not) is open to any signed-in admin user, so it cannot
// promise "a lab login is refused everywhere else". This check sits in front
// of every admin route and refuses by default.
//
// Who is a lab account: a user whose `metadata.klear_role` is "lab". It is
// read from the database for the signed-in user on every request (kept for
// a few seconds), not from the sign-in token, so marking an account confines
// it at once: a session opened before the mark is confined too. It is on
// the USER, so it holds for every way that user can sign in. No admin route
// a lab account can reach changes a user, so a lab account cannot lift
// itself out. Set and cleared by `src/scripts/lab-account.ts`.
//
// An account without the mark is not touched by this file: it is an owner
// or ops account, exactly as before. A secret API key is not a user and is
// not touched either; a key is full access and is not for the lab.

import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { Modules } from "@medusajs/framework/utils";

export const LAB_ROLE = "lab";

/**
 * Everything a lab account may call under /admin. Method and path, the
 * path with `:id` for one segment. Nothing else is reachable.
 *
 * Two groups. The lab's own work: the queue, a job, its history, its
 * packet (every look recorded), the lab's steps, the reports. And what the
 * admin page itself asks for before it shows anything: who is signed in,
 * and which features are on. Not here on purpose: hold and release, a
 * changed prescription, a rebuild and a warranty remake (ops), and every
 * order, customer, product, user, key and setting route.
 */
export const LAB_MAY_REACH: ReadonlyArray<readonly [method: string, path: string]> = [
  ["GET", "/admin/lab-queue"],
  ["GET", "/admin/lab-reports"],
  ["GET", "/admin/lab-jobs"],
  ["GET", "/admin/lab-jobs/:id"],
  ["GET", "/admin/lab-jobs/:id/production"],
  ["POST", "/admin/lab-jobs/:id/packet"],
  ["POST", "/admin/lab-jobs/:id/actions"],
  ["GET", "/admin/users/me"],
  ["GET", "/admin/feature-flags"],
];

/**
 * Admin routes Medusa serves WITHOUT its sign-in check. This check runs
 * after that one and knows a lab account by its sign-in, so on these it
 * sees nobody and lets the request through, as it does for a stranger.
 * The tests fail if Medusa ever adds another.
 *
 *   feature-flags   which features are on; public by design
 *   invites/accept  takes an invite's secret token. A lab account cannot
 *                   create or read an invite (both refused above), so it
 *                   has no token to present.
 */
export const SERVED_WITHOUT_SIGN_IN: ReadonlyArray<readonly [method: string, path: string]> = [
  ["GET", "/admin/feature-flags"],
  ["POST", "/admin/invites/accept"],
];

/**
 * Two things Medusa's admin page asks for before it draws anything, and
 * treats a refusal of as a crash: the store's settings and the
 * notification feed. A lab account is not given either. It is answered
 * here with fixed, empty content, so the page opens and nothing of the
 * store reaches it: the real routes never run.
 */
export const ANSWERED_FOR_THE_PAGE: ReadonlyArray<
  readonly [method: string, path: string, body: Record<string, unknown>]
> = [
  [
    "GET",
    "/admin/stores",
    {
      stores: [{ id: "store_lab", name: "Klear lab", supported_currencies: [], metadata: null }],
      count: 1,
      offset: 0,
      limit: 1,
    },
  ],
  ["GET", "/admin/notifications", { notifications: [], count: 0, offset: 0, limit: 0 }],
];

const toPattern = (path: string): RegExp =>
  new RegExp(
    "^" +
      path
        .split("/")
        .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") +
      "$",
  );

const ALLOWED = LAB_MAY_REACH.map(([method, path]) => ({ method, pattern: toPattern(path) }));
const ANSWERED = ANSWERED_FOR_THE_PAGE.map(([method, path, body]) => ({
  method,
  pattern: toPattern(path),
  body,
}));

/** The path of a request as this file judges it, or null if it is written
 *  in a way the router might read differently (see `labMayReach`). */
function plainPath(url: string): string | null {
  const path = url.split("?")[0].split("#")[0];
  if (/%|\/\/|\/\.\.?(\/|$)|\\/.test(path)) return null;
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** The fixed answer given to a lab account for this request, if it is one
 *  of the two the admin page needs. */
export function answeredForThePage(method: string, url: string): Record<string, unknown> | null {
  const path = plainPath(url);
  if (path === null || method.toUpperCase() !== "GET") return null;
  return ANSWERED.find((a) => a.pattern.test(path))?.body ?? null;
}

/**
 * May a lab account make this request? The path is taken as sent, without
 * its query string. Anything odd about it (an encoded slash or dot, a
 * doubled slash, a dot segment) is refused, not normalised: a path the
 * router might read differently from this check is not one to guess at.
 */
export function labMayReach(method: string, url: string): boolean {
  const trimmed = plainPath(url);
  if (trimmed === null) return false;
  const verb = method.toUpperCase();
  // HEAD is answered by the GET handler.
  const asked = verb === "HEAD" ? "GET" : verb;
  return ALLOWED.some((a) => a.method === asked && a.pattern.test(trimmed));
}

// How long an answer to "is this user a lab account?" is kept. Short: a
// mark set from another process (the script) is felt within this time.
const MARK_KEPT_MS = 5_000;
const marks = new Map<string, { lab: boolean; at: number }>();

/** Forget what is remembered about who is a lab account (all, or one
 *  user). Called when a mark is changed in this process, and by tests. */
export function forgetLabMarks(userId?: string): void {
  if (userId) marks.delete(userId);
  else marks.clear();
}

/**
 * Is the signed-in caller a lab account? Asked of the database. Throws if
 * it cannot be answered (the database is down, the user is gone): the
 * caller then refuses, because an unanswered question is not a "no".
 */
async function lookUpLabMark(req: MedusaRequest): Promise<boolean> {
  const auth = (req as { auth_context?: { actor_id?: string; actor_type?: string } }).auth_context;
  // Not signed in (Medusa answers 401), or a key, which is not a user.
  if (!auth?.actor_id || auth.actor_type !== "user") return false;
  const kept = marks.get(auth.actor_id);
  if (kept && Date.now() - kept.at < MARK_KEPT_MS) return kept.lab;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const users = req.scope.resolve(Modules.USER) as any;
  const user = (await users.retrieveUser(auth.actor_id, { select: ["id", "metadata"] })) as {
    metadata?: Record<string, unknown> | null;
  };
  const lab = user?.metadata?.klear_role === LAB_ROLE;
  if (marks.size > 500) marks.clear();
  marks.set(auth.actor_id, { lab, at: Date.now() });
  return lab;
}

/** Was this request found to come from a lab account? True only after
 *  `confineLabAccounts` has run for it, which it has on every admin route. */
export function isLabAccount(req: MedusaRequest): boolean {
  return (req as { klear_lab_account?: boolean }).klear_lab_account === true;
}

/**
 * Mounted on every admin route (`/admin*` in `api/middlewares.ts`), after
 * Medusa's own sign-in check. A lab account is answered 403 unless the
 * request is in `LAB_MAY_REACH`. Everyone else passes through untouched.
 */
export async function confineLabAccounts(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  let lab: boolean;
  try {
    lab = await lookUpLabMark(req);
  } catch {
    res.status(503).json({
      type: "unexpected_state",
      message: "this account could not be checked; try again",
    });
    return;
  }
  if (!lab) {
    next();
    return;
  }
  (req as { klear_lab_account?: boolean }).klear_lab_account = true;
  const url = (req as { originalUrl?: string }).originalUrl ?? req.url ?? "";
  if (labMayReach(req.method, url)) {
    next();
    return;
  }
  const canned = answeredForThePage(req.method, url);
  if (canned) {
    res.json(canned);
    return;
  }
  res.status(403).json({
    type: "not_allowed",
    message: "this account can only use the lab screens",
  });
}
