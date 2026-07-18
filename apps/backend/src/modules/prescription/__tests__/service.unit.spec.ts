import PrescriptionModuleService, { PRESCRIPTION_MODULE } from "../service";

describe("PrescriptionModuleService — module key", () => {
  it("exports the canonical module key", () => {
    expect(PRESCRIPTION_MODULE).toBe("prescription");
  });
});

describe("PrescriptionModuleService.decryptForLabHandoff", () => {
  // The service holds no persistent state (the prescription_ref table was
  // dropped); decryptForLabHandoff takes a prescription id directly and
  // delegates to the Supabase Vault. The guard path never touches `this`,
  // so we invoke it against a bare object to avoid constructing the
  // MedusaService base (which needs a DI container).
  it("rejects an empty prescription id before hitting the Vault", async () => {
    await expect(
      PrescriptionModuleService.prototype.decryptForLabHandoff.call({}, ""),
    ).rejects.toThrow(/prescriptionId required/);
  });
});
