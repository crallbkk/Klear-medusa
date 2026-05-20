import { MedusaService } from "@medusajs/framework/utils";
import PrescriptionRef from "./models/prescription-ref";
import {
  decryptPrescription,
  type DecryptedPrescription,
} from "./supabase-vault";

export const PRESCRIPTION_MODULE = "prescription";

export type PrescriptionRefRow = {
  id: string;
  order_id: string;
  prescription_id: string;
  created_at: Date;
  updated_at: Date;
};

/**
 * Prescription reference module.
 *
 * Stores the (Medusa order_id → Supabase prescription_id) link, and
 * — when called by the LMS workflow at lab-handoff time — fetches +
 * decrypts the actual Rx via the Supabase Vault.
 *
 * Decryption is intentionally fenced inside this module: nothing
 * outside `decryptForLabHandoff()` should call `decryptPrescription`.
 * That makes the audit boundary single and obvious.
 */
class PrescriptionModuleService extends MedusaService({
  PrescriptionRef,
}) {
  /** Persist the (order_id, prescription_id) link. Idempotent — repeated
   *  calls with the same pair are a no-op. */
  async linkPrescriptionToOrder(
    orderId: string,
    prescriptionId: string,
  ): Promise<PrescriptionRefRow> {
    if (!orderId) throw new Error("linkPrescriptionToOrder: orderId required");
    if (!prescriptionId) {
      throw new Error("linkPrescriptionToOrder: prescriptionId required");
    }

    const existing = await this.listPrescriptionRefs({
      order_id: orderId,
      prescription_id: prescriptionId,
    });
    if (existing.length > 0) {
      return existing[0] as PrescriptionRefRow;
    }

    const created = await this.createPrescriptionRefs({
      order_id: orderId,
      prescription_id: prescriptionId,
    });
    return created as PrescriptionRefRow;
  }

  /** Return all linked prescriptions for an order. */
  async listForOrder(orderId: string): Promise<PrescriptionRefRow[]> {
    return (await this.listPrescriptionRefs({
      order_id: orderId,
    })) as PrescriptionRefRow[];
  }

  /** Most-recent prescription for an order, or null. */
  async getActiveRefForOrder(
    orderId: string,
  ): Promise<PrescriptionRefRow | null> {
    const rows = await this.listForOrder(orderId);
    if (rows.length === 0) return null;
    // Most recent by created_at.
    rows.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    );
    return rows[0]!;
  }

  /**
   * Decrypt the prescription linked to this order, ready for lab
   * handoff. This is the **only** sanctioned decrypt path on the
   * Medusa side.
   */
  async decryptForLabHandoff(
    orderId: string,
  ): Promise<DecryptedPrescription> {
    const ref = await this.getActiveRefForOrder(orderId);
    if (!ref) {
      throw new Error(
        `decryptForLabHandoff: no prescription linked to order ${orderId}`,
      );
    }
    return decryptPrescription(ref.prescription_id);
  }
}

export default PrescriptionModuleService;
