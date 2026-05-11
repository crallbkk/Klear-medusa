// Lab Management System (LMS) provider abstraction.
//
// Klear hands prescription orders off to an external optical lab for lens
// cutting + frame mounting. The lab partner is TBD (see DECISIONS.md #3 +
// #4); until then this module exposes only the interface shape, with an
// Unimplemented placeholder. When the partner is chosen, drop in a concrete
// provider under `./providers/<vendor>.ts` and switch the factory.
//
// CRITICAL: this module is the **only** path through which decrypted
// prescription data is allowed to leave Supabase. Concrete providers must
// decrypt-on-read at submitJob() time and never persist the plaintext blob
// outside the lab-handoff packet. See KLEAR.md §4 + PDPA notes.

export type LensType =
  | "single_vision"
  | "progressive"
  | "reader"
  | "polarised_sport";

export interface PrescriptionData {
  // Sphere (THB convention — diopter, half-step from −20.0 to +20.0).
  sph_right: number;
  sph_left: number;
  // Cylinder (0 to −6.0, half-step).
  cyl_right: number;
  cyl_left: number;
  // Axis (0–180 integer; required when cyl ≠ 0).
  axis_right: number | null;
  axis_left: number | null;
  // Add (progressives + readers only).
  add_right: number | null;
  add_left: number | null;
  // Pupillary distance in mm.
  pd: number;
}

export interface LabJobPacket {
  job_ref: string;
  klear_order_id: string;
  frame_sku: string;
  lens_type: LensType;
  lens_index: number | null;
  coating_addons: string[];
  prescription: PrescriptionData;
  customer: {
    name: string;
    phone: string;
    delivery_address: {
      line1: string;
      line2?: string;
      city: string;
      province: string;
      postal_code: string;
      country_code: "TH";
    };
  };
  submitted_at: string;
}

export type LabJobStatus =
  | "queued"
  | "in_production"
  | "qc"
  | "shipped_to_klear"
  | "delivered"
  | "rejected_remake";

export interface LabJobStatusReport {
  job_ref: string;
  status: LabJobStatus;
  notes?: string;
  reported_at: string;
}

export interface ILabProvider {
  readonly name: string;
  submitJob(packet: LabJobPacket): Promise<{ provider_job_id: string }>;
  getJobStatus(provider_job_id: string): Promise<LabJobStatusReport>;
}

export class LabProviderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "LabProviderError";
    this.code = code;
  }
}
