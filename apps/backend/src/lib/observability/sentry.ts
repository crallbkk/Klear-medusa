import * as Sentry from "@sentry/node";
import type { Breadcrumb, Event as SentryEvent } from "@sentry/node";

/**
 * Backend Sentry helpers — thin typed wrappers around `@sentry/node` with a
 * PDPA-critical scrubber baked into `beforeSend` / `beforeBreadcrumb`.
 *
 * WHY THIS MODULE IS SENSITIVE: this backend is the one place decrypted
 * prescriptions exist server-side (`modules/prescription/supabase-vault.ts` →
 * `decryptForLabHandoff` → the lab packet assembled in
 * `modules/lms/build-packet.ts`). A leaked Sentry event must NEVER contain
 * decrypted Rx values, ciphertext, secrets, or customer PII.
 *
 * The scrubber below is a BACKSTOP, not the primary defense: every call site
 * that uses `captureException`/`captureMessage` from this module must only
 * put opaque operational ids (order_id, lab_job_id, tracking_number, ...) —
 * never the `prescription` / `customer` / packet objects themselves — into
 * `extra`. See the wiring in shippop-tracking.ts, heal-pending-rx.ts,
 * build-packet.ts, order-placed.ts, and the lab-jobs retry route.
 *
 * Dormant-until-DSN: `initSentry()` is a no-op unless `SENTRY_DSN` is set, so
 * local dev and any un-provisioned Railway environment stay silent — same
 * convention as the Website repo's `src/lib/observability/sentry.ts` and the
 * H2/OCR "dormant until env set" pattern. Once uninitialized, `@sentry/node`'s
 * own capture functions are documented no-ops, and every export here also
 * wraps its body in try/catch so observability code can never break a caller.
 */

// ── Denylist ────────────────────────────────────────────────────────────
//
// Matched against OBJECT KEYS (not values) at every level of `extra`,
// `contexts`, `request` data, and breadcrumb `data`. A match replaces the
// entire value (redact whole subtrees, don't recurse into them) — e.g. a key
// named `prescription` drops the whole decrypted Rx object in one shot,
// rather than relying on every nested field (sph_right, cyl_left, ...) to
// individually match.
//
// Deliberately permissive (over-redaction is the safe failure mode for a
// backstop): `/key/i` also flags incidental words containing "key", `/name/i`
// with underscore boundaries also catches first_name/last_name, `/address/i`
// also catches delivery_address and its nested line1/city/postal_code by
// redacting the whole delivery_address subtree before recursing into it.

/** Rx / optical fields — both the decrypted field vocabulary (sph_right,
 *  cyl_left, axis_right, add_left, pd_binocular, pd_right, pd_left — see
 *  `modules/lms/types.ts` PrescriptionData) and the encrypted-at-rest Supabase
 *  column names (od_sphere_enc, os_cylinder_enc, ... — see
 *  `modules/prescription/supabase-vault.ts`). */
const RX_PATTERNS: readonly RegExp[] = [
  /(^|_)(sph|cyl|axis|add|pd)(_|$)/i,
  // Spelled-out forms too (`sphere`, `cylinder`), not just the abbreviations —
  // the abbreviation pattern above requires a boundary right after the token,
  // so `sphere`/`cylinder` would slip through it. The current vocabulary uses
  // abbreviations + `*_enc` columns, but a future payload keyed `sphere:` must
  // not leak.
  /spher/i,
  /cylind/i,
  /^(od|os)_/i,
  /_enc$/i,
  /prescription/i,
  /ciphertext/i,
  /plaintext/i,
  /decrypted/i,
  // Production actions (modules/lms/production.ts): a lens SKU encodes a
  // power, and an action's `detail` holds SKUs and free text typed by the
  // lab. Next to a job or order id either is health data.
  /^lenses$/i,
  /^sku$/i,
  /^detail$/i,
  /^hold_reason$/i,
];

/** Secrets / credentials. `key_alias`'s VALUE (e.g. the literal constant
 *  "prescription_master_key") is deliberately caught by the bare `key`
 *  pattern too — redacting it is safer than allowlisting one specific key
 *  name that could change. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /secret/i,
  /key/i,
  /token/i,
  /password/i,
  /apikey/i,
  /api_key/i,
  /authorization/i,
  /service_role/i,
  /vault/i,
  /dsn/i,
];

/** Customer PII (Thai PDPA personal data). */
const PII_PATTERNS: readonly RegExp[] = [
  /email/i,
  /phone/i,
  /(^|_)name(_|$)/i,
  /address/i,
  /^line_user_id$/i,
];

const DENYLIST_PATTERNS: readonly RegExp[] = [
  ...RX_PATTERNS,
  ...SECRET_PATTERNS,
  ...PII_PATTERNS,
];

/**
 * Explicit reminder of what is intentionally left un-redacted: opaque Medusa/
 * Klear operational ids are not PII on their own and are needed for ops
 * debugging (order_id, medusa_order_id, lab_job_id, tracking_number,
 * shipment_id, cart_id, status, event, reason, ...). There is no allowlist to
 * implement — the denylist above simply doesn't match these key names. This
 * constant exists only as documentation; it is not consulted at runtime.
 */
export const OPERATIONAL_ID_KEYS_NOT_REDACTED: readonly string[] = [
  "order_id",
  "medusa_order_id",
  "lab_job_id",
  "tracking_number",
  "shipment_id",
  "cart_id",
  "status",
  "event",
  "reason",
];

function isDenylistedKey(key: string): boolean {
  return DENYLIST_PATTERNS.some((re) => re.test(key));
}

const REDACTED = "[redacted]";
/** Cap recursion so a pathological/cyclic object can't hang or crash the
 *  process inside `beforeSend` (which runs on the hot error path). */
const MAX_SCRUB_DEPTH = 8;

/**
 * Recursively redact any object key matching the denylist. Depth-capped and
 * cycle-safe (a WeakSet of already-visited objects) so self-referential or
 * pathologically deep payloads degrade to a placeholder instead of hanging.
 */
export function scrub(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_SCRUB_DEPTH) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrub(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isDenylistedKey(key) ? REDACTED : scrub(v, depth + 1, seen);
  }
  return out;
}

/** An address without its query string or fragment. */
function withoutQuery(address: string): string {
  const cut = address.search(/[?#]/);
  return cut === -1 ? address : address.slice(0, cut);
}

/** Breadcrumb data scrubbed by key, with no query string or fragment: the
 *  SDK's `http.query` / `http.fragment` are dropped and a `url` is cut at
 *  `?` or `#`. A console breadcrumb's message is free text and is left as
 *  it is (only its `data` is cleaned). */
function scrubBreadcrumbData(data: Record<string, unknown>): Record<string, unknown> {
  const out = scrub(data) as Record<string, unknown>;
  delete out["http.query"];
  delete out["http.fragment"];
  if (typeof out.url === "string") out.url = withoutQuery(out.url);
  return out;
}

/** Structural subset of a Sentry request payload this scrubber touches. */
interface ScrubbableRequest {
  url?: unknown;
  data?: unknown;
  headers?: Record<string, unknown>;
  cookies?: unknown;
  query_string?: unknown;
}

/**
 * Deep-scrub a Sentry event in place before it leaves the process. Composes
 * with `Sentry.init({ beforeSend })`.
 *
 *   - `extra` / `contexts`: recursive key-based scrub.
 *   - `breadcrumbs[].data`: recursive key-based scrub per breadcrumb, with
 *     no query string or fragment (see `scrubBreadcrumbData`).
 *   - `request`: drop `cookies` wholesale (session material) and the
 *     `cookie` / `set-cookie` headers; drop `data` when it is text (request
 *     bodies are never sent: a string has no keys to scrub, and `initSentry`
 *     turns body capture off at the source); scrub `data` when it is an
 *     object, and `headers` (an `authorization` header is caught by the
 *     secret pattern above). No query string is sent: `query_string` is
 *     dropped, and `url` and the `referer` header are cut at `?` or `#`
 *     (a search box puts what was typed there, under a name no denylist
 *     can know).
 *
 * `sendDefaultPii: false` (set at `Sentry.init` call sites) already stops the
 * SDK from attaching IP/user by default — this function is the backstop for
 * whatever a call site explicitly attaches.
 *
 * INVARIANT — the one channel this backstop CANNOT clean is the exception
 * message/stack (`event.exception.values[].value`): those are free text, and a
 * key-based scrubber has no key to match on. That channel stays safe ONLY
 * because error messages on the PDPA paths are engineered to embed opaque
 * identifiers, column NAMES, and HTTP statuses — never a decrypted Rx value,
 * ciphertext, Vault key, or the service-role key (see
 * `modules/prescription/supabase-vault.ts`, whose errors interpolate `${field}`
 * = the column name only). KEEP IT THAT WAY: never interpolate a decrypted
 * value or secret into an Error message on a path that can reach Sentry.
 */
export function scrubSentryEvent<T extends SentryEvent>(event: T): T {
  if (event.extra) {
    event.extra = scrub(event.extra) as SentryEvent["extra"];
  }
  if (event.contexts) {
    event.contexts = scrub(event.contexts) as SentryEvent["contexts"];
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) =>
      b?.data ? { ...b, data: scrubBreadcrumbData(b.data) } : b,
    );
  }
  if (event.request) {
    const req = event.request as ScrubbableRequest;
    delete req.cookies;
    if (typeof req.data === "string") {
      delete req.data;
    } else if (req.data !== undefined) {
      req.data = scrub(req.data);
    }
    if (req.headers && typeof req.headers === "object") {
      const headers = scrub(req.headers) as Record<string, unknown>;
      for (const name of Object.keys(headers)) {
        if (/^(set-)?cookie$/i.test(name)) delete headers[name];
        else if (/^referer$/i.test(name) && typeof headers[name] === "string") {
          headers[name] = withoutQuery(headers[name] as string);
        }
      }
      req.headers = headers;
    }
    delete req.query_string;
    if (typeof req.url === "string") req.url = withoutQuery(req.url);
  }
  return event;
}

/** Scrub a single breadcrumb's `data` before it's buffered. Composes with
 *  `Sentry.init({ beforeBreadcrumb })` — catches PII that would otherwise sit
 *  in the breadcrumb ring buffer and ride along on a LATER, unrelated error. */
export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  if (breadcrumb.data) {
    breadcrumb.data = scrubBreadcrumbData(breadcrumb.data);
  }
  return breadcrumb;
}

let initialized = false;

/**
 * Initialize Sentry for the backend. DORMANT UNTIL `SENTRY_DSN` IS SET —
 * returns immediately (no `Sentry.init` call) when the env var is unset or
 * empty, so local dev and un-provisioned Railway environments stay silent
 * no-ops. Idempotent — a second call is a no-op even if `SENTRY_DSN` is set,
 * so `register()` running more than once at boot can't double-init.
 */
export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  if (initialized) return;
  initialized = true;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV,
    // Error visibility only for M5 — no performance tracing yet.
    tracesSampleRate: 0,
    // Never let the SDK auto-attach IP / request cookies / etc. — the
    // scrubber above is the backstop, this is the first line of defense.
    sendDefaultPii: false,
    // Request bodies are never recorded. The SDK's default Http integration
    // keeps up to 10 kB of each incoming body whatever `sendDefaultPii` says;
    // this instance replaces it (same name) with body capture off.
    integrations: [Sentry.httpIntegration({ maxIncomingRequestBodySize: "none" })],
    // If scrubbing fails, nothing is sent: returning null drops the event
    // or breadcrumb (a throw here would make the SDK send its own event).
    beforeSend: (event) => {
      try {
        return scrubSentryEvent(event);
      } catch {
        return null;
      }
    },
    beforeBreadcrumb: (breadcrumb) => {
      try {
        return scrubBreadcrumb(breadcrumb);
      } catch {
        return null;
      }
    },
  });
}

/** Test-only hook to reset the once-per-process init guard. */
export function __resetSentryInitForTests(): void {
  initialized = false;
}

export interface CaptureContext {
  /**
   * Indexed, filterable labels. NOTE: tag values are NOT scrubbed (they land in
   * `event.tags`, which the backstop deliberately doesn't walk — tags are meant
   * to be low-cardinality, queryable facets). Only ever pass OPAQUE values here
   * (module name, event type, a status enum) — NEVER an email, name, decrypted
   * value, or secret. Sensitive context goes in `extra` (which IS scrubbed).
   */
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

/**
 * Capture an exception with optional tags/extra. `extra` is scrubbed before
 * being attached to the event (defense-in-depth on top of `beforeSend`).
 * Safe no-op when Sentry isn't initialized (no DSN) — `@sentry/node`'s
 * capture functions are documented no-ops pre-init, and this wrapper also
 * swallows any unexpected error so observability code never breaks a caller.
 */
export function captureException(error: unknown, context?: CaptureContext): void {
  try {
    Sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
      }
      if (context?.extra) {
        scope.setContext("extra", scrub(context.extra) as Record<string, unknown>);
      }
      Sentry.captureException(error);
    });
  } catch {
    // Observability must never break the call site.
  }
}

export interface MessageCaptureContext extends CaptureContext {
  level?: "warning" | "error" | "info";
}

/**
 * Capture a message (no Error object) with optional level/tags/extra. Same
 * scrubbing + no-op guarantees as `captureException`.
 */
export function captureMessage(message: string, context?: MessageCaptureContext): void {
  try {
    Sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
      }
      if (context?.extra) {
        scope.setContext("extra", scrub(context.extra) as Record<string, unknown>);
      }
      Sentry.captureMessage(message, context?.level ?? "info");
    });
  } catch {
    // Observability must never break the call site.
  }
}

export { Sentry };
