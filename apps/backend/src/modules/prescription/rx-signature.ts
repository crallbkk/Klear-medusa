import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC signing of prescription-id metadata (PDPA-critical).
 *
 * `klear_prescription_id` rides on Medusa line-item / order metadata, which
 * the Store API accepts from the CLIENT with only a publishable key — a
 * malicious cart could point at someone else's prescription id and the lab
 * pipeline would happily decrypt it. To close that, the storefront's
 * SERVER-side stamping paths (checkout sync + the send-later order-metadata
 * write) also stamp `klear_prescription_sig` = base64url(HMAC-SHA256(id,
 * KLEAR_RX_METADATA_SECRET)). The secret exists only server-side in both
 * runtimes, so a client cannot forge a valid signature.
 *
 * `buildLabJobPacket` MUST verify the signature (timing-safe) before any
 * decrypt. Missing/invalid signature with a present prescription_id is a
 * durable `failed` lab_job — never a decrypt.
 *
 * The Website twin of this helper lives at
 * `src/lib/prescription/metadata-signature.ts` — keep the two in sync.
 */

export const RX_METADATA_SECRET_ENV = "KLEAR_RX_METADATA_SECRET";

/**
 * Pure: compute the base64url HMAC-SHA256 signature of a prescription id.
 * The signature exists to prove the id passed our SERVER-side ownership gate
 * at signing time (only the server holds the secret) — a client cannot mint
 * one for an id it doesn't own, because the server refuses to sign an id the
 * caller can't prove ownership of. A single field means no framing/separator
 * is needed.
 */
export function signPrescriptionId(
  prescriptionId: string,
  secret: string,
): string {
  return createHmac("sha256", secret).update(prescriptionId).digest("base64url");
}

/**
 * Timing-safe verification of a metadata signature. Returns false for a
 * missing / non-string / wrong-length / mismatched signature — never throws
 * for bad input.
 */
export function verifyPrescriptionSignature(
  prescriptionId: string,
  signature: unknown,
  secret: string,
): boolean {
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = Buffer.from(signPrescriptionId(prescriptionId, secret));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
