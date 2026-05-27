import {
  createWorkflow,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { RefundInput, RefundResult } from "../modules/payment/types";
import { refundPaymentStep } from "./steps/refund-payment";

/**
 * Refund a previously-captured Opn charge.
 *
 * **Idempotency.** Medusa workflows have native idempotency: passing the
 * same `transactionId` to a re-run of the workflow returns the cached
 * result of each step instead of re-executing it. Callers MUST pass
 * `transactionId = input.idempotency_key` so a refund-button double-
 * click does NOT charge two refunds at the gateway. The
 * `idempotency_key` carried inside the workflow input is ALSO threaded
 * down to the provider, so Opn-side dedupe is exercised IF Opn
 * supports `Idempotency-Key` on the refund endpoint (Klear/DECISIONS.md
 * "Opn behavioral findings" — confirmed for `charges.create`, refund
 * coverage still being probed in WS7.4).
 *
 * **Why not a custom dedupe table.** The kickoff doc considered a
 * Supabase `refund_intents` table for explicit dedupe; the workflow-
 * native primitive covers the same surface without the extra schema.
 * If Opn-side `Idempotency-Key` proves unreliable for refunds, we'd
 * add a check that detects a re-run via `transactionId` and skips the
 * provider call entirely, returning the cached result. That hardening
 * goes inside the step, not via a new table.
 *
 * **State-machine coupling (deferred).** Klear's storefront-side
 * `order_state_events` records a `refund_requested` transition when
 * the operator initiates the refund. Coupling THIS workflow back to
 * storefront state requires an S2S call which adds an admin-key
 * surface; deferred. For now, the storefront-side webhook receiver
 * (`refund_succeeded` / `refund_failed` cases) handles observability,
 * and the operator-facing record lives in the workflow's execution log.
 *
 * Returns the provider's RefundResult — caller (admin route) decides
 * whether to surface it as JSON to the operator.
 */
export const refundPaymentWorkflow = createWorkflow(
  "klear-refund-payment",
  function (input: RefundInput) {
    const result = refundPaymentStep(input);
    return new WorkflowResponse(result);
  },
);

export type { RefundInput, RefundResult };
