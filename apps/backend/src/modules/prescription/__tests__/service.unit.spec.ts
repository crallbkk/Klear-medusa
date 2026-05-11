import PrescriptionModuleService, { PRESCRIPTION_MODULE } from "../service";

describe("PrescriptionModuleService — interface shape", () => {
  const svc = new PrescriptionModuleService();

  it("exports the canonical module key", () => {
    expect(PRESCRIPTION_MODULE).toBe("prescription");
  });

  it("exposes linkPrescriptionToOrder + getPrescriptionRef", () => {
    expect(typeof svc.linkPrescriptionToOrder).toBe("function");
    expect(typeof svc.getPrescriptionRef).toBe("function");
  });

  it("linkPrescriptionToOrder throws not-implemented until Session 3", async () => {
    await expect(svc.linkPrescriptionToOrder("ord_1", "rx_1")).rejects.toThrow(
      /not yet wired/i
    );
  });

  it("getPrescriptionRef throws not-implemented until Session 3", async () => {
    await expect(svc.getPrescriptionRef("ord_1")).rejects.toThrow(
      /not yet wired/i
    );
  });
});
