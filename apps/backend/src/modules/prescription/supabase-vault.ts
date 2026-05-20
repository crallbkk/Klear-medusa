/**
 * Server-to-server bridge that decrypts a Klear prescription from
 * Supabase, on behalf of the Medusa LMS workflow.
 *
 * Klear's PDPA-critical rule: prescription numeric fields are stored
 * AES-256 encrypted via Supabase Vault. The plaintext is permitted to
 * exist only:
 *   1. Briefly in the customer's browser when they enter the Rx
 *   2. Briefly inside this module at lab-handoff time
 *   3. In the lab-handoff packet shipped to the chosen optical lab
 *
 * Anywhere else (logs, Sentry, audit payloads) MUST scrub.
 *
 * Auth: this code runs server-side in Medusa with a Supabase
 * service-role key (SUPABASE_SERVICE_ROLE_KEY). Service-role bypasses
 * RLS, which is appropriate because Medusa workflows are trusted
 * server code, not customer-facing.
 */

export interface DecryptedPrescription {
  // Sphere — diopter, half-step from −20.0 to +20.0
  sph_right: number;
  sph_left: number;
  // Cylinder — 0 to −6.0, half-step
  cyl_right: number;
  cyl_left: number;
  // Axis — 0–180 integer, required when cyl ≠ 0
  axis_right: number | null;
  axis_left: number | null;
  // Add — progressives + readers only
  add_right: number | null;
  add_left: number | null;
  // Pupillary distance, mm. Either pd_binocular OR (pd_right + pd_left).
  pd: number;
}

export class SupabaseVaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SupabaseVaultError";
    this.code = code;
  }
}

interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

function readConfig(): SupabaseConfig {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new SupabaseVaultError(
      "config",
      "SUPABASE_URL is not set on the Medusa server",
    );
  }
  if (!serviceRoleKey) {
    throw new SupabaseVaultError(
      "config",
      "SUPABASE_SERVICE_ROLE_KEY is not set on the Medusa server",
    );
  }
  return { url, serviceRoleKey };
}

/**
 * Fetches one prescription row from Supabase (encrypted ciphertext)
 * and decrypts every field via the Vault RPC. Returns the plaintext.
 *
 * Throws `SupabaseVaultError("not_found")` if the prescription id
 * doesn't exist, `SupabaseVaultError("status_invalid")` if the row
 * isn't in the `active` status (we never decrypt deleted/expired
 * rows), and propagates network or RPC errors as
 * `SupabaseVaultError("rpc")`.
 */
export async function decryptPrescription(
  prescription_id: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<DecryptedPrescription> {
  const { url, serviceRoleKey } = readConfig();
  const fetchImpl = opts.fetch ?? fetch;

  // Pull the encrypted row via PostgREST.
  const rowRes = await fetchImpl(
    `${url}/rest/v1/prescriptions?id=eq.${encodeURIComponent(prescription_id)}&select=id,status,od_sphere_enc,od_cylinder_enc,od_axis_enc,od_add_enc,os_sphere_enc,os_cylinder_enc,os_axis_enc,os_add_enc,pd_binocular_enc,pd_right_enc,pd_left_enc`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Accept: "application/json",
      },
    },
  );
  if (!rowRes.ok) {
    throw new SupabaseVaultError(
      "rpc",
      `Supabase prescription fetch failed (${rowRes.status})`,
    );
  }
  const rows = (await rowRes.json()) as Array<Record<string, string | null>>;
  const row = rows[0];
  if (!row) {
    throw new SupabaseVaultError(
      "not_found",
      `Prescription ${prescription_id} not found in Supabase`,
    );
  }
  if (row.status !== "active") {
    throw new SupabaseVaultError(
      "status_invalid",
      `Prescription ${prescription_id} is ${row.status} — refusing to decrypt`,
    );
  }

  // Decrypt each field via the Vault decrypt RPC.
  async function dec(field: string): Promise<number | null> {
    const ciphertext = row[field];
    if (ciphertext === null) return null;
    const res = await fetchImpl(`${url}/rest/v1/rpc/decrypt_prescription_field`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ciphertext }),
    });
    if (!res.ok) {
      throw new SupabaseVaultError(
        "rpc",
        `Supabase decrypt RPC failed for ${field} (${res.status})`,
      );
    }
    const plaintext = (await res.json()) as string;
    const num = Number(plaintext);
    if (!Number.isFinite(num)) {
      throw new SupabaseVaultError(
        "decrypt",
        `Decrypted Rx field ${field} is not a finite number`,
      );
    }
    return num;
  }

  const [
    sph_right,
    sph_left,
    cyl_right,
    cyl_left,
    axis_right,
    axis_left,
    add_right,
    add_left,
    pd_binocular,
    pd_right,
    pd_left,
  ] = await Promise.all([
    dec("od_sphere_enc"),
    dec("os_sphere_enc"),
    dec("od_cylinder_enc"),
    dec("os_cylinder_enc"),
    dec("od_axis_enc"),
    dec("os_axis_enc"),
    dec("od_add_enc"),
    dec("os_add_enc"),
    dec("pd_binocular_enc"),
    dec("pd_right_enc"),
    dec("pd_left_enc"),
  ]);

  if (sph_right === null || sph_left === null) {
    throw new SupabaseVaultError(
      "incomplete",
      `Prescription ${prescription_id} missing sphere values`,
    );
  }
  if (cyl_right === null || cyl_left === null) {
    throw new SupabaseVaultError(
      "incomplete",
      `Prescription ${prescription_id} missing cylinder values`,
    );
  }
  // PD: either binocular present, OR both monocular present.
  let pd: number;
  if (pd_binocular !== null) {
    pd = pd_binocular;
  } else if (pd_right !== null && pd_left !== null) {
    pd = pd_right + pd_left;
  } else {
    throw new SupabaseVaultError(
      "incomplete",
      `Prescription ${prescription_id} missing pupillary distance`,
    );
  }

  return {
    sph_right,
    sph_left,
    cyl_right,
    cyl_left,
    axis_right,
    axis_left,
    add_right,
    add_left,
    pd,
  };
}
