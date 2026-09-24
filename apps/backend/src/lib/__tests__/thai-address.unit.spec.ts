import { thaiAddressLevels } from "../thai-address";

const META = {
  subdistrict: "คลองเตยเหนือ",
  district: "วัฒนา",
  province_th: "กรุงเทพมหานคร",
  postal_code: "10110",
};

describe("thaiAddressLevels", () => {
  it("English-locale order: Thai levels from the metadata, not the English display fields", () => {
    expect(
      thaiAddressLevels({
        city: "Watthana, Khlong Toei Nuea",
        province: "Bangkok",
        postal_code: "10110",
        metadata: META,
      }),
    ).toEqual({
      subdistrict: "คลองเตยเหนือ",
      district: "วัฒนา",
      province: "กรุงเทพมหานคร",
      thai: { subdistrict: "คลองเตยเหนือ", district: "วัฒนา", province: "กรุงเทพมหานคร" },
    });
  });

  it("incomplete trusted metadata: per-level fallback, but no complete `thai`", () => {
    const r = thaiAddressLevels({
      city: "Watthana, Khlong Toei Nuea",
      province: "Bangkok",
      postal_code: "10110",
      metadata: { district: "วัฒนา", province_th: "กรุงเทพมหานคร", postal_code: "10110" },
    });
    expect(r).toMatchObject({ subdistrict: "Khlong Toei Nuea", district: "วัฒนา" });
    expect(r.thai).toBeNull();
  });

  it("metadata for a different postcode (Admin-corrected address) is ignored", () => {
    expect(
      thaiAddressLevels({
        city: "บางรัก, สีลม",
        province: "กรุงเทพมหานคร",
        postal_code: "10500",
        metadata: META,
      }),
    ).toEqual({
      subdistrict: "สีลม",
      district: "บางรัก",
      province: "กรุงเทพมหานคร",
      thai: null,
    });
  });

  it("no metadata: 'amphoe, tambon' city is split; a free-text city is the district", () => {
    expect(thaiAddressLevels({ city: "วัฒนา, คลองเตยเหนือ", province: "กรุงเทพมหานคร", postal_code: "10110" }))
      .toMatchObject({ district: "วัฒนา", subdistrict: "คลองเตยเหนือ" });
    expect(thaiAddressLevels({ city: "วัฒนา", postal_code: "10110" })).toMatchObject({
      district: "วัฒนา",
      subdistrict: undefined,
      province: "วัฒนา",
    });
  });

  it("blank metadata values fall through; metadata with no levels isn't 'from Thai metadata'", () => {
    expect(
      thaiAddressLevels({
        city: "Watthana",
        province: "Bangkok",
        postal_code: "10110",
        metadata: { postal_code: "10110", subdistrict: " ", district: "", province_th: "" },
      }),
    ).toEqual({ subdistrict: undefined, district: "Watthana", province: "Bangkok", thai: null });
  });

  it("trusted metadata comes back trimmed", () => {
    expect(
      thaiAddressLevels({
        postal_code: "10110",
        metadata: { subdistrict: " คลองเตยเหนือ ", district: " วัฒนา", province_th: "กรุงเทพมหานคร ", postal_code: " 10110 " },
      }).thai,
    ).toEqual({ subdistrict: "คลองเตยเหนือ", district: "วัฒนา", province: "กรุงเทพมหานคร" });
  });

  it("no address / no postcode → nothing trusted", () => {
    expect(thaiAddressLevels(null)).toEqual({ thai: null });
    expect(thaiAddressLevels({ city: "x", metadata: META })).toMatchObject({ thai: null, district: "x" });
  });
});
