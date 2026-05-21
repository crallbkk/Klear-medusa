/**
 * Minimal typed surface over the subset of `omise` (omise-node) we use on
 * the Medusa side. Smaller than the storefront's because Medusa only owns
 * the server-side operations: retrieve, refund, webhook verify. No
 * createIntent / sources here.
 *
 * Keep this in sync with `Klear/src/lib/payment/providers/omise-types.ts`
 * when fields change — they share the upstream SDK.
 */

export interface OmiseConfig {
  publicKey: string;
  secretKey: string;
  omiseVersion?: string;
}

export type OmiseChargeStatus =
  | "successful"
  | "failed"
  | "pending"
  | "expired"
  | "reversed";

export interface OmiseCharge {
  object: "charge";
  id: string;
  amount: number;
  currency: string;
  status: OmiseChargeStatus;
  paid: boolean;
  captured: boolean;
  failure_code?: string | null;
  failure_message?: string | null;
  metadata?: Record<string, string> | null;
  card?: { id: string; brand: string; last_digits: string } | null;
  source?: { type: string } | null;
}

export interface OmiseRefund {
  object: "refund";
  id: string;
  charge: string;
  amount: number;
  currency: string;
  status: "pending" | "closed" | "failed";
  metadata?: Record<string, string> | null;
}

export type OmiseEventKey =
  | "charge.create"
  | "charge.complete"
  | "charge.capture"
  | "charge.update"
  | "charge.expire"
  | "charge.reverse"
  | "refund.create"
  | "refund.update";

export interface OmiseEvent<TData = unknown> {
  object: "event";
  id: string;
  key: OmiseEventKey;
  livemode: boolean;
  data: TData;
  created: string;
}

export interface OmiseClient {
  charges: {
    retrieve(id: string): Promise<OmiseCharge>;
    createRefund(
      chargeId: string,
      input: { amount: number; metadata?: Record<string, string> },
    ): Promise<OmiseRefund>;
  };
}

export type OmiseClientFactory = (config: OmiseConfig) => OmiseClient;
