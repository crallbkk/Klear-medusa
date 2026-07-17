import LmsModuleService, { LMS_MODULE } from "../service";
import type { BuildPacketResult, LabJobPacket } from "../types";

describe("LmsModuleService — module key", () => {
  it("exports the canonical module key", () => {
    expect(LMS_MODULE).toBe("lms");
  });
});

/**
 * In-memory harness: construct the service and shadow the MedusaService CRUD
 * methods with a fake store that enforces the (order_id) unique index, so we
 * can unit-test the durable-row + idempotency + heal logic without a DB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeService(): { service: LmsModuleService; rows: any[] } {
  // Build an instance WITHOUT running the MedusaService base constructor
  // (which needs a DI container). Prototype methods + our shadowed CRUD
  // mocks are all the logic under test needs.
  const service = Object.create(
    LmsModuleService.prototype,
  ) as LmsModuleService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  let idc = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).createLabJobs = jest.fn(async (data: any) => {
    if (rows.some((r) => r.order_id === data.order_id)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const err: any = new Error(
        'duplicate key value violates unique constraint "UQ_lab_job_order_id_active"',
      );
      err.code = "23505";
      throw err;
    }
    const row = {
      id: `labjob_${++idc}`,
      provider_job_id: null,
      provider_name: null,
      submitted_at: null,
      created_at: new Date(Date.now() + idc),
      updated_at: new Date(),
      attempts: 0,
      last_error: null,
      ...data,
    };
    rows.push(row);
    return row;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).listLabJobs = jest.fn(async (selector: any = {}) =>
    rows.filter((r) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Object.entries(selector).every(([k, v]) => (r as any)[k] === v),
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).retrieveLabJob = jest.fn(async (id: string) =>
    rows.find((r) => r.id === id),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).updateLabJobs = jest.fn(async ({ selector, data }: any) => {
    const matched = rows.filter((r) => r.id === selector.id);
    matched.forEach((r) => Object.assign(r, data));
    return matched;
  });

  return { service, rows };
}

const PACKET: LabJobPacket = {
  job_ref: "klear-order_1",
  klear_order_id: "order_1",
  frame_sku: "KLR-1",
  lens_type: "single_vision",
  lens_index: 1.67,
  coating_addons: [],
  prescription: {
    sph_right: -1,
    sph_left: -1,
    cyl_right: 0,
    cyl_left: 0,
    axis_right: null,
    axis_left: null,
    add_right: null,
    add_left: null,
    pd_right: 31,
    pd_left: 31,
  },
  customer: {
    name: "A B",
    phone: "+66800000000",
    delivery_address: {
      line1: "x",
      city: "c",
      province: "p",
      postal_code: "10110",
      country_code: "TH",
    },
  },
  submitted_at: new Date().toISOString(),
};

const okResult: BuildPacketResult = { outcome: "ok", packet: PACKET };
const pendingResult: BuildPacketResult = {
  outcome: "pending_rx",
  reason: "awaiting customer prescription",
  snapshot: {
    job_ref: "klear-order_1",
    klear_order_id: "order_1",
    frame_sku: "KLR-1",
    lens_type: "single_vision",
  },
};
const failedResult: BuildPacketResult = {
  outcome: "failed",
  reason: "unknown lens type: \"magic\"",
  snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
};

describe("LmsModuleService.createFromBuild", () => {
  it("creates a queued row for an ok build", async () => {
    const { service } = makeService();
    const job = await service.createFromBuild(okResult);
    expect(job).not.toBeNull();
    expect(job!.status).toBe("queued");
    expect(job!.last_error).toBeNull();
    expect(job!.packet_snapshot).toEqual(PACKET);
  });

  it("creates a pending_rx row carrying the reason", async () => {
    const { service } = makeService();
    const job = await service.createFromBuild(pendingResult);
    expect(job!.status).toBe("pending_rx");
    expect(job!.last_error).toMatch(/awaiting customer prescription/);
  });

  it("creates a failed row carrying the reason", async () => {
    const { service } = makeService();
    const job = await service.createFromBuild(failedResult);
    expect(job!.status).toBe("failed");
    expect(job!.last_error).toMatch(/unknown lens type/);
  });

  it("returns null (no row) for a skip", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild({
      outcome: "skip",
      order_id: "order_1",
      reason: "frame-only",
    });
    expect(job).toBeNull();
    expect(rows).toHaveLength(0);
  });

  it("tolerates a concurrent duplicate insert (unique violation → existing row)", async () => {
    const { service, rows } = makeService();
    const first = await service.createFromBuild(okResult);
    const second = await service.createFromBuild(okResult);
    expect(rows).toHaveLength(1);
    expect(second!.id).toBe(first!.id);
  });
});

describe("LmsModuleService.updateJobFromBuild — retry heal path", () => {
  it("heals a pending_rx row to queued once the rebuild yields a packet", async () => {
    const { service } = makeService();
    const pending = await service.createFromBuild(pendingResult);
    expect(pending!.status).toBe("pending_rx");

    const healed = await service.updateJobFromBuild(pending!.id, okResult);
    expect(healed.status).toBe("queued");
    expect(healed.last_error).toBeNull();
    expect(healed.packet_snapshot).toEqual(PACKET);
  });

  it("keeps a failed row failed when the rebuild still fails, refreshing the reason", async () => {
    const { service } = makeService();
    const failed = await service.createFromBuild(failedResult);
    const again = await service.updateJobFromBuild(failed!.id, {
      outcome: "failed",
      reason: "still broken: no phone",
      snapshot: { job_ref: "klear-order_1", klear_order_id: "order_1" },
    });
    expect(again.status).toBe("failed");
    expect(again.last_error).toMatch(/still broken/);
  });
});
