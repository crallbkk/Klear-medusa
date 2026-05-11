import PaymentModuleService, { PAYMENT_MODULE } from "../service";
import { PaymentError } from "../types";

describe("PaymentModuleService — interface shape", () => {
  const svc = new PaymentModuleService();

  it("uses a Klear-specific module key (distinct from Medusa's built-in payment)", () => {
    expect(PAYMENT_MODULE).toBe("klear_payment");
  });

  it("exposes retrieveIntent, refund, verifyAndParseWebhook, getProviderName", () => {
    expect(typeof svc.retrieveIntent).toBe("function");
    expect(typeof svc.refund).toBe("function");
    expect(typeof svc.verifyAndParseWebhook).toBe("function");
    expect(typeof svc.getProviderName).toBe("function");
  });

  it("retrieveIntent throws PaymentError(not_implemented)", async () => {
    await expect(svc.retrieveIntent("pi_1")).rejects.toBeInstanceOf(
      PaymentError
    );
  });

  it("refund throws PaymentError(not_implemented)", async () => {
    await expect(
      svc.refund({
        intent_id: "pi_1",
        amount: { amount: 100, currency: "THB" },
        reason: "customer_request",
        idempotency_key: "idem_1",
      })
    ).rejects.toBeInstanceOf(PaymentError);
  });

  it("verifyAndParseWebhook throws PaymentError(not_implemented)", async () => {
    await expect(
      svc.verifyAndParseWebhook({ raw_body: "{}", headers: {} })
    ).rejects.toBeInstanceOf(PaymentError);
  });
});
