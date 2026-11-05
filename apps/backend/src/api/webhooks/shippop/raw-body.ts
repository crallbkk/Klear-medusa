import type { MedusaRequest } from "@medusajs/framework/http";

/**
 * The Shippop webhook body as the urlencoded string Shippop sent.
 *
 * `src/api/middlewares.ts` asks Medusa to keep the raw bytes for this route
 * (`preserveRawBody`), so normally `req.rawBody` is the exact wire body.
 *
 * Fallback, if the raw body is missing: re-encode the parsed `req.body`.
 * Medusa's urlencoded parser runs with `extended: true`, which turns
 * `data[datetime]=…&data[reason]=…` into `{ data: { datetime, reason } }`.
 * Re-encoding that with `String(value)` would send `data=[object Object]`
 * and lose the event time and the delivery-failure reason, so nested
 * objects and arrays are written back in bracket notation.
 */
export function extractRawBody(req: MedusaRequest): string {
  const maybeRaw = (req as { rawBody?: Buffer | string }).rawBody;
  if (typeof maybeRaw === "string") return maybeRaw;
  if (Buffer.isBuffer(maybeRaw)) return maybeRaw.toString("utf8");
  if (typeof req.body === "string") return req.body;
  if (req.body && typeof req.body === "object") {
    const params = new URLSearchParams();
    appendParams(params, "", req.body);
    return params.toString();
  }
  return "";
}

function appendParams(params: URLSearchParams, prefix: string, value: unknown): void {
  if (value === null || value === undefined) {
    if (prefix) params.append(prefix, "");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => appendParams(params, `${prefix}[${i}]`, v));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      appendParams(params, prefix ? `${prefix}[${k}]` : k, v);
    }
    return;
  }
  params.append(prefix, String(value));
}
