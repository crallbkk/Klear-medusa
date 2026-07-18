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

// Lens vocabulary — mirrors the frontend's `LensTypeKey` literal union
// (Website repo `src/lib/lens-engine/types.ts` + `catalogue.ts`). This is
// the wire contract stamped onto line-item metadata at checkout. There is
// NO silent defaulting: an unknown lens_type is a build failure, surfaced
// as a `failed` lab_job row (see build-packet.ts).
export type LensType =
  | "non_prescription"
  | "single_vision"
  | "progressive_standard"
  | "progressive_premium"
  | "progressive_elite"
  | "readers"
  | "polarised_sport";

export const LENS_TYPES: readonly LensType[] = [
  "non_prescription",
  "single_vision",
  "progressive_standard",
  "progressive_premium",
  "progressive_elite",
  "readers",
  "polarised_sport",
] as const;

/** Lens types that require a decrypted prescription for the lab to cut.
 *  `non_prescription` (plano) is the only member that does NOT. */
export function lensRequiresPrescription(lensType: LensType): boolean {
  return lensType !== "non_prescription";
}

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
  // Pupillary distance in mm — ALWAYS monocular (per-eye). KLEAR.md §10:
  // labs + edgers work per-eye. When the source Rx only has a binocular PD
  // it is halved 50/50 into both eyes at decrypt time.
  pd_right: number;
  pd_left: number;
}

export interface LabJobPacket {
  job_ref: string;
  klear_order_id: string;
  frame_sku: string;
  lens_type: LensType;
  lens_index: number | null;
  coating_addons: string[];
  // Null only for `non_prescription` (plano) lenses — the lab still mounts
  // lenses but there is no Rx to cut. Every other lens type carries a
  // decrypted prescription.
  prescription: PrescriptionData | null;
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

/**
 * Result of composing a lab-job packet from a Medusa order. This is a
 * discriminated union rather than a throw-or-return so the subscriber can
 * ALWAYS persist a durable row — including for failures — giving ops
 * visibility in /admin/lab-jobs instead of a silent swallow.
 *
 *   ok         — full packet ready to submit (→ lab_job status "queued")
 *   skip       — frame-only order, no lens/Rx: legitimately no lab job
 *   pending_rx — customer paid; send-later Rx not yet submitted (→ row in
 *                "pending_rx" status; heals via retry once the Rx lands)
 *   failed     — genuine problem (unknown lens, missing Rx on an Rx line,
 *                decrypt failure, multi-pair, missing address/phone)
 */
export interface LabJobSnapshot {
  job_ref: string;
  klear_order_id: string;
  frame_sku?: string;
  lens_type?: string;
  lens_index?: number | null;
  coating_addons?: string[];
  prescription?: PrescriptionData | null;
  customer?: LabJobPacket["customer"];
  submitted_at?: string;
}

export type BuildPacketResult =
  | { outcome: "ok"; packet: LabJobPacket }
  | { outcome: "skip"; order_id: string; reason: string }
  | { outcome: "pending_rx"; reason: string; snapshot: LabJobSnapshot }
  | { outcome: "failed"; reason: string; snapshot: LabJobSnapshot };

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
