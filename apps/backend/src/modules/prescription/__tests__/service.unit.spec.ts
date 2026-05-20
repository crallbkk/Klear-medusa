import { PRESCRIPTION_MODULE } from "../service";

describe("PrescriptionModuleService — module key", () => {
  it("exports the canonical module key", () => {
    expect(PRESCRIPTION_MODULE).toBe("prescription");
  });
});
