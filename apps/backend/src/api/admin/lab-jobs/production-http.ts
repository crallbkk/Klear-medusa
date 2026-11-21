// How a failure is named in a log line. Used by the lab-job Retry route.

/**
 * What kind of error this is, for a log line: its class name, its error
 * code and Medusa's error type, each only if it has the shape of one. Never
 * its message. The shapes are narrow on purpose: a class name is letters, a
 * code is a short run of capitals and digits (SQLSTATE, ECONNREFUSED), a
 * type is lower-case words. A lens SKU, a phone number or a field name with
 * a value fits none of them.
 */
export function errorKind(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; type?: unknown };
  const parts = [
    typeof e?.name === "string" && /^[A-Z][A-Za-z]{1,39}$/.test(e.name) ? e.name : null,
    typeof e?.code === "string" && /^[A-Z0-9_]{1,12}$/.test(e.code) ? e.code : null,
    typeof e?.type === "string" && /^[a-z_]{1,30}$/.test(e.type) ? e.type : null,
  ].filter(Boolean);
  return parts.join("/") || "unexpected error";
}
