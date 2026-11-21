import {
  ACTIONS,
  STAGES,
  STAGE_ACTIONS,
  ProductionError,
  bangkokDate,
  decide,
  type JobState,
  type ProductionAction,
  type Stage,
} from "../production";

const job = (stage: Stage | null, over: Partial<JobState> = {}): JobState => ({
  stage,
  remake_count: 0,
  on_hold: false,
  cut_question_pending: false,
  next_issue_reason: "order",
  ...over,
});

// Details that satisfy each action's own checks, so the table below tests
// stages only.
const DETAIL: Partial<Record<ProductionAction, Record<string, unknown>>> = {
  LENS_ISSUED: { lenses: ["LENS-A", "LENS-B"] },
  SENT_TO_LAB: { vendor: "Lab One", quoted_satang: 45000 },
  QC_FAILED: { reason: "axis off" },
  REMAKE_STARTED: { cause: "edging error" },
  LENS_SPOILED: { reason: "chipped" },
};

// The design's transition table (section 10.2), written out in full: every
// stage-changing action, the stages it is allowed from, and where it leads.
const TABLE: Record<(typeof STAGE_ACTIONS)[number], { from: (Stage | null)[]; to: Stage }> = {
  READY: { from: [null], to: "ready" },
  PRINTED: { from: ["ready"], to: "printed" },
  LENS_ISSUED: { from: ["printed"], to: "lens_issued" },
  SENT_TO_LAB: { from: ["printed"], to: "sent_to_lab" },
  RECEIVED_FROM_LAB: { from: ["sent_to_lab"], to: "received_from_lab" },
  EDGED: { from: ["lens_issued"], to: "edged" },
  MOUNTED: { from: ["edged", "received_from_lab"], to: "mounted" },
  QC_PASSED: { from: ["mounted"], to: "qc_passed" },
  QC_FAILED: { from: ["mounted"], to: "qc_failed" },
  REMAKE_STARTED: { from: ["qc_failed", "labelled", "delivered"], to: "printed" },
  REWORK: { from: ["qc_failed"], to: "edged" },
  LENS_SPOILED: { from: ["lens_issued", "edged", "mounted"], to: "printed" },
  PACKED: { from: ["qc_passed"], to: "packed" },
  LABELLED: { from: ["packed"], to: "labelled" },
  LABEL_CANCELLED: { from: ["labelled"], to: "packed" },
  DELIVERED: { from: ["labelled"], to: "delivered" },
  RX_CHANGED: {
    from: [
      "ready", "printed", "lens_issued", "sent_to_lab", "received_from_lab",
      "edged", "mounted", "qc_passed", "qc_failed", "packed",
    ],
    to: "ready",
  },
  CANCELLED: {
    from: [
      null, "ready", "printed", "lens_issued", "sent_to_lab", "received_from_lab",
      "edged", "mounted", "qc_passed", "qc_failed", "packed",
    ],
    to: "cancelled",
  },
};

describe("production rules: the transition table", () => {
  const everyStage: (Stage | null)[] = [null, ...STAGES];

  for (const action of STAGE_ACTIONS) {
    for (const stage of everyStage) {
      const allowed = TABLE[action].from.includes(stage);
      it(`${action} from ${stage ?? "no stage"} is ${allowed ? `allowed, to ${TABLE[action].to}` : "refused"}`, () => {
        if (allowed) {
          expect(decide(job(stage), action, DETAIL[action]).to_stage).toBe(TABLE[action].to);
        } else {
          expect(() => decide(job(stage), action, DETAIL[action])).toThrow(ProductionError);
          try {
            decide(job(stage), action, DETAIL[action]);
          } catch (err) {
            expect((err as ProductionError).code).toBe("not_allowed");
          }
        }
      });
    }
  }

  it("covers every action the module declares", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...STAGE_ACTIONS].sort());
    expect(ACTIONS.length).toBe(STAGE_ACTIONS.length + 9);
  });
});

describe("production rules: what an action records", () => {
  it("books each issued lens under the job's current reason", () => {
    expect(decide(job("printed"), "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] }).usage).toEqual([
      { sku: "LENS-A", reason: "order", qty: -1 },
      { sku: "LENS-B", reason: "order", qty: -1 },
    ]);
    expect(
      decide(job("printed", { next_issue_reason: "remake" }), "LENS_ISSUED", { lenses: ["LENS-A"] })
        .usage,
    ).toEqual([{ sku: "LENS-A", reason: "remake", qty: -1 }]);
  });

  it("refuses a lens issue with no lens, three lenses, or a SKU that is not a SKU", () => {
    for (const lenses of [undefined, [], ["A1", "A2", "A3"], ["lens a"], [42], [""]]) {
      expect(() => decide(job("printed"), "LENS_ISSUED", { lenses })).toThrow(/lens|SKU/);
    }
  });

  it("makes the lens after a spoiled one a spoilage replacement", () => {
    for (const stage of ["lens_issued", "edged", "mounted"] as const) {
      expect(decide(job(stage), "LENS_SPOILED", { reason: "chipped" }).patch).toEqual({
        next_issue_reason: "spoilage_replacement",
      });
    }
  });

  it("counts a remake, as spoilage after a QC failure and as a warranty remake after shipping", () => {
    expect(decide(job("qc_failed"), "REMAKE_STARTED", { cause: "x" }).patch).toEqual({
      remake_count: 1,
      next_issue_reason: "spoilage_replacement",
    });
    expect(
      decide(job("delivered", { remake_count: 1 }), "REMAKE_STARTED", { cause: "x" }).patch,
    ).toEqual({ remake_count: 2, next_issue_reason: "remake" });
  });

  it("asks the cut-or-uncut question only for a lens issued and not yet edged", () => {
    // The reason is not touched here: the answer to the question decides it.
    expect(decide(job("lens_issued"), "RX_CHANGED").patch).toEqual({
      cut_question_pending: true,
    });
    expect(decide(job("ready", { cut_question_pending: true }), "LENS_CUT_CONFIRMED").patch).toEqual({
      cut_question_pending: false,
      next_issue_reason: "remake",
    });
    expect(
      decide(job("ready", { cut_question_pending: true }), "LENS_RETURNED_UNUSED", {
        lenses: ["LENS-A"],
      }),
    ).toMatchObject({ patch: { cut_question_pending: false }, return_lenses: ["LENS-A"] });
    // A cancelled job has no next issue to book.
    expect(
      decide(job("cancelled", { cut_question_pending: true }), "LENS_CUT_CONFIRMED").patch,
    ).toEqual({ cut_question_pending: false });
    expect(decide(job("lens_issued"), "CANCELLED").patch).toMatchObject({
      cut_question_pending: true,
    });
    expect(decide(job("edged"), "RX_CHANGED").patch).toEqual({ next_issue_reason: "remake" });
    expect(decide(job("printed"), "RX_CHANGED").patch).toEqual({});
    expect(decide(job("sent_to_lab"), "RX_CHANGED").patch).toEqual({});
  });

  it("takes a frame broken in the lab off the shelf as spoilage", () => {
    expect(decide(job("mounted"), "FRAME_DAMAGED", { sku: "KLR-1", reason: "snapped" }).usage).toEqual([
      { sku: "KLR-1", reason: "spoilage", qty: -1 },
    ]);
    for (const stage of [null, "cancelled", "delivered"] as const) {
      expect(() => decide(job(stage), "FRAME_DAMAGED", { sku: "KLR-1", reason: "x" })).toThrow();
    }
  });

  it("opens a quote with a vendor, a whole number of satang and an optional date", () => {
    expect(
      decide(job("printed"), "SENT_TO_LAB", {
        vendor: " Lab One ",
        quoted_satang: 0,
        expected_on: "2026-11-27",
      }).open_cost,
    ).toEqual({ vendor: "Lab One", quoted_satang: 0, expected_on: "2026-11-27" });
    for (const bad of [
      { quoted_satang: 1 },
      { vendor: "L", quoted_satang: 1.5 },
      { vendor: "L", quoted_satang: -1 },
      { vendor: "L", quoted_satang: "450" },
      { vendor: "L", quoted_satang: 1, expected_on: "27/11/2026" },
      { vendor: "L", quoted_satang: 1, expected_on: "2026-02-31" },
    ]) {
      expect(() => decide(job("printed"), "SENT_TO_LAB", bad)).toThrow(ProductionError);
    }
  });

  it("stores only the fields an action names, never the whole input", () => {
    const effect = decide(job("mounted"), "QC_FAILED", {
      reason: "axis off",
      prescription: { sph_right: -2.25 },
    });
    expect(effect.detail).toEqual({ reason: "axis off" });
  });

  it("holds once, releases once, and never holds a finished job", () => {
    expect(decide(job("ready"), "HOLD", { reason: "no stock" }).patch).toEqual({
      on_hold: true,
      hold_reason: "no stock",
    });
    expect(() => decide(job("ready", { on_hold: true }), "HOLD", { reason: "x" })).toThrow();
    expect(() => decide(job("ready"), "RELEASE")).toThrow();
    expect(() => decide(job("delivered"), "HOLD", { reason: "x" })).toThrow();
    expect(() => decide(job("cancelled"), "HOLD", { reason: "x" })).toThrow();
    expect(decide(job("printed", { on_hold: true }), "CANCELLED").patch).toMatchObject({
      on_hold: false,
      hold_reason: null,
    });
  });
});

describe("production rules: an open cut-or-uncut question", () => {
  it("stops the job being printed, issued or sent out until it is answered", () => {
    const open = { cut_question_pending: true };
    expect(() => decide(job("ready", open), "PRINTED")).toThrow(/cut/);
    expect(() =>
      decide(job("printed", open), "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] }),
    ).toThrow(/cut/);
    expect(() =>
      decide(job("printed", open), "SENT_TO_LAB", { vendor: "L", quoted_satang: 1 }),
    ).toThrow(/cut/);
    // Notes, holds and a cancel are still possible.
    expect(decide(job("ready", open), "NOTE", { text: "x" }).detail).toEqual({ text: "x" });
    expect(decide(job("ready", open), "CANCELLED").to_stage).toBe("cancelled");
  });
});

describe("bangkokDate", () => {
  it("gives the Bangkok calendar day of an instant", () => {
    expect(bangkokDate(new Date("2026-11-30T16:59:59Z"))).toBe("2026-11-30");
    expect(bangkokDate(new Date("2026-11-30T17:00:00Z"))).toBe("2026-12-01");
  });
});
