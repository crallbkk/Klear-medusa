import LmsModuleService, { LMS_MODULE } from "../service";
import { LabProviderError } from "../types";

describe("LmsModuleService — interface shape", () => {
  const svc = new LmsModuleService();

  it("exports the canonical module key", () => {
    expect(LMS_MODULE).toBe("lms");
  });

  it("exposes submitJob, getJobStatus, getProviderName", () => {
    expect(typeof svc.submitJob).toBe("function");
    expect(typeof svc.getJobStatus).toBe("function");
    expect(typeof svc.getProviderName).toBe("function");
  });

  it("defaults to the unimplemented provider until DECISIONS.md #4 is resolved", () => {
    expect(svc.getProviderName()).toBe("unimplemented");
  });

  it("submitJob throws LabProviderError(not_implemented)", async () => {
    await expect(
      svc.submitJob({
        job_ref: "j_1",
        klear_order_id: "ord_1",
        frame_sku: "F-001",
        lens_type: "single_vision",
        lens_index: 1.6,
        coating_addons: [],
        prescription: {
          sph_right: -1.0,
          sph_left: -1.25,
          cyl_right: 0,
          cyl_left: 0,
          axis_right: null,
          axis_left: null,
          add_right: null,
          add_left: null,
          pd: 62,
        },
        customer: {
          name: "Test",
          phone: "+66800000000",
          delivery_address: {
            line1: "1 Sukhumvit",
            city: "Bangkok",
            province: "Bangkok",
            postal_code: "10110",
            country_code: "TH",
          },
        },
        submitted_at: new Date().toISOString(),
      })
    ).rejects.toBeInstanceOf(LabProviderError);
  });

  it("getJobStatus throws LabProviderError(not_implemented)", async () => {
    await expect(svc.getJobStatus("p_1")).rejects.toBeInstanceOf(
      LabProviderError
    );
  });
});
