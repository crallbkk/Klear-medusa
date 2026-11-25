import {
  ACTIONS,
  STAGES,
  STAGE_ACTIONS,
  ProductionError,
  WRITE_OFF_REASON_MAX,
  bangkokDate,
  decide,
  quoteState,
  writeOffRefusal,
  type JobState,
  type ProductionAction,
  type QuoteState,
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
    expect(ACTIONS.length).toBe(STAGE_ACTIONS.length + 10);
  });
});

describe("production rules: writing off a lab quote", () => {
  const good = { lab_cost_id: "labcost_01ABC", reason: "  remake, the lab does not bill it  " };

  it("names the quote and keeps the reason off the event", () => {
    const effect = decide(job("mounted"), "LAB_QUOTE_WRITTEN_OFF", good);
    expect(effect.to_stage).toBeUndefined();
    expect(effect.patch).toEqual({});
    expect(effect.usage).toEqual([]);
    expect(effect.write_off_cost).toEqual({
      lab_cost_id: "labcost_01ABC",
      reason: "remake, the lab does not bill it",
    });
    // The reason is about the quote and is stored on it, not in the
    // history a lab account reads.
    expect(effect.detail).toEqual({ lab_cost_id: "labcost_01ABC" });
    expect(JSON.stringify(effect.detail)).not.toMatch(/remake/);
  });

  it("is possible at any stage once the job is in production, cancelled and on hold included", () => {
    for (const stage of STAGES) {
      expect(() => decide(job(stage), "LAB_QUOTE_WRITTEN_OFF", good)).not.toThrow();
    }
    expect(() => decide(job("edged", { on_hold: true }), "LAB_QUOTE_WRITTEN_OFF", good)).not.toThrow();
    expect(() => decide(job(null), "LAB_QUOTE_WRITTEN_OFF", good)).toThrow(ProductionError);
  });

  it("needs a quote and a reason that is short, trimmed and not empty", () => {
    for (const bad of [
      { reason: "x" },
      { lab_cost_id: "", reason: "x" },
      { lab_cost_id: 42, reason: "x" },
      { lab_cost_id: "labjob_01ABC", reason: "x" },
      { lab_cost_id: "labcost_01ABC" },
      { lab_cost_id: "labcost_01ABC", reason: "   " },
      { lab_cost_id: "labcost_01ABC", reason: 7 },
      { lab_cost_id: "labcost_01ABC", reason: "x".repeat(WRITE_OFF_REASON_MAX + 1) },
    ]) {
      let caught: unknown;
      try {
        decide(job("mounted"), "LAB_QUOTE_WRITTEN_OFF", bad);
      } catch (err) {
        caught = err;
      }
      expect([bad, (caught as ProductionError)?.code]).toEqual([bad, "invalid_detail"]);
    }
    expect(() =>
      decide(job("mounted"), "LAB_QUOTE_WRITTEN_OFF", {
        lab_cost_id: "labcost_01ABC",
        reason: "x".repeat(WRITE_OFF_REASON_MAX),
      }),
    ).not.toThrow();
  });

  it("measures the reason after trimming it", () => {
    const padded = `  ${"x".repeat(WRITE_OFF_REASON_MAX)}  `;
    expect(
      decide(job("mounted"), "LAB_QUOTE_WRITTEN_OFF", { lab_cost_id: "labcost_1", reason: padded }).write_off_cost
        ?.reason,
    ).toBe("x".repeat(WRITE_OFF_REASON_MAX));
    expect(() =>
      decide(job("mounted"), "LAB_QUOTE_WRITTEN_OFF", {
        lab_cost_id: "labcost_1",
        reason: ` ${"x".repeat(WRITE_OFF_REASON_MAX + 1)} `,
      }),
    ).toThrow(ProductionError);
    // Every free-text field is measured the same way.
    expect(decide(job("ready"), "NOTE", { text: ` ${"n".repeat(2000)} ` }).detail).toEqual({
      text: "n".repeat(2000),
    });
    expect(decide(job("mounted"), "QC_FAILED", { reason: ` ${"q".repeat(500)} ` }).detail).toEqual({
      reason: "q".repeat(500),
    });
  });

  it("allows it only from 'back, not invoiced', and says why not otherwise", () => {
    const at = new Date("2026-11-20T03:00:00Z");
    const q = (over: Partial<QuoteState>): QuoteState => ({
      received_at: null,
      invoiced_satang: null,
      written_off_at: null,
      ...over,
    });
    expect(quoteState(q({}))).toBe("sent");
    expect(quoteState(q({ received_at: at }))).toBe("back_not_invoiced");
    expect(quoteState(q({ received_at: at, written_off_at: at }))).toBe("written_off");
    expect(quoteState(q({ received_at: at, invoiced_satang: 0 }))).toBe("invoiced");
    // An invoice entered before the work was marked back.
    expect(quoteState(q({ invoiced_satang: 100 }))).toBe("invoiced");
    // An invoice that came after a write-off reversed it.
    expect(quoteState(q({ received_at: at, written_off_at: at, invoiced_satang: 100 }))).toBe("invoiced");

    expect(writeOffRefusal(q({ received_at: at }))).toBeNull();
    for (const [quote, code] of [
      [q({}), "quote_not_back"],
      [q({ received_at: at, invoiced_satang: 100 }), "quote_invoiced"],
      [q({ invoiced_satang: 100 }), "quote_invoiced"],
      [q({ received_at: at, written_off_at: at }), "quote_written_off"],
      [q({ received_at: at, written_off_at: at, invoiced_satang: 1 }), "quote_invoiced"],
    ] as const) {
      const refusal = writeOffRefusal(quote);
      expect(refusal).toBeInstanceOf(ProductionError);
      expect([quote, refusal?.code]).toEqual([quote, code]);
    }
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

describe("production rules: a lab invoice", () => {
  it("may name the quote it is for, and otherwise leaves the choice to the writer", () => {
    expect(decide(job("mounted"), "LAB_INVOICED", { invoiced_satang: 100 })).toMatchObject({
      invoice_cost: { invoiced_satang: 100 },
      detail: { invoiced_satang: 100 },
    });
    expect(decide(job("mounted"), "LAB_INVOICED", { invoiced_satang: 100 }).invoice_cost?.lab_cost_id).toBeUndefined();
    expect(
      decide(job("mounted"), "LAB_INVOICED", { invoiced_satang: 100, lab_cost_id: "labcost_01B" }),
    ).toMatchObject({
      invoice_cost: { invoiced_satang: 100, lab_cost_id: "labcost_01B" },
      detail: { invoiced_satang: 100, lab_cost_id: "labcost_01B" },
    });
    for (const lab_cost_id of ["", "labjob_1", 7, null]) {
      expect(() => decide(job("mounted"), "LAB_INVOICED", { invoiced_satang: 1, lab_cost_id })).toThrow(
        ProductionError,
      );
    }
  });
});

describe("production rules: a job on hold", () => {
  it("refuses every step a person takes that moves the job, until it is released", () => {
    for (const [action, t] of Object.entries(TABLE) as [ProductionAction, (typeof TABLE)["READY"]][]) {
      const system = ["READY", "LABELLED", "LABEL_CANCELLED", "DELIVERED", "RX_CHANGED", "CANCELLED"].includes(action);
      for (const from of t.from) {
        const held = job(from, { on_hold: true });
        if (system) {
          // The order's own events are facts; a hold does not stop them.
          expect(() => decide(held, action, DETAIL[action] ?? {})).not.toThrow();
        } else {
          expect(() => decide(held, action, DETAIL[action] ?? {})).toThrow(/on hold/);
        }
      }
    }
  });

  it("still takes a note, a broken frame, a lab invoice and the release itself", () => {
    const held = job("edged", { on_hold: true });
    expect(() => decide(held, "NOTE", { text: "t" })).not.toThrow();
    expect(() =>
      decide(held, "LAB_QUOTE_WRITTEN_OFF", { lab_cost_id: "labcost_1", reason: "r" }),
    ).not.toThrow();
    expect(() => decide(held, "FRAME_DAMAGED", { sku: "KLR-1", reason: "r" })).not.toThrow();
    expect(() => decide(held, "LAB_INVOICED", { invoiced_satang: 1 })).not.toThrow();
    expect(decide(held, "RELEASE").patch).toEqual({ on_hold: false, hold_reason: null });
  });
});

describe("bangkokDate", () => {
  it("gives the Bangkok calendar day of an instant", () => {
    expect(bangkokDate(new Date("2026-11-30T16:59:59Z"))).toBe("2026-11-30");
    expect(bangkokDate(new Date("2026-11-30T17:00:00Z"))).toBe("2026-12-01");
  });
});
