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
      fromThaiMetadata: true,
    });
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
      fromThaiMetadata: false,
    });
  });

  it("no metadata: 'amphoe, tambon' city is split; a free-text city is the district", () => {
    expect(thaiAddressLevels({ city: "วัฒนา, คลองเตยเหนือ", province: "กรุงเทพมหานคร", postal_code: "10110" }))
      .toMatchObject({ district: "วัฒนา", subdistrict: "คลองเตยเหนือ", fromThaiMetadata: false });
    expect(thaiAddressLevels({ city: "วัฒนา", postal_code: "10110" })).toMatchObject({
      district: "วัฒนา",
      subdistrict: undefined,
      province: "วัฒนา",
      fromThaiMetadata: false,
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
    ).toEqual({ subdistrict: undefined, district: "Watthana", province: "Bangkok", fromThaiMetadata: false });
  });

  it("no address / no postcode → nothing trusted", () => {
    expect(thaiAddressLevels(null)).toEqual({ fromThaiMetadata: false });
    expect(thaiAddressLevels({ city: "x", metadata: META })).toMatchObject({ fromThaiMetadata: false, district: "x" });
  });
});
