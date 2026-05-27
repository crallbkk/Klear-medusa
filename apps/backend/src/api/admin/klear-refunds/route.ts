import type {
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework";
import { z } from "zod";
import { refundPaymentWorkflow } from "../../../workflows/refund-payment";

/**
 * POST /admin/klear-refunds — operator-triggered Opn refund.
 *
 * Why this route exists alongside Medusa's built-in refund admin
 * actions: Medusa's built-ins operate on `payment_collections` and
 * call `payment_module.refund_payment(...)` against Medusa's payment
 * abstraction. Klear runs Opn through its OWN `klear_payment` module
 * (DECISIONS.md "Payment Gateway") because the cart.complete bridge
 * uses `pp_system_default` (a no-op satisfying Medusa's state
 * machine) and the real money movement happens in our module. So the
 * operator's "Refund" action must route through HERE, not through the
 * built-in Medusa Admin refund button. Kickoff doc's choice:
 * "favour adding a separate 'Klear Refund' button for safety" rather
 * than overriding the built-in.
 *
 * Auth: Medusa Admin's standard auth gate. Routes under /admin are
 * gated by the dashboard cookie/JWT.
 *
 * Body: { intent_id, amount, reason, idempotency_key }
 *   - intent_id     — Opn charge id (e.g. "chrg_test_...")
 *   - amount        — THB (major units; converted to satang at the
 *                     provider boundary). Integer.
 *   - reason        — "customer_request" | "remake" | "duplicate" | "fraud"
 *   - idempotency_key — operator's unique key for this refund attempt.
 *                       Becomes the workflow's transactionId so double-
 *                       click on the operator UI does NOT double-refund.
 */

const RefundBodySchema = z.object({
  intent_id: z.string().min(3),
  amount: z.number().int().positive(),
  reason: z.enum(["customer_request", "remake", "duplicate", "fraud"]),
  idempotency_key: z.string().min(8),
});

type RefundBody = z.infer<typeof RefundBodySchema>;

export async function POST(
  req: MedusaRequest<RefundBody>,
  res: MedusaResponse,
): Promise<void> {
  const parsed = RefundBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      details: parsed.error.flatten(),
    });
    return;
  }
  const input = parsed.data;

  try {
    // Workflow idempotency in Medusa v2: pass `transactionId` via the
    // `context` field of FlowRunOptions. Re-running the workflow with
    // the same transactionId returns the cached result of each step
    // instead of re-executing it. So a double-click on the operator
    // refund button → same idempotency_key → same transactionId →
    // workflow engine recognises the re-run and does NOT hit the
    // gateway twice.
    const { result } = await refundPaymentWorkflow(req.scope).run({
      input: {
        intent_id: input.intent_id,
        amount: { amount: input.amount, currency: "THB" },
        reason: input.reason,
        idempotency_key: input.idempotency_key,
      },
      context: { transactionId: input.idempotency_key },
    });
    res.json({ ok: true, refund: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({
      error: "refund_failed",
      message,
    });
  }
}
