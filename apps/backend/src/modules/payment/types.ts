// Payment provider abstraction (Medusa-side).
//
// Mirrors the storefront's `src/lib/payment/types.ts` contract so the two
// surfaces never drift. The storefront calls the gateway directly for QR /
// 3DS / deep-link UX; this module is the server-side counterpart that
// handles webhook verification, refund issuance, and reconciliation jobs
// from Medusa subscribers.
//
// Concrete impl blocks on DECISIONS.md #1 (Omise / 2C2P / GBPrimePay).

export type PaymentMethod =
  | "promptpay"
  | "truemoney"
  | "credit_card"
  | "line_pay";

export interface MoneyTHB {
  amount: number;
  currency: "THB";
}

export type PaymentIntentStatus =
  | "requires_payment_method"
  | "requires_action"
  | "processing"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "refunded";

export interface PaymentIntent {
  id: string;
  external_id: string;
  idempotency_key: string;
  amount: MoneyTHB;
  method: PaymentMethod;
  status: PaymentIntentStatus;
  metadata: Record<string, string>;
}

export interface RefundInput {
  intent_id: string;
  amount: MoneyTHB;
  reason: "customer_request" | "remake" | "duplicate" | "fraud";
  idempotency_key: string;
}

export interface RefundResult {
  refund_id: string;
  intent_id: string;
  amount: MoneyTHB;
  status: "pending" | "succeeded" | "failed";
}

export type PaymentWebhookEvent =
  | { type: "payment_succeeded"; intent: PaymentIntent }
  | {
      type: "payment_failed";
      intent: PaymentIntent;
      failure_code: string;
      failure_message: string;
    }
  | { type: "payment_cancelled"; intent: PaymentIntent }
  | { type: "refund_succeeded"; refund: RefundResult }
  | {
      type: "refund_failed";
      refund: RefundResult;
      failure_message: string;
    };

export interface IPaymentProvider {
  readonly name: "omise" | "2c2p" | "gbprimepay";
  retrieveIntent(intent_id: string): Promise<PaymentIntent>;
  refund(input: RefundInput): Promise<RefundResult>;
  verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<PaymentWebhookEvent>;
}

export class PaymentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PaymentError";
    this.code = code;
  }
}
