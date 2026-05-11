import {
  type IPaymentProvider,
  type PaymentIntent,
  type PaymentWebhookEvent,
  type RefundInput,
  type RefundResult,
} from "./types";
import { UnimplementedPaymentProvider } from "./providers/_unimplemented";

export const PAYMENT_MODULE = "klear_payment";

// Klear-specific payment service. Distinct from Medusa's built-in payment
// module (which handles checkout payment-collection lifecycle). This one
// owns the server-side gateway operations: refunds, reconciliation, webhook
// verification for the chosen Thai gateway.
//
// Concrete provider lands once DECISIONS.md #1 is resolved.

export default class PaymentModuleService {
  private readonly provider: IPaymentProvider = new UnimplementedPaymentProvider();

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
