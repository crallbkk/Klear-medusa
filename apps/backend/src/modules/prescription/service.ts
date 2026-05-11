// Prescription reference module.
//
// The encrypted prescription record lives in Supabase (`prescriptions` table,
// AES-256 via pgcrypto). Medusa never sees plaintext Rx data — this module
// only stores the order_id → prescription_id pointer so the LMS module can
// fetch the encrypted blob from Supabase at lab-handoff time.
//
// Concrete storage lands in Session 3 (alongside the migration that adds the
// prescription_ref table). Until then both methods throw — callers get a
// clear error instead of a silent null.

export const PRESCRIPTION_MODULE = "prescription";

const NOT_IMPLEMENTED =
  "Prescription module not yet wired. Concrete impl + migration land in Phase 2.3 Session 3.";

export type PrescriptionRef = {
  order_id: string;
  prescription_id: string;
  created_at: Date;
};

export default class PrescriptionModuleService {
  async linkPrescriptionToOrder(
    _orderId: string,
    _prescriptionId: string
  ): Promise<PrescriptionRef> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getPrescriptionRef(_orderId: string): Promise<PrescriptionRef | null> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
