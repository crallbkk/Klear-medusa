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
  // Pupillary distance, mm — ALWAYS monocular (per-eye). KLEAR.md §10: the
  // lab + edger need per-eye PD, never a summed binocular value. When the
  // stored Rx only has a binocular PD, it is split 50/50 across both eyes
  // (mirrors the storefront's `splitPd` in `src/lib/lms/job-creator.ts`).
  pd_right: number;
  pd_left: number;
}

export class SupabaseVaultError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SupabaseVaultError";
    this.code = code;
  }
}

/**
 * The 11 Vault-encrypted prescription columns, in a single ordered
 * declaration. This is the ONE place the Rx-decrypt contract lives:
 * both the PostgREST `select=...` list and the per-column Vault decrypt
 * calls are derived from this array, so adding/removing/renaming a
 * column can never leave the fetch and the decrypt step out of sync
 * with each other (the failure mode this module used to have). The order
 * here matches the pre-refactor `dec()` fan-out order (OD/OS interleaved
 * per field, then the PD fields) so the decrypt calls still kick off in
 * the same sequence as before.
 */
export const RX_ENC_COLUMNS = [
  "od_sphere_enc",
  "os_sphere_enc",
  "od_cylinder_enc",
  "os_cylinder_enc",
  "od_axis_enc",
  "os_axis_enc",
  "od_add_enc",
  "os_add_enc",
  "pd_binocular_enc",
  "pd_right_enc",
  "pd_left_enc",
] as const;

type RxEncColumn = (typeof RX_ENC_COLUMNS)[number];

/**
 * Canonical Supabase Vault RPC, defined in the storefront repo's
 * `supabase/migrations/0002_pgcrypto.sql`: `decrypt_with_vault_key(ciphertext
 * text, key_alias text)`.
 */
const RX_DECRYPT_RPC = "decrypt_with_vault_key";

/**
 * Vault key alias for prescription data. Must match the storefront's use of
 * the same data path (see `src/lib/encryption/vault.ts:VAULT_KEYS.PRESCRIPTION`).
 */
const RX_VAULT_KEY_ALIAS = "prescription_master_key";

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

  // Pull the encrypted row via PostgREST. The column list is derived from
  // RX_ENC_COLUMNS (see above) so this select can never drift from what
  // dec() below actually decrypts.
  const rowRes = await fetchImpl(
    `${url}/rest/v1/prescriptions?id=eq.${encodeURIComponent(prescription_id)}&select=id,status,${RX_ENC_COLUMNS.join(",")}`,
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

  // Decrypt each field via the canonical Supabase Vault RPC (RX_DECRYPT_RPC),
  // defined in the storefront repo's `supabase/migrations/0002_pgcrypto.sql`.
  // RX_VAULT_KEY_ALIAS is what the storefront uses for the same data path
  // (see `src/lib/encryption/vault.ts:VAULT_KEYS.PRESCRIPTION`).
  // Service-role is required — EXECUTE on this function is revoked from
  // authenticated/anon.
  async function dec(field: RxEncColumn): Promise<number | null> {
    const ciphertext = row[field];
    if (ciphertext === null) return null;
    const res = await fetchImpl(`${url}/rest/v1/rpc/${RX_DECRYPT_RPC}`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        ciphertext,
        key_alias: RX_VAULT_KEY_ALIAS,
      }),
    });
    if (!res.ok) {
      throw new SupabaseVaultError(
        "rpc",
        `Supabase decrypt RPC failed for ${field} (${res.status})`,
      );
    }
    const plaintext = (await res.json()) as string | null;
    // Guard BEFORE Number(): Number(null) and Number("") are both 0, which
    // would silently fabricate a 0.00-diopter value when the Vault RPC
    // returns NULL/empty for a ciphertext that exists. Fail loudly instead.
    if (plaintext === null || plaintext === "") {
      throw new SupabaseVaultError(
        "decrypt",
        `Decrypted Rx field ${field} came back empty from the Vault RPC`,
      );
    }
    const num = Number(plaintext);
    if (!Number.isFinite(num)) {
      throw new SupabaseVaultError(
        "decrypt",
        `Decrypted Rx field ${field} is not a finite number`,
      );
    }
    return num;
  }

  // Decrypt every column concurrently (still parallel — same fan-out as
  // before), but keyed by column name rather than positional array index.
  // The column↔output-field mapping below is now the ONE explicit place
  // that relationship lives, so it can no longer drift out of sync with
  // the select list the way a positional array could.
  const decryptedEntries = await Promise.all(
    RX_ENC_COLUMNS.map(
      async (col) => [col, await dec(col)] as [RxEncColumn, number | null],
    ),
  );
  const decrypted = Object.fromEntries(decryptedEntries) as Record<
    RxEncColumn,
    number | null
  >;

  const sph_right = decrypted.od_sphere_enc;
  const sph_left = decrypted.os_sphere_enc;
  const cyl_right = decrypted.od_cylinder_enc;
  const cyl_left = decrypted.os_cylinder_enc;
  const axis_right = decrypted.od_axis_enc;
  const axis_left = decrypted.os_axis_enc;
  const add_right = decrypted.od_add_enc;
  const add_left = decrypted.os_add_enc;
  const pd_binocular = decrypted.pd_binocular_enc;
  const pd_right = decrypted.pd_right_enc;
  const pd_left = decrypted.pd_left_enc;

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
  // PD → MONOCULAR (per-eye) for the lab. Monocular values are kept as-is;
  // a binocular-only Rx is halved 50/50 into each eye. This matches the
  // storefront `splitPd` semantics (Website `src/lib/lms/job-creator.ts`).
  let pd_right_out: number;
  let pd_left_out: number;
  if (pd_right !== null && pd_left !== null) {
    pd_right_out = pd_right;
    pd_left_out = pd_left;
  } else if (pd_binocular !== null) {
    const half = pd_binocular / 2;
    pd_right_out = half;
    pd_left_out = half;
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
    pd_right: pd_right_out,
    pd_left: pd_left_out,
  };
}
