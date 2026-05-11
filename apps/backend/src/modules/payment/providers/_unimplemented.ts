import {
  type IPaymentProvider,
  type PaymentIntent,
  type PaymentWebhookEvent,
  type RefundInput,
  type RefundResult,
  PaymentError,
} from "../types";

const NOT_IMPLEMENTED_MSG =
  "Payment gateway not yet selected. See DECISIONS.md #1. " +
  "Replace UnimplementedPaymentProvider with the chosen provider once " +
  "Omise / 2C2P / GBPrimePay decision is made.";

export class UnimplementedPaymentProvider implements IPaymentProvider {
  readonly name = "omise" as const;

  async retrieveIntent(_intent_id: string): Promise<PaymentIntent> {
    throw new PaymentError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    throw new PaymentError("not_implemented", NOT_IMPLEMENTED_MSG);
  }

  async verifyAndParseWebhook(_input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<PaymentWebhookEvent> {
    throw new PaymentError("not_implemented", NOT_IMPLEMENTED_MSG);
  }
}
