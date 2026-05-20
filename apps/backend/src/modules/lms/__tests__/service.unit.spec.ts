import { LMS_MODULE } from "../service";

describe("LmsModuleService — module key", () => {
  it("exports the canonical module key", () => {
    expect(LMS_MODULE).toBe("lms");
  });
});
