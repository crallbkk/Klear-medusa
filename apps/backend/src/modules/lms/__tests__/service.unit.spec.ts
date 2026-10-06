import LmsModuleService, { LMS_MODULE } from "../service";
import { LabProviderError } from "../types";
import type { BuildPacketResult, LabJobPacket } from "../types";

describe("LmsModuleService — module key", () => {
  it("exports the canonical module key", () => {
    expect(LMS_MODULE).toBe("lms");
  });
});

/**
 * In-memory harness: construct the service and shadow the MedusaService CRUD
 * methods with a fake store that enforces the (order_id) unique index and
 * FULL selector matching (needed for the status-guarded submit claim), so we
 * can unit-test the durable-row + idempotency + claim + heal logic without a
 * DB.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeService(provider?: {
  submitJob: (packet: unknown) => Promise<{ provider_job_id: string }>;
  name?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}): { service: LmsModuleService; rows: any[] } {
  // Build an instance WITHOUT running the MedusaService base constructor
  // (which needs a DI container). Prototype methods + our shadowed CRUD
  // mocks are all the logic under test needs.
  const service = Object.create(
    LmsModuleService.prototype,
  ) as LmsModuleService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = [];
  let idc = 0;

  if (provider) {
    // Class fields are constructor-assigned, and we skipped the constructor —
    // inject the provider directly for submit-path tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).provider = {
      name: provider.name ?? "fake-lab",
      submitJob: provider.submitJob,
      getJobStatus: async () => {
        throw new Error("not used");
      },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const matches = (row: any, selector: any) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Object.entries(selector).every(([k, v]) => (row as any)[k] === v);

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
      rx_redacted_at: null,
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
    rows.filter((r) => matches(r, selector)),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).retrieveLabJob = jest.fn(async (id: string) =>
    rows.find((r) => r.id === id),
  );
  // Selector-guarded update, like the real thing: only rows matching EVERY
  // selector key are updated — this is what the submit claim relies on.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (service as any).updateLabJobs = jest.fn(async ({ selector, data }: any) => {
    const matched = rows.filter((r) => matches(r, selector));
    // Like the real repository (`manager.assign(..., { mergeObjectProperties:
    // true })`): a JSON column is MERGED key by key into what the row holds,
    // not replaced. A null in the patch overwrites; a missing key is kept.
    matched.forEach((r) => {
      const { packet_snapshot, ...scalars } = data;
      Object.assign(r, scalars, { updated_at: new Date() });
      if (packet_snapshot !== undefined) {
        r.packet_snapshot = { ...(r.packet_snapshot ?? {}), ...packet_snapshot };
      }
    });
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

  it("skips the write when a still-waiting pending_rx job rebuilds unchanged", async () => {
    const { service } = makeService();
    const pending = await service.createFromBuild(pendingResult);
    expect(pending!.status).toBe("pending_rx");
    const writesBefore = ((service as any).updateLabJobs as jest.Mock).mock.calls
      .length;

    // Same pending_rx result again — nothing meaningful changed.
    const again = await service.updateJobFromBuild(pending!.id, pendingResult);

    expect(again.status).toBe("pending_rx");
    // No write performed — updated_at is not churned on an unchanged sweep pass.
    expect(((service as any).updateLabJobs as jest.Mock).mock.calls.length).toBe(
      writesBefore,
    );
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

  it("refuses to rebuild a SUBMITTED row (audit trail protection)", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    rows.find((r) => r.id === job!.id)!.status = "submitted";
    await expect(
      service.updateJobFromBuild(job!.id, okResult),
    ).rejects.toThrow(/only queued\/failed\/pending_rx/);
  });

  it("refuses to rebuild a CANCELLED row", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    rows.find((r) => r.id === job!.id)!.status = "cancelled";
    await expect(
      service.updateJobFromBuild(job!.id, okResult),
    ).rejects.toThrow(/only queued\/failed\/pending_rx/);
  });
});

describe("LmsModuleService.submitJob — atomic claim", () => {
  it("two interleaved submit calls result in exactly ONE provider call", async () => {
    let providerCalls = 0;
    const { service } = makeService({
      submitJob: async () => {
        providerCalls += 1;
        // Hold the winner in-flight across a macrotask so the loser fully
        // runs its read + claim while the provider call is outstanding.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { provider_job_id: "prov_1" };
      },
    });
    const job = await service.createFromBuild(okResult);

    const [a, b] = await Promise.all([
      service.submitJob(job!.id),
      service.submitJob(job!.id),
    ]);

    expect(providerCalls).toBe(1);
    const outcomes = [a.outcome, b.outcome].sort();
    // Exactly one winner submits; the loser backs off without touching the
    // provider ("already_submitting", or "submitted" if it re-read after the
    // winner finished).
    expect(outcomes).toContain("submitted");
    expect(
      outcomes.filter((o) => o === "already_submitting" || o === "submitted"),
    ).toHaveLength(2);
  });

  it("releases the claim back to queued when no provider is wired", async () => {
    const { service, rows } = makeService({
      submitJob: async () => {
        throw new LabProviderError("not_implemented", "no lab partner yet");
      },
      name: "unimplemented",
    });
    const job = await service.createFromBuild(okResult);
    const result = await service.submitJob(job!.id);
    expect(result.outcome).toBe("queued_no_provider");
    expect(rows.find((r) => r.id === job!.id)!.status).toBe("queued");
    expect(rows.find((r) => r.id === job!.id)!.attempts).toBe(1);
  });

  it("marks the job failed when the provider rejects", async () => {
    const { service, rows } = makeService({
      submitJob: async () => {
        throw new Error("lab rejected: axis out of range");
      },
    });
    const job = await service.createFromBuild(okResult);
    const result = await service.submitJob(job!.id);
    expect(result.outcome).toBe("failed");
    expect(rows.find((r) => r.id === job!.id)!.status).toBe("failed");
    expect(rows.find((r) => r.id === job!.id)!.last_error).toMatch(
      /axis out of range/,
    );
  });

  it("rejects direct submission of failed / pending_rx rows (heal via retry)", async () => {
    const { service, rows } = makeService({
      submitJob: async () => ({ provider_job_id: "prov_x" }),
    });
    const job = await service.createFromBuild(okResult);
    const row = rows.find((r) => r.id === job!.id)!;

    row.status = "failed";
    await expect(service.submitJob(job!.id)).rejects.toThrow(/heal via retry/);

    row.status = "pending_rx";
    await expect(service.submitJob(job!.id)).rejects.toThrow(/pending_rx/);
  });
});

describe("LmsModuleService.redactJobRx — blanking the readable prescription", () => {
  it("blanks ONLY the prescription, keeps the rest of the snapshot, and stamps the time", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    expect(rows[0].packet_snapshot.prescription).not.toBeNull();

    await expect(service.redactJobRx(job!.id)).resolves.toBe(true);

    expect(rows[0].packet_snapshot.prescription).toBeNull();
    expect(rows[0].rx_redacted_at).toBeInstanceOf(Date);
    // Nothing else is lost: the audit trail still says what was ordered and
    // where it went.
    const { prescription: _gone, ...restAfter } = rows[0].packet_snapshot;
    const { prescription: _was, ...restBefore } = PACKET;
    expect(restAfter).toEqual(restBefore);
    expect(rows[0].status).toBe("queued");
    // No dioptre value survives anywhere on the row.
    expect(JSON.stringify(rows[0])).not.toMatch(/sph_|cyl_|pd_right|pd_left/);
  });

  it("does not mutate the packet object it was given (the build result is reused by callers)", async () => {
    const { service } = makeService();
    const job = await service.createFromBuild(okResult);
    await service.redactJobRx(job!.id);
    expect(PACKET.prescription).not.toBeNull();
  });

  it("is a no-op the second time", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    await service.redactJobRx(job!.id);
    const stamped = rows[0].rx_redacted_at;
    await expect(service.redactJobRx(job!.id)).resolves.toBe(false);
    expect(rows[0].rx_redacted_at).toBe(stamped);
  });

  it("patches the JSON column with the prescription key only, so a rebuild landing in between is not overwritten with stale keys", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    await service.redactJobRx(job!.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const write = (service as any).updateLabJobs.mock.calls.at(-1)[0];
    expect(write.data.packet_snapshot).toEqual({ prescription: null });
    expect(rows[0].packet_snapshot.frame_sku).toBe("KLR-1");
  });

  it("blanks a row ORPHANED in submitting by a crash (a day old), which would otherwise keep its prescription for good", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    rows[0].status = "submitting";
    rows[0].updated_at = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await expect(service.redactJobRx(job!.id)).resolves.toBe(true);
    expect(rows[0].packet_snapshot.prescription).toBeNull();
    expect(rows[0].status).toBe("submitting");
  });

  it("refuses a job mid-submission and leaves its prescription intact", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    rows[0].status = "submitting";
    await expect(service.redactJobRx(job!.id)).resolves.toBe(false);
    expect(rows[0].packet_snapshot.prescription).toEqual(PACKET.prescription);
    expect(rows[0].rx_redacted_at).toBeNull();
  });

  it("writes nothing if the job is claimed for submission between the read and the write", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(okResult);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const realRetrieve = (service as any).retrieveLabJob;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).retrieveLabJob = jest.fn(async (id: string) => {
      const row = await realRetrieve(id);
      const seen = { ...row };
      row.status = "submitting"; // another worker claims it right after our read
      return seen;
    });
    await expect(service.redactJobRx(job!.id)).resolves.toBe(false);
    expect(rows[0].packet_snapshot.prescription).toEqual(PACKET.prescription);
    expect(rows[0].rx_redacted_at).toBeNull();
  });

  it("stamps a job that has no prescription to blank (pending or failed snapshot), so the sweep stops re-reading it", async () => {
    const { service, rows } = makeService();
    const job = await service.createFromBuild(failedResult);
    await expect(service.redactJobRx(job!.id)).resolves.toBe(true);
    expect(rows[0].packet_snapshot.prescription).toBeNull();
    expect(rows[0].packet_snapshot.klear_order_id).toBe("order_1");
    expect(rows[0].rx_redacted_at).toBeInstanceOf(Date);
  });

  it("throws for an unknown job", async () => {
    const { service } = makeService();
    await expect(service.redactJobRx("labjob_nope")).rejects.toThrow(/not found/);
  });
});

describe("LmsModuleService — a blanked job cannot reach the lab without its prescription", () => {
  it("submitJob refuses a blanked job and never calls the provider", async () => {
    const submit = jest.fn(async () => ({ provider_job_id: "lab_1" }));
    const { service, rows } = makeService({ submitJob: submit });
    const job = await service.createFromBuild(okResult);
    await service.redactJobRx(job!.id);

    await expect(service.submitJob(job!.id)).rejects.toThrow(/prescription blanked/);
    expect(submit).not.toHaveBeenCalled();
    expect(rows[0].status).toBe("queued");
  });

  it("a rebuild writes the prescription back and clears the stamp, and the job can then be submitted", async () => {
    const submit = jest.fn(async () => ({ provider_job_id: "lab_1" }));
    const { service, rows } = makeService({ submitJob: submit });
    const job = await service.createFromBuild(okResult);
    await service.redactJobRx(job!.id);

    await service.updateJobFromBuild(job!.id, okResult);
    expect(rows[0].rx_redacted_at).toBeNull();
    expect(rows[0].packet_snapshot.prescription).toEqual(PACKET.prescription);

    const r = await service.submitJob(job!.id);
    expect(r.outcome).toBe("submitted");
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ prescription: PACKET.prescription }),
    );
  });
});

describe("LmsModuleService.listJobsHoldingRx", () => {
  it("returns only jobs not yet blanked, asking for ids and dates and never the snapshot", async () => {
    const { service, rows } = makeService();
    const a = await service.createFromBuild(okResult);
    rows.push({ ...rows[0], id: "labjob_other", order_id: "order_2" });
    await service.redactJobRx(a!.id);

    const held = await service.listJobsHoldingRx();
    expect(held.map((j) => j.id)).toEqual(["labjob_other"]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [selector, cfg] = (service as any).listLabJobs.mock.calls.at(-1);
    expect(selector).toEqual({ rx_redacted_at: null });
    expect(cfg.select).not.toContain("packet_snapshot");
    expect(cfg.order).toEqual({ created_at: "ASC", id: "ASC" });
  });

  it("pages through more than one page", async () => {
    const { service } = makeService();
    const row = (i: number) => ({
      id: `j${i}`,
      order_id: `o${i}`,
      status: "queued",
      created_at: new Date(),
      updated_at: new Date(),
      rx_redacted_at: null,
    });
    const all = Array.from({ length: 1100 }, (_, i) => row(i));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (service as any).listLabJobs = jest.fn(async (_sel: unknown, cfg: any) =>
      all.slice(cfg.skip, cfg.skip + cfg.take),
    );
    const held = await service.listJobsHoldingRx();
    expect(held).toHaveLength(1100);
    expect(new Set(held.map((j) => j.id)).size).toBe(1100);
  });
});
