import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { PRESCRIPTION_MODULE } from "../prescription/service";
import type PrescriptionModuleService from "../prescription/service";
import {
  RX_METADATA_SECRET_ENV,
  verifyPrescriptionSignature,
} from "../prescription/rx-signature";
import {
  LENS_TYPES,
  lensRequiresPrescription,
  type BuildPacketResult,
  type LabJobPacket,
  type LabJobSnapshot,
  type LensType,
} from "./types";

/**
 * Orchestrator: given a Medusa order id, compose a lab-job build result.
 *
 * ── The wire contract ─────────────────────────────────────────────────────
 * The storefront stamps everything the lab needs onto Medusa metadata at
 * checkout (Website repo `src/lib/cart/to-medusa.ts`). Metadata is the SINGLE
 * source of truth — this module never reconstructs the order from anything
 * else.
 *
 *   LINE-ITEM metadata (per Medusa line):
 *     klear_kind                 "frame" | "lens"  (frame line is authoritative)
 *     klear_line_id              correlates the frame + lens halves
 *     klear_sku                  frame SKU (frame line)
 *     klear_lens_config          { lens_type, index, coating_addons } | null
 *     klear_prescription_id      string | null   (Rx captured at checkout)
 *     klear_prescription_status  "active" | "pending"
 *
 *   ORDER-LEVEL metadata (send-later flow, Website PR #126):
 *     klear_prescription_status  "active" | "pending"  (stamped at checkout)
 *     klear_prescription_id      written by POST /api/order/[id]/prescription
 *                                when the customer submits their Rx post-order
 *
 * Prescription resolution order:
 *   1. line-item klear_prescription_id, else
 *   2. order-level klear_prescription_id (send-later Rx submitted post-order), else
 *   3. if any pending status → "pending_rx" (waiting, NOT broken), else
 *   4. Rx-requiring lens with no id → "failed".
 *
 * Never throws for a business condition — returns a discriminated
 * BuildPacketResult so the subscriber persists a durable row for ops.
 *
 * Encapsulates the only sanctioned cross-module decrypt call:
 *   prescription.decryptForLabHandoff(prescription_id)
 */

export interface BuildPacketOptions {
  container: MedusaContainer;
  orderId: string;
}

/** Klear metadata shape stamped onto each line item at checkout. */
interface KlearLineMetadata {
  klear_kind?: "frame" | "lens";
  klear_sku?: string;
  klear_lens_config?: {
    lens_type?: string;
    index?: number | null;
    coating_addons?: string[];
  } | null;
  klear_prescription_id?: string | null;
  /** HMAC-SHA256(base64url) of klear_prescription_id, stamped server-side by
   *  the storefront. MUST verify before any decrypt — see rx-signature.ts. */
  klear_prescription_sig?: string | null;
  klear_prescription_status?: "active" | "pending";
}

/** Klear metadata stamped onto the ORDER (cart → order + send-later write). */
interface KlearOrderMetadata {
  klear_prescription_id?: string | null;
  klear_prescription_sig?: string | null;
  klear_prescription_status?: "active" | "pending";
}

const ALLOWED_LENS_TYPES: ReadonlySet<string> = new Set<string>(LENS_TYPES);

function buildCustomer(
  shipping: Record<string, unknown> | null | undefined,
): { customer: LabJobPacket["customer"]; error: string | null } {
  if (!shipping) {
    return { customer: undefined as never, error: "order has no shipping address" };
  }
  const name = [shipping.first_name, shipping.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!name) {
    return { customer: undefined as never, error: "shipping address has no name" };
  }
  const phone = (shipping.phone as string | undefined) ?? "";
  if (!phone) {
    return { customer: undefined as never, error: "shipping address has no phone" };
  }
  return {
    customer: {
      name,
      phone,
      delivery_address: {
        line1: (shipping.address_1 as string | undefined) ?? "",
        line2: (shipping.address_2 as string | undefined) ?? undefined,
        city: (shipping.city as string | undefined) ?? "",
        province: (shipping.province as string | undefined) ?? "",
        postal_code: (shipping.postal_code as string | undefined) ?? "",
        country_code: "TH",
      },
    },
    error: null,
  };
}

export async function buildLabJobPacket(
  opts: BuildPacketOptions,
): Promise<BuildPacketResult> {
  const { container, orderId } = opts;
  const jobRef = `klear-${orderId}`;

  // Resolve Medusa's built-in order module from the container.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderModule: any = container.resolve(Modules.ORDER);
  const order = await orderModule.retrieveOrder(orderId, {
    relations: ["items", "shipping_address"],
  });
  if (!order) {
    return {
      outcome: "failed",
      reason: `order ${orderId} not found`,
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }
  if (!order.items || order.items.length === 0) {
    return {
      outcome: "failed",
      reason: "order has no line items",
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }

  // Select the FRAME lines. The frame line is authoritative — it carries
  // klear_lens_config + klear_prescription_id (the paired lens line exists
  // only so the lens upcharge reaches the order total).
  const frameLines = order.items.filter(
    (it: { metadata?: KlearLineMetadata | null }) =>
      (it.metadata ?? {}).klear_kind === "frame",
  );

  if (frameLines.length === 0) {
    return {
      outcome: "failed",
      reason:
        "no frame line found (no line has metadata.klear_kind === 'frame') — " +
        "order predates the checkout metadata contract or was placed by a non-Klear client",
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }
  if (frameLines.length > 1) {
    // Do NOT silently process only the first pair (the original bug).
    return {
      outcome: "failed",
      reason: "multi-pair orders not supported at MVP",
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }

  const frameLine = frameLines[0];

  // A quantity > 1 frame line is a multi-pair order in disguise: the customer
  // paid for N pairs but a single packet would produce ONE. Same MVP wall as
  // multiple frame lines — fail durably, never silently under-produce.
  const frameQuantity = frameLine.quantity ?? 1;
  if (frameQuantity !== 1) {
    return {
      outcome: "failed",
      reason: `multi-pair orders not supported at MVP — quantity ${frameQuantity} on frame line`,
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }

  const lineMeta = (frameLine.metadata ?? {}) as KlearLineMetadata;
  const orderMeta = (order.metadata ?? {}) as KlearOrderMetadata;

  const frame_sku = lineMeta.klear_sku ?? frameLine.variant_sku ?? "";
  const lensConfig = lineMeta.klear_lens_config ?? null;
  const rawLensType = lensConfig?.lens_type;
  const lens_index = lensConfig?.index ?? null;
  const coating_addons = lensConfig?.coating_addons ?? [];

  // `|| null` (not `??`): normalise empty-string ids to null so a blank
  // line-level id falls through to the order-level id instead of masking it.
  const lineRxId = lineMeta.klear_prescription_id || null;
  const orderRxId = orderMeta.klear_prescription_id || null;
  const prescriptionId = lineRxId ?? orderRxId;
  // The signature must come from the SAME source as the id it signs.
  const prescriptionSig = lineRxId
    ? (lineMeta.klear_prescription_sig ?? null)
    : orderRxId
      ? (orderMeta.klear_prescription_sig ?? null)
      : null;
  const isPending =
    lineMeta.klear_prescription_status === "pending" ||
    orderMeta.klear_prescription_status === "pending";

  // Frame-only order: no lens config anywhere AND no prescription signal.
  // Legitimately needs no lab job.
  if (!lensConfig && !prescriptionId && !isPending) {
    return {
      outcome: "skip",
      order_id: orderId,
      reason: "frame-only order — no lens configuration and no prescription",
    };
  }

  // A prescription/pending signal with no lens configuration is contradictory
  // (there is nothing for the lab to cut). Surface it rather than guess.
  if (!lensConfig) {
    return {
      outcome: "failed",
      reason:
        "line carries a prescription/pending status but no lens configuration",
      snapshot: { job_ref: jobRef, klear_order_id: orderId, frame_sku },
    };
  }

  // The lab cannot cut without knowing WHICH frame. Missing both klear_sku
  // and variant_sku means the packet would carry an empty SKU — fail loudly.
  if (!frame_sku) {
    return {
      outcome: "failed",
      reason: "frame line has no SKU (klear_sku and variant_sku both empty)",
      snapshot: { job_ref: jobRef, klear_order_id: orderId },
    };
  }

  // Validate the lens vocabulary — NO silent defaulting.
  if (typeof rawLensType !== "string" || !ALLOWED_LENS_TYPES.has(rawLensType)) {
    return {
      outcome: "failed",
      reason: `unknown lens type: ${JSON.stringify(rawLensType ?? null)}`,
      snapshot: {
        job_ref: jobRef,
        klear_order_id: orderId,
        frame_sku,
        lens_index,
        coating_addons,
      },
    };
  }
  const lens_type = rawLensType as LensType;

  // Validate shipping/customer — missing address/phone is a failure trigger.
  const { customer, error: customerError } = buildCustomer(
    order.shipping_address,
  );
  if (customerError) {
    return {
      outcome: "failed",
      reason: customerError,
      snapshot: {
        job_ref: jobRef,
        klear_order_id: orderId,
        frame_sku,
        lens_type,
        lens_index,
        coating_addons,
      },
    };
  }

  const baseSnapshot: LabJobSnapshot = {
    job_ref: jobRef,
    klear_order_id: orderId,
    frame_sku,
    lens_type,
    lens_index,
    coating_addons,
    customer,
  };

  // Resolve the prescription.
  if (lensRequiresPrescription(lens_type)) {
    if (!prescriptionId) {
      if (isPending) {
        // Customer legitimately paid first and will send their Rx within 7
        // days (send-later flow). Not broken — waiting.
        return {
          outcome: "pending_rx",
          reason:
            "awaiting customer prescription (send-later) — retry once the Rx is submitted",
          snapshot: baseSnapshot,
        };
      }
      return {
        outcome: "failed",
        reason: `lens type ${lens_type} requires a prescription but none is linked`,
        snapshot: baseSnapshot,
      };
    }

    // ── PDPA gate: verify the metadata signature BEFORE any decrypt ──────
    // klear_prescription_id is client-controllable (the Store API accepts
    // line metadata with just a publishable key). Only the storefront's
    // server-side stamping paths hold KLEAR_RX_METADATA_SECRET, so a valid
    // HMAC proves the id was stamped by our server, not forged by a client
    // pointing at someone else's prescription.
    const secret = process.env[RX_METADATA_SECRET_ENV];
    if (!secret) {
      // Fail closed: without the secret we cannot distinguish a legitimate
      // id from a forged one, so we never decrypt. Config fix + retry heals.
      return {
        outcome: "failed",
        reason:
          `prescription signature could not be verified — ${RX_METADATA_SECRET_ENV} ` +
          "is not configured on the Medusa server",
        snapshot: baseSnapshot,
      };
    }
    if (!verifyPrescriptionSignature(prescriptionId, prescriptionSig, secret)) {
      // Deliberately NOT pending_rx: a present id with a bad/missing sig is
      // tampering or a stamping bug, not a customer we're waiting on.
      return {
        outcome: "failed",
        reason: "prescription signature invalid — possible tampering",
        snapshot: baseSnapshot,
      };
    }

    // Decrypt via the prescription module's one sanctioned path.
    const prescriptionService = container.resolve(
      PRESCRIPTION_MODULE,
    ) as PrescriptionModuleService;
    try {
      const prescription =
        await prescriptionService.decryptForLabHandoff(prescriptionId);
      return {
        outcome: "ok",
        packet: {
          job_ref: jobRef,
          klear_order_id: orderId,
          frame_sku,
          lens_type,
          lens_index,
          coating_addons,
          prescription,
          customer,
          submitted_at: new Date().toISOString(),
        },
      };
    } catch (err) {
      return {
        outcome: "failed",
        reason: `prescription decrypt failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
        snapshot: baseSnapshot,
      };
    }
  }

  // non_prescription (plano): a real lab job with no Rx to cut. Reached even
  // when a pending/prescription flag is present alongside — DELIBERATE: the
  // customer chose plano lenses, so any Rx signal on the line is vestigial
  // (e.g. a send-later flag left over from an earlier configurator pass) and
  // must not block the plano job.
  return {
    outcome: "ok",
    packet: {
      job_ref: jobRef,
      klear_order_id: orderId,
      frame_sku,
      lens_type,
      lens_index,
      coating_addons,
      prescription: null,
      customer,
      submitted_at: new Date().toISOString(),
    },
  };
}
