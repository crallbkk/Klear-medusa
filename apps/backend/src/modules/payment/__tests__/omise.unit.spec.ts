import { createHmac } from "node:crypto";
import { OmiseProvider } from "../providers/omise";
import { PaymentError, type RefundInput } from "../types";
import type {
  OmiseCharge,
  OmiseClient,
  OmiseClientFactory,
  OmiseRefund,
} from "../providers/omise-types";

// Opn issues webhook secrets as base64 strings. Tests use a valid base64
// value so production's `Buffer.from(secret, "base64")` decode produces
// the same key bytes both sides of the HMAC compute.
const WEBHOOK_SECRET = Buffer.from(
  "test_webhook_secret_do_not_use_in_prod",
).toString("base64");

function makeProvider() {
  const client: OmiseClient = {
    charges: {
      retrieve: jest.fn(),
      createRefund: jest.fn(),
    },
  };
  const factory: OmiseClientFactory = () => client;
  const provider = new OmiseProvider({
    publicKey: "pkey_test_abc",
    secretKey: "skey_test_abc",
    webhookSecret: WEBHOOK_SECRET,
    clientFactory: factory,
  });
  return { provider, client };
}

function buildCharge(overrides: Partial<OmiseCharge> = {}): OmiseCharge {
  return {
    object: "charge",
    id: "chrg_test_abc",
    amount: 60000,
    currency: "THB",
    status: "successful",
    paid: true,
    captured: true,
    metadata: { klear_method: "promptpay", klear_order_id: "ord_klr" },
    ...overrides,
  };
}

/**
 * Build the header pair Opn sends per docs.omise.co/api-webhooks:
 * `Omise-Signature` (hex HMAC-SHA256 over `<timestamp>.<body>` using
 * base64-decoded secret as key) + `Omise-Signature-Timestamp` (unix
 * seconds). Defaults to "now" so tests pass the ±5min replay window;
 * tests that exercise the replay window pass an explicit ts.
 *
 * Replaces the old `sign(body)` helper which signed just the body and
 * returned only a value for the (wrong) `x-omise-signature` header.
 * Klear-medusa side of Session C WS7.3a — mirrors Klear storefront WS6.
 */
function signedHeaders(
  body: string,
  options: { secret?: string; ts?: number } = {},
): Record<string, string> {
  const secret = options.secret ?? WEBHOOK_SECRET;
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const keyBuf = Buffer.from(secret, "base64");
  const sig = createHmac("sha256", keyBuf)
    .update(`${ts}.${body}`, "utf8")
    .digest("hex");
  return {
    "omise-signature": sig,
    "omise-signature-timestamp": String(ts),
  };
}

describe("OmiseProvider (Klear-medusa) — config", () => {
  it("rejects construction with missing keys", () => {
    expect(
      () =>
        new OmiseProvider({
          publicKey: "",
          secretKey: "skey",
          webhookSecret: "whsec",
        }),
    ).toThrow(/OmiseProvider requires/);
  });
});

describe("OmiseProvider.retrieveIntent + refund", () => {
  it("maps a retrieved charge to PaymentIntent", async () => {
    const { provider, client } = makeProvider();
    (client.charges.retrieve as jest.Mock).mockResolvedValue(
      buildCharge({ status: "successful", paid: true }),
    );
    const intent = await provider.retrieveIntent("chrg_test_abc");
    expect(intent.external_id).toBe("chrg_test_abc");
    expect(intent.amount).toEqual({ amount: 600, currency: "THB" });
    expect(intent.method).toBe("promptpay");
    expect(intent.status).toBe("succeeded");
  });

  it("issues a refund with reason + idempotency metadata", async () => {
    const { provider, client } = makeProvider();
    const refund: OmiseRefund = {
      object: "refund",
      id: "rfnd_test_001",
      charge: "chrg_test_abc",
      amount: 60000,
      currency: "THB",
      status: "closed",
    };
    (client.charges.createRefund as jest.Mock).mockResolvedValue(refund);

    const input: RefundInput = {
      intent_id: "chrg_test_abc",
      amount: { amount: 600, currency: "THB" },
      reason: "remake",
      idempotency_key: "idem_refund_a",
    };
    const result = await provider.refund(input);

    expect(client.charges.createRefund).toHaveBeenCalledWith("chrg_test_abc", {
      amount: 60000,
      metadata: {
        klear_reason: "remake",
        klear_idempotency_key: "idem_refund_a",
      },
    });
    expect(result.status).toBe("succeeded");
  });

  it("wraps SDK errors in PaymentError", async () => {
    const { provider, client } = makeProvider();
    (client.charges.retrieve as jest.Mock).mockRejectedValue(new Error("404"));
    await expect(provider.retrieveIntent("missing")).rejects.toBeInstanceOf(
      PaymentError,
    );
  });
});

describe("OmiseProvider.verifyAndParseWebhook", () => {
  it("rejects without Omise-Signature header", async () => {
    const { provider } = makeProvider();
    await expect(
      provider.verifyAndParseWebhook({
        raw_body: "{}",
        headers: {
          "omise-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        },
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("rejects on signature mismatch", async () => {
    const { provider } = makeProvider();
    const body = '{"object":"event","key":"charge.complete","data":{}}';
    const wrongSecret = Buffer.from("a-different-secret").toString("base64");
    await expect(
      provider.verifyAndParseWebhook({
        raw_body: body,
        headers: signedHeaders(body, { secret: wrongSecret }),
      }),
    ).rejects.toMatchObject({ code: "signature_invalid" });
  });

  it("normalises charge.complete (successful) to payment_succeeded", async () => {
    const { provider } = makeProvider();
    const event = {
      object: "event",
      id: "evnt_001",
      key: "charge.complete",
      livemode: false,
      data: buildCharge({ status: "successful", paid: true }),
      created: "2026-05-18T00:00:00Z",
    };
    const body = JSON.stringify(event);

    const result = await provider.verifyAndParseWebhook({
      raw_body: body,
      headers: signedHeaders(body),
    });
    expect(result.type).toBe("payment_succeeded");
    if (result.type === "payment_succeeded") {
      expect(result.intent.amount).toEqual({ amount: 600, currency: "THB" });
    }
  });

  it("normalises a failed charge to payment_failed with code + message", async () => {
    const { provider } = makeProvider();
    const event = {
      object: "event",
      id: "evnt_002",
      key: "charge.complete",
      livemode: false,
      data: buildCharge({
        status: "failed",
        paid: false,
        failure_code: "insufficient_fund",
        failure_message: "Insufficient funds.",
      }),
      created: "2026-05-18T00:00:00Z",
    };
    const body = JSON.stringify(event);
    const result = await provider.verifyAndParseWebhook({
      raw_body: body,
      headers: signedHeaders(body),
    });
    expect(result.type).toBe("payment_failed");
    if (result.type === "payment_failed") {
      expect(result.failure_code).toBe("insufficient_fund");
    }
  });

  it("normalises a closed refund to refund_succeeded", async () => {
    const { provider } = makeProvider();
    const event = {
      object: "event",
      id: "evnt_003",
      key: "refund.update",
      livemode: false,
      data: {
        object: "refund",
        id: "rfnd_002",
        charge: "chrg_test_abc",
        amount: 60000,
        currency: "THB",
        status: "closed",
      },
      created: "2026-05-18T00:00:00Z",
    };
    const body = JSON.stringify(event);
    const result = await provider.verifyAndParseWebhook({
      raw_body: body,
      headers: signedHeaders(body),
    });
    expect(result.type).toBe("refund_succeeded");
  });

  it("rejects unhandled event keys", async () => {
    const { provider } = makeProvider();
    const event = {
      object: "event",
      id: "evnt_004",
      key: "charge.create",
      livemode: false,
      data: buildCharge(),
      created: "2026-05-18T00:00:00Z",
    };
    const body = JSON.stringify(event);
    await expect(
      provider.verifyAndParseWebhook({
        raw_body: body,
        headers: signedHeaders(body),
      }),
    ).rejects.toMatchObject({ code: "unhandled_event" });
  });
});
