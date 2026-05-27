import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk";
import { PAYMENT_MODULE } from "../../modules/payment/service";
import type PaymentModuleService from "../../modules/payment/service";
import type {
  RefundInput,
  RefundResult,
} from "../../modules/payment/types";

/**
 * Refund step — invokes the `klear_payment` module's `refund()` which
 * dispatches to the configured provider (currently Opn). The step is
 * intentionally thin: validation, idempotency, and orchestration live
 * in the workflow that composes it, not here.
 *
 * Compensation: refund operations are NOT auto-compensated. Reversing a
 * refund means issuing a new charge, which is not a "rollback" the
 * customer should ever see automatically. A failed refund should
 * surface to the operator for manual review (the workflow logs the
 * failure to Sentry via the standard error path).
 */
export const refundPaymentStep = createStep(
  "klear-refund-payment",
  async (input: RefundInput, { container }) => {
    const payment = container.resolve(PAYMENT_MODULE) as PaymentModuleService;
    const result: RefundResult = await payment.refund(input);
    return new StepResponse(result);
  },
);
