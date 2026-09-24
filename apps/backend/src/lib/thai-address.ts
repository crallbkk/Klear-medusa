/**
 * The Thai administrative levels of a Medusa address — subdistrict (tambon /
 * แขวง), district (amphoe / เขต), province — in THAI script whenever the
 * storefront recorded them. One implementation for everyone who hands an
 * address to a Thai party: the Shippop carrier mapping and the lab packet.
 *
 * The storefront stamps `metadata.{subdistrict, district, province_th,
 * postal_code}` in Thai regardless of checkout locale; `city` / `province`
 * are locale-formatted for display, so on an English-locale order they're
 * English ("Watthana, Khlong Toei Nuea" / "Bangkok").
 *
 * The metadata is trusted ONLY while `metadata.postal_code` matches the
 * address's postcode. Medusa Admin's edit-address form sends the plain fields
 * only and the order-update workflow merges, so a support-corrected address
 * keeps the OLD metadata; without this guard we'd send the new postcode with
 * the old area.
 *
 * Fallback (no / ignored metadata): the display fields. The storefront writes
 * `city` as "amphoe, tambon", so it's split; a free-text city (no comma) is
 * the district. These may be English on an English-locale order — accepted:
 * only orders placed before the metadata existed, or edited in Admin, hit it.
 */
export interface ThaiAddressLevels {
  subdistrict?: string;
  district?: string;
  province?: string;
  /** All three levels, straight from trusted Thai metadata — or null if the
   *  metadata is untrusted or incomplete. For callers that must not mix Thai
   *  levels with (possibly English) display-field fallbacks. */
  thai: { subdistrict: string; district: string; province: string } | null;
}

export function thaiAddressLevels(addr: unknown): ThaiAddressLevels {
  if (!addr || typeof addr !== "object") return { thai: null };
  const a = addr as Record<string, unknown>;
  const meta = (a.metadata && typeof a.metadata === "object" ? a.metadata : {}) as Record<
    string,
    unknown
  >;
  const postcode = str(a.postal_code) ?? str(a.postcode);
  const trusted = postcode !== undefined && str(meta.postal_code) === postcode;
  const [cityAmphoe, cityTambon] = splitCity(str(a.city));
  const mSub = trusted ? str(meta.subdistrict) : undefined;
  const mDist = trusted ? str(meta.district) : undefined;
  const mProv = trusted ? str(meta.province_th) : undefined;
  return {
    subdistrict: mSub ?? cityTambon,
    district: mDist ?? cityAmphoe,
    province: mProv ?? str(a.province) ?? cityAmphoe,
    thai: mSub && mDist && mProv ? { subdistrict: mSub, district: mDist, province: mProv } : null,
  };
}

/** "amphoe, tambon" (the storefront's format) → [amphoe, tambon]; a city
 *  without a comma → [city, undefined]. */
function splitCity(city: string | undefined): [string | undefined, string | undefined] {
  if (!city) return [undefined, undefined];
  const i = city.indexOf(",");
  if (i === -1) return [city, undefined];
  return [str(city.slice(0, i)), str(city.slice(i + 1))];
}

/** Non-empty trimmed string, else undefined (so `??` falls through on "" too). */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
