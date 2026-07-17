import { MedusaService } from "@medusajs/framework/utils";
import {
  decryptPrescription,
  type DecryptedPrescription,
} from "./supabase-vault";

export const PRESCRIPTION_MODULE = "prescription";

/**
 * Prescription module.
 *
 * Its single job is to be the **only** sanctioned path through which a
 * Klear prescription is decrypted on the Medusa side. Given a Supabase
 * `prescription_id` (resolved from Medusa order/line metadata by the LMS
 * `buildLabJobPacket` orchestrator), it fetches + decrypts the Rx via the
 * Supabase Vault RPC.
 *
 * There is no order↔prescription table on the Medusa side: the storefront
 * stamps `klear_prescription_id` directly onto order/line-item metadata at
 * checkout (and the send-later flow writes it onto the order post-payment),
 * so metadata is the wire contract and this module holds no persistent
 * state. (The former `prescription_ref` table had zero writers and was
 * dropped — see migration `Migration20260717000000`.)
 *
 * Decryption is intentionally fenced inside this module: nothing outside
 * `decryptForLabHandoff()` should call `decryptPrescription`, which keeps
 * the PDPA audit boundary single and obvious.
 */
class PrescriptionModuleService extends MedusaService({}) {
  /**
   * Decrypt a prescription by its Supabase id, ready for lab handoff. This
   * is the **only** sanctioned decrypt path on the Medusa side.
   *
   * The caller (LMS `buildLabJobPacket`) is responsible for resolving the
   * prescription id from order/line metadata; this method does not read
   * Medusa state.
   */
  async decryptForLabHandoff(
    prescriptionId: string,
  ): Promise<DecryptedPrescription> {
    if (!prescriptionId) {
      throw new Error("decryptForLabHandoff: prescriptionId required");
    }
    return decryptPrescription(prescriptionId);
  }
}

export default PrescriptionModuleService;
