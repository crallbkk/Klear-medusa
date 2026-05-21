import { createHmac, timingSafeEqual } from "node:crypto";
import {
  PaymentError,
  type IPaymentProvider,
  type PaymentIntent,
  type PaymentMethod,
  type PaymentWebhookEvent,
  type RefundInput,
  type RefundResult,
} from "../types";
import type {
  OmiseCharge,
  OmiseClient,
  OmiseClientFactory,
  OmiseConfig,
  OmiseEvent,
  OmiseRefund,
} from "./omise-types";

/**
 * Concrete `IPaymentProvider` for **Opn Payments (Omise)** on the Medusa
 * side. Mirror of the storefront's provider but only implements the
 * server-only triple: retrieveIntent + refund + verifyAndParseWebhook.
 *
 * The storefront owns customer-facing operations (createIntent, cancel)
 * because that's where the Server Action + omise.js tokenisation flow
 * runs. The Medusa side handles operator-initiated refunds, webhook
 * receipt from Omise (forwarded from the storefront's `/api/webhooks/
 * payment` route or directly if we ever expose a Medusa webhook URL),
 * and reconciliation pulls.
 *
 * Currency conversion: Omise = satang (1 THB = 100 satang). Klear's
 * MoneyTHB carries major-unit amounts. Convert at the boundary.
 *
 * Sandbox-verification work that isn't possible until OMISE_SECRET_KEY
 * lands in env is marked `TODO(omise-sandbox)`.
 */

const OMISE_API_VERSION = "2019-05-29";

const defaultFactory: OmiseClientFactory = (config: OmiseConfig) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Omise = require("omise") as (cfg: OmiseConfig) => OmiseClient;
  return Omise({ ...config, omiseVersion: config.omiseVersion ?? OMISE_API_VERSION });
};

export interface OmiseProviderConfig {
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  /** Test override. */
  clientFactory?: OmiseClientFactory;
}

function thbToSatang(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new PaymentError("amount_invalid", `THB amount must be non-negative integer (got ${amount}).`);
  }
  return amount * 100;
}

function satangToThb(amount: number): number {
  if (!Number.isInteger(amount) || amount < 0 || amount % 100 !== 0) {
    throw new PaymentError(
      "amount_invalid",
      `Omise satang amount not baht-aligned: ${amount}`,
    );
  }
  return amount / 100;
}

export class OmiseProvider implements IPaymentProvider {
  readonly name = "omise" as const;
  private readonly client: OmiseClient;
  private readonly webhookSecret: string;

  constructor(config: OmiseProviderConfig) {
    if (!config.publicKey || !config.secretKey || !config.webhookSecret) {
      throw new PaymentError(
        "config_missing",
        "OmiseProvider requires publicKey, secretKey, and webhookSecret.",
      );
    }
    const factory = config.clientFactory ?? defaultFactory;
    this.client = factory({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
    });
    this.webhookSecret = config.webhookSecret;
  }

  async retrieveIntent(intent_id: string): Promise<PaymentIntent> {
    try {
      const charge = await this.client.charges.retrieve(intent_id);
      return chargeToIntent(charge);
    } catch (err) {
      throw rewrap(err, "retrieve_intent_failed");
    }
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    try {
      const refund = await this.client.charges.createRefund(input.intent_id, {
        amount: thbToSatang(input.amount.amount),
        metadata: {
          klear_reason: input.reason,
          klear_idempotency_key: input.idempotency_key,
        },
      });
      return refundToResult(refund);
    } catch (err) {
      throw rewrap(err, "refund_failed");
    }
  }

  async verifyAndParseWebhook(input: {
    raw_body: string;
    headers: Record<string, string>;
  }): Promise<PaymentWebhookEvent> {
    // Omise webhook signature: HMAC-SHA256 of the raw body keyed with
    // the per-endpoint webhook secret, hex-encoded in X-Omise-Signature.
    // Reference: https://docs.omise.co/webhooks
    // TODO(omise-sandbox): confirm header capitalisation when first real
    // webhook arrives in sandbox.
    const sig =
      input.headers["x-omise-signature"] ??
      input.headers["X-Omise-Signature"];
    if (!sig) {
      throw new PaymentError("signature_invalid", "Missing X-Omise-Signature header.");
    }
    const expected = createHmac("sha256", this.webhookSecret)
      .update(input.raw_body, "utf8")
      .digest("hex");
    if (!safeHexEqual(expected, sig.trim())) {
      throw new PaymentError("signature_invalid", "Signature mismatch.");
    }

    let event: OmiseEvent;
    try {
      event = JSON.parse(input.raw_body) as OmiseEvent;
    } catch {
      throw new PaymentError("payload_invalid", "Body is not valid JSON.");
    }
    if (event?.object !== "event") {
      throw new PaymentError(
        "payload_invalid",
        `Missing object:"event" envelope (got ${String(event?.object)}).`,
      );
    }

    switch (event.key) {
      case "charge.complete":
      case "charge.update":
      case "charge.capture":
      case "charge.expire":
      case "charge.reverse": {
        const charge = event.data as OmiseCharge;
        const intent = chargeToIntent(charge);
        if (charge.status === "successful" && charge.paid) {
          return { type: "payment_succeeded", intent };
        }
        if (charge.status === "failed") {
          return {
            type: "payment_failed",
            intent,
            failure_code: charge.failure_code ?? "unknown",
            failure_message: charge.failure_message ?? "Charge failed.",
          };
        }
        // expired / reversed / pending (which shouldn't reach us as terminal)
        return { type: "payment_cancelled", intent };
      }
      case "refund.create":
      case "refund.update": {
        const refund = event.data as OmiseRefund;
        const result = refundToResult(refund);
        if (refund.status === "closed") {
          return { type: "refund_succeeded", refund: result };
        }
        if (refund.status === "failed") {
          return {
            type: "refund_failed",
            refund: result,
            failure_message: "Omise marked the refund as failed.",
          };
        }
        return { type: "refund_succeeded", refund: result };
      }
      case "charge.create":
      default:
        throw new PaymentError(
          "unhandled_event",
          `Omise event key not handled: ${event.key}`,
        );
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function chargeToIntent(charge: OmiseCharge): PaymentIntent {
  return {
    id: charge.metadata?.klear_idempotency_key ?? charge.id,
    external_id: charge.id,
    idempotency_key: charge.metadata?.klear_idempotency_key ?? charge.id,
    amount: { amount: satangToThb(charge.amount), currency: "THB" },
    method: methodFromCharge(charge),
    status: chargeStatusToIntentStatus(charge),
    metadata: charge.metadata ?? {},
  };
}

function methodFromCharge(charge: OmiseCharge): PaymentMethod {
  const stamped = charge.metadata?.klear_method as PaymentMethod | undefined;
  if (stamped) return stamped;
  if (charge.card) return "credit_card";
  if (charge.source) {
    switch (charge.source.type) {
      case "promptpay":
        return "promptpay";
      case "truemoney":
        return "truemoney";
      case "rabbit_linepay":
        return "line_pay";
      default:
        return "credit_card";
    }
  }
  return "credit_card";
}

function chargeStatusToIntentStatus(
  charge: OmiseCharge,
): PaymentIntent["status"] {
  switch (charge.status) {
    case "successful":
      return "succeeded";
    case "failed":
      return "failed";
    case "expired":
    case "reversed":
      return "cancelled";
    case "pending":
      return "processing";
    default: {
      const exhaustive: never = charge.status;
      throw new PaymentError("unknown_status", String(exhaustive));
    }
  }
}

function refundToResult(refund: OmiseRefund): RefundResult {
  return {
    refund_id: refund.id,
    intent_id: refund.charge,
    amount: { amount: satangToThb(refund.amount), currency: "THB" },
    status:
      refund.status === "closed"
        ? "succeeded"
        : refund.status === "failed"
          ? "failed"
          : "pending",
  };
}

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function rewrap(err: unknown, code: string): PaymentError {
  if (err instanceof PaymentError) return err;
  const msg = err instanceof Error ? err.message : String(err);
  const wrapped = new PaymentError(code, `Omise call failed: ${msg}`);
  (wrapped as { cause?: unknown }).cause = err;
  return wrapped;
}
