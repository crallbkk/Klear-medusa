import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { PRESCRIPTION_MODULE } from "../prescription/service";
import type PrescriptionModuleService from "../prescription/service";
import { type LabJobPacket, type LensType } from "./types";

/**
 * Orchestrator: given a Medusa order id, compose the LabJobPacket
 * ready for `lms.submitJob(packet)`.
 *
 * Pulls from three sources:
 *   1. Medusa order (line items, shipping address, customer name + phone)
 *   2. Prescription module (order_id → prescription_id, then decrypt)
 *   3. Klear-side metadata on the order line items (lens config —
 *      lens_type, index, coatings; written at checkout by the storefront).
 *
 * Encapsulates the only sanctioned cross-module decrypt call:
 *   prescription.decryptForLabHandoff(order_id)
 */

export interface BuildPacketOptions {
  container: MedusaContainer;
  orderId: string;
}

/** Klear metadata shape stamped onto each line item at checkout. */
interface KlearLineMetadata {
  klear_sku?: string;
  klear_lens_config?: {
    lens_type?: string;
    index?: number;
    coating_addons?: string[];
  };
  klear_prescription_id?: string;
}

const ALLOWED_LENS_TYPES: ReadonlySet<LensType> = new Set([
  "single_vision",
  "progressive",
  "reader",
  "polarised_sport",
]);

function pickLensType(raw: unknown): LensType {
  if (typeof raw === "string" && (ALLOWED_LENS_TYPES as Set<string>).has(raw)) {
    return raw as LensType;
  }
  // Default to single_vision when the storefront's metadata is
  // malformed or absent. Lab will reject the packet later if this is
  // wrong; surfacing the choice here gives a single audit point.
  return "single_vision";
}

export async function buildLabJobPacket(
  opts: BuildPacketOptions,
): Promise<LabJobPacket> {
  const { container, orderId } = opts;

  // Resolve Medusa's built-in order module from the container.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orderModule: any = container.resolve(Modules.ORDER);
  const order = await orderModule.retrieveOrder(orderId, {
    relations: ["items", "shipping_address"],
  });
  if (!order) {
    throw new Error(`buildLabJobPacket: order ${orderId} not found`);
  }
  if (!order.items || order.items.length === 0) {
    throw new Error(`buildLabJobPacket: order ${orderId} has no line items`);
  }

  // First Klear line item carries the Rx + lens config. Multi-line
  // orders (different Rx per pair) aren't supported at MVP — flagged
  // for the future when reorder-with-different-Rx lands.
  const firstLine = order.items[0];
  const lineMeta = (firstLine.metadata ?? {}) as KlearLineMetadata;
  const frame_sku = lineMeta.klear_sku ?? firstLine.variant_sku ?? "";
  const lens_type = pickLensType(lineMeta.klear_lens_config?.lens_type);
  const lens_index = lineMeta.klear_lens_config?.index ?? null;
  const coating_addons = lineMeta.klear_lens_config?.coating_addons ?? [];

  // Decrypt via the prescription module's one sanctioned path.
  const prescriptionService = container.resolve(
    PRESCRIPTION_MODULE,
  ) as PrescriptionModuleService;
  const prescription = await prescriptionService.decryptForLabHandoff(orderId);

  const shipping = order.shipping_address;
  if (!shipping) {
    throw new Error(
      `buildLabJobPacket: order ${orderId} has no shipping address`,
    );
  }
  const name = [shipping.first_name, shipping.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (!name) {
    throw new Error(`buildLabJobPacket: shipping address has no name`);
  }
  const phone = shipping.phone ?? "";
  if (!phone) {
    throw new Error(`buildLabJobPacket: shipping address has no phone`);
  }

  return {
    job_ref: `klear-${orderId}`,
    klear_order_id: orderId,
    frame_sku,
    lens_type,
    lens_index,
    coating_addons,
    prescription,
    customer: {
      name,
      phone,
      delivery_address: {
        line1: shipping.address_1 ?? "",
        line2: shipping.address_2 ?? undefined,
        city: shipping.city ?? "",
        province: shipping.province ?? "",
        postal_code: shipping.postal_code ?? "",
        country_code: "TH",
      },
    },
    submitted_at: new Date().toISOString(),
  };
}
