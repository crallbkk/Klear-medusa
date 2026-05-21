import {
  type IPaymentProvider,
  type PaymentIntent,
  type PaymentWebhookEvent,
  type RefundInput,
  type RefundResult,
} from "./types";
import { UnimplementedPaymentProvider } from "./providers/_unimplemented";
import { OmiseProvider } from "./providers/omise";

export const PAYMENT_MODULE = "klear_payment";

// Klear-specific payment service. Distinct from Medusa's built-in payment
// module (which handles checkout payment-collection lifecycle). This one
// owns the server-side gateway operations: refunds, reconciliation, webhook
// verification.
//
// Provider resolved per DECISIONS.md #1 (2026-05-18): Opn Payments (Omise).
// When OMISE_* env is set, wire OmiseProvider. Otherwise fall back to the
// Unimplemented placeholder — local dev and tests run without live keys,
// and a missing-config startup crash would block the rest of the module
// loader from running.

export default class PaymentModuleService {
  private readonly provider: IPaymentProvider;

  constructor() {
    this.provider = resolveProviderFromEnv();
  }

  async retrieveIntent(intentId: string): Promise<PaymentIntent> {
    return this.provider.retrieveIntent(intentId);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return this.provider.refund(input);
  }

  async verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<PaymentWebhookEvent> {
    return this.provider.verifyAndParseWebhook(input);
  }

  getProviderName(): string {
    return this.provider.name;
  }
}

function resolveProviderFromEnv(): IPaymentProvider {
  const choice = (process.env.PAYMENT_PROVIDER ?? "omise").toLowerCase();
  if (choice !== "omise") return new UnimplementedPaymentProvider();

  const publicKey = process.env.OMISE_PUBLIC_KEY;
  const secretKey = process.env.OMISE_SECRET_KEY;
  const webhookSecret = process.env.OMISE_WEBHOOK_SECRET;
  if (!publicKey || !secretKey || !webhookSecret) {
    return new UnimplementedPaymentProvider();
  }
  return new OmiseProvider({ publicKey, secretKey, webhookSecret });
}
