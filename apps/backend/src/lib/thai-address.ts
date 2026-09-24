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
  /** The levels came from the storefront's Thai metadata (not the display
   *  fields, which may be English). */
  fromThaiMetadata: boolean;
}

export function thaiAddressLevels(addr: unknown): ThaiAddressLevels {
  if (!addr || typeof addr !== "object") return { fromThaiMetadata: false };
  const a = addr as Record<string, unknown>;
  const meta = (a.metadata && typeof a.metadata === "object" ? a.metadata : {}) as Record<
    string,
    unknown
  >;
  const postcode = str(a.postal_code) ?? str(a.postcode);
  const trusted = postcode !== undefined && str(meta.postal_code) === postcode;
  const [cityAmphoe, cityTambon] = splitCity(str(a.city));
  const subdistrict = (trusted ? str(meta.subdistrict) : undefined) ?? cityTambon;
  const district = (trusted ? str(meta.district) : undefined) ?? cityAmphoe;
  const province = (trusted ? str(meta.province_th) : undefined) ?? str(a.province) ?? cityAmphoe;
  return {
    subdistrict,
    district,
    province,
    fromThaiMetadata: trusted && !!(str(meta.subdistrict) || str(meta.district) || str(meta.province_th)),
  };
}

/** "amphoe, tambon" (the storefront's format) → [amphoe, tambon]; a city
 *  without a comma → [city, undefined]. */
export function splitCity(city: string | undefined): [string | undefined, string | undefined] {
  if (!city) return [undefined, undefined];
  const i = city.indexOf(",");
  if (i === -1) return [city, undefined];
  return [str(city.slice(0, i)), str(city.slice(i + 1))];
}

/** Non-empty trimmed string, else undefined (so `??` falls through on "" too). */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}
