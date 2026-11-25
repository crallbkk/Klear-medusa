import {
  OVERDUE_AFTER_HOURS,
  OVERDUE_WAITING_HOURS,
  alsoOffered,
  boardColumn,
  isOverdue,
  packetProblem,
  reportFrom,
} from "../board";
import {
  ACTIONS,
  ProductionError,
  STAGES,
  SYSTEM_ONLY_ACTIONS,
  decide,
  offeredActions,
  type JobState,
  type PacketState,
  type ProductionAction,
  type Stage,
} from "../production";

type Job = JobState & PacketState;
const state = (stage: Stage | null, over: Partial<Job> = {}): Job => ({
  stage,
  remake_count: 0,
  on_hold: false,
  cut_question_pending: false,
  next_issue_reason: "order",
  status: "queued",
  ...over,
});

// Details good enough for every action, written here and not taken from
// the code under test.
const GOOD: Partial<Record<ProductionAction, Record<string, unknown>>> = {
  LENS_ISSUED: { lenses: ["LENS-A"] },
  SENT_TO_LAB: { vendor: "Lab One", quoted_satang: 1 },
  QC_FAILED: { reason: "r" },
  REMAKE_STARTED: { cause: "c" },
  LENS_SPOILED: { reason: "r" },
  FRAME_DAMAGED: { sku: "FRAME-A", reason: "r" },
  LENS_RETURNED_UNUSED: { lenses: ["LENS-A"] },
  HOLD: { reason: "r" },
  LAB_INVOICED: { invoiced_satang: 1 },
  LAB_QUOTE_WRITTEN_OFF: { lab_cost_id: "labcost_1", reason: "r" },
  NOTE: { text: "t" },
};

describe("the buttons a job offers", () => {
  const everyState: Job[] = [];
  for (const stage of [null, ...STAGES]) {
    for (const on_hold of [false, true]) {
      for (const cut_question_pending of [false, true]) {
        everyState.push(state(stage, { on_hold, cut_question_pending }));
      }
    }
  }

  // The writer has gates the stage rules do not know: whether there is a
  // packet to work from. A button it would refuse must not be shown.
  // (`screens.db-suite` walks every offer against the real writer.)
  it("does not offer Mark printed while the packet is not built", () => {
    for (const status of ["pending_rx", "failed", "cancelled"]) {
      expect(offeredActions(state("ready", { status })).includes("PRINTED")).toBe(false);
    }
    for (const status of ["queued", "submitting", "submitted"]) {
      expect(offeredActions(state("ready", { status })).includes("PRINTED")).toBe(true);
    }
  });

  it("does not offer Mark printed on a packet whose prescription was removed", () => {
    // The packet cannot be shown, so there is nothing to print from. The
    // way out is to rebuild it, which the screen then offers.
    const blanked = state("ready", { rx_redacted_at: new Date() });
    expect(offeredActions(blanked).includes("PRINTED")).toBe(false);
    expect(alsoOffered(blanked)).toEqual({
      packet: false,
      retry: true,
      rx_changed: true,
      warranty_remake: false,
    });
    // Once the lab has started, a rebuild is no longer possible that way.
    expect(alsoOffered(state("edged", { rx_redacted_at: new Date() })).retry).toBe(false);
    expect(alsoOffered(state("ready")).retry).toBe(false);
  });

  it("does not offer a remake once the prescription was removed, except straight after a QC failure", () => {
    const blanked = { rx_redacted_at: new Date() };
    expect(offeredActions(state("delivered")).includes("REMAKE_STARTED")).toBe(true);
    expect(offeredActions(state("delivered", blanked)).includes("REMAKE_STARTED")).toBe(false);
    expect(offeredActions(state("labelled", blanked)).includes("REMAKE_STARTED")).toBe(false);
    expect(offeredActions(state("qc_failed", blanked)).includes("REMAKE_STARTED")).toBe(true);
  });

  it("offers an action exactly when the stage rules would accept it, with a packet to work from", () => {
    for (const s of everyState) {
      const offered = new Set(offeredActions(s));
      for (const action of ACTIONS) {
        let accepted = true;
        try {
          decide(s, action, GOOD[action] ?? {});
        } catch (err) {
          if (!(err instanceof ProductionError) || err.code !== "not_allowed") throw err;
          accepted = false;
        }
        const person =
          !SYSTEM_ONLY_ACTIONS.has(action) &&
          action !== "PACKET_VIEWED" &&
          action !== "PACKET_PRINTED";
        expect([s, action, offered.has(action)]).toEqual([s, action, accepted && person]);
      }
    }
  });

  it("offers every person's action in at least one state (no action is lost to a bad sample)", () => {
    const seen = new Set(everyState.flatMap((s) => offeredActions(s)));
    for (const action of ACTIONS) {
      if (SYSTEM_ONLY_ACTIONS.has(action) || action.startsWith("PACKET_")) continue;
      expect([action, seen.has(action)]).toEqual([action, true]);
    }
  });

  it("never offers a system action or a packet look as a button", () => {
    for (const s of everyState) {
      for (const a of offeredActions(s)) {
        expect(SYSTEM_ONLY_ACTIONS.has(a)).toBe(false);
        expect(a.startsWith("PACKET_")).toBe(false);
      }
    }
  });
});

describe("the board", () => {
  const row = (over: object = {}) => ({
    stage: "ready" as Stage | null,
    status: "queued",
    on_hold: false,
    cut_question_pending: false,
    ...over,
  });

  it("puts a job in one column: a question, then a packet problem, then on hold, then its stage", () => {
    expect(boardColumn(row())).toBe("ready");
    expect(boardColumn(row({ on_hold: true }))).toBe("on_hold");
    expect(boardColumn(row({ status: "failed", stage: null }))).toBe("packet_failed");
    expect(boardColumn(row({ status: "pending_rx", stage: null }))).toBe("waiting_rx");
    // A changed prescription sends the job back to ready while the packet is rebuilt.
    expect(boardColumn(row({ status: "pending_rx", on_hold: true }))).toBe("waiting_rx");
    expect(boardColumn(row({ stage: "cancelled", cut_question_pending: true }))).toBe("question");
    expect(boardColumn(row({ status: "failed", cut_question_pending: true, on_hold: true }))).toBe(
      "question",
    );
    expect(boardColumn(row({ stage: null }))).toBe("none");
  });

  it("keeps a job the lab has started in its stage, whatever the packet's hand-off says", () => {
    // The glasses are at the edger; a failed hand-off to a provider does
    // not move them, and must not take them out of the stage's count.
    expect(boardColumn(row({ stage: "edged", status: "failed" }))).toBe("edged");
    expect(boardColumn(row({ stage: "edged", status: "pending_rx" }))).toBe("edged");
    expect(boardColumn(row({ stage: "edged", status: "failed", on_hold: true }))).toBe("on_hold");
  });

  it("calls a job with no stage, or an open question, overdue by how long it has waited", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
    const waiting = (h: number) =>
      row({ stage: null, status: "pending_rx", stage_since: null, created_at: ago(h) });
    expect(isOverdue(waiting(OVERDUE_WAITING_HOURS.waiting_rx - 1), now)).toBe(false);
    expect(isOverdue(waiting(OVERDUE_WAITING_HOURS.waiting_rx + 1), now)).toBe(true);
    const failed = (h: number) =>
      row({ stage: null, status: "failed", stage_since: null, created_at: ago(h) });
    expect(isOverdue(failed(OVERDUE_WAITING_HOURS.packet_failed + 1), now)).toBe(true);
    // A cancelled job has no threshold of its own; its open question has.
    const asked = (h: number) =>
      row({ stage: "cancelled", status: "cancelled", cut_question_pending: true, stage_since: ago(h) });
    expect(isOverdue(asked(OVERDUE_WAITING_HOURS.question - 1), now)).toBe(false);
    expect(isOverdue(asked(OVERDUE_WAITING_HOURS.question + 1), now)).toBe(true);
    // A job in a stage is never measured from its creation.
    expect(isOverdue(row({ stage_since: null, created_at: ago(9999) }), now)).toBe(false);
  });

  it("has a threshold for every stage the lab works in, and none for a finished job", () => {
    for (const stage of STAGES) {
      const finished = stage === "delivered" || stage === "cancelled";
      expect([stage, OVERDUE_AFTER_HOURS[stage] === undefined]).toEqual([stage, finished]);
    }
    for (const h of Object.values(OVERDUE_AFTER_HOURS)) expect(h).toBeGreaterThan(0);
  });

  it("calls a job overdue once it has sat in its stage longer than the threshold", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const hours = OVERDUE_AFTER_HOURS.ready!;
    const since = (h: number) => new Date(now.getTime() - h * 3600_000);
    expect(isOverdue(row({ stage_since: since(hours - 1) }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: since(hours) }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: since(hours + 1) }), now)).toBe(true);
    // The database hands a time back as text on some paths.
    expect(isOverdue(row({ stage_since: since(hours + 1).toISOString() }), now)).toBe(true);
  });

  it("does not call overdue a job that is held, finished, or has no stage or time", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const old = new Date("2026-01-01T00:00:00Z");
    expect(isOverdue(row({ stage_since: old, on_hold: true }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: old, stage: "delivered" }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: old, stage: "cancelled" }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: old, stage: null }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: null }), now)).toBe(false);
    expect(isOverdue(row({ stage_since: "not a time" }), now)).toBe(false);
  });
});

describe("what the job screen offers besides the steps", () => {
  const job = (over: object = {}) => ({ ...state("ready"), status: "queued", ...over });

  it("shows the packet only when it is the one to work from", () => {
    for (const status of ["queued", "submitting", "submitted"]) {
      expect(packetProblem({ status })).toBeNull();
    }
    for (const status of ["pending_rx", "failed", "cancelled"]) {
      expect(packetProblem({ status })).toMatch(/no packet to work from/);
    }
    expect(packetProblem({ status: "queued", rx_redacted_at: new Date() })).toMatch(/removed/);
    expect(alsoOffered(job()).packet).toBe(true);
    expect(alsoOffered(job({ status: "pending_rx" })).packet).toBe(false);
  });

  it("offers Retry for a packet that failed or waits, until the lab has started", () => {
    expect(alsoOffered(job({ status: "failed", stage: null })).retry).toBe(true);
    expect(alsoOffered(job({ status: "pending_rx", stage: null })).retry).toBe(true);
    // A changed prescription whose rebuild failed: back at ready, still healable.
    expect(alsoOffered(job({ status: "pending_rx", stage: "ready" })).retry).toBe(true);
    expect(alsoOffered(job({ status: "queued" })).retry).toBe(false);
    expect(alsoOffered(job({ status: "failed", stage: "edged" })).retry).toBe(false);
    expect(alsoOffered(job({ status: "cancelled", stage: "cancelled" })).retry).toBe(false);
  });

  it("offers a changed prescription only before a label exists", () => {
    for (const stage of STAGES) {
      const before = !["labelled", "delivered", "cancelled"].includes(stage);
      expect([stage, alsoOffered(job({ stage })).rx_changed]).toEqual([stage, before]);
    }
    expect(alsoOffered(job({ stage: null })).rx_changed).toBe(false);
  });

  it("does not offer a changed prescription on a packet a lab provider has", () => {
    for (const status of ["queued", "failed", "pending_rx"]) {
      expect([status, alsoOffered(job({ stage: "printed", status })).rx_changed]).toEqual([status, true]);
    }
    for (const status of ["submitted", "submitting", "cancelled"]) {
      expect([status, alsoOffered(job({ stage: "printed", status })).rx_changed]).toEqual([status, false]);
    }
  });
});

describe("a warranty remake after the prescription was removed", () => {
  const blanked = (stage: Stage | null, over: object = {}) =>
    state(stage, { rx_redacted_at: new Date(), ...over });

  it("is offered on a labelled or delivered job, where the plain remake is not", () => {
    for (const stage of ["labelled", "delivered"] as const) {
      expect(offeredActions(blanked(stage)).includes("REMAKE_STARTED")).toBe(false);
      expect(alsoOffered(blanked(stage)).warranty_remake).toBe(true);
    }
  });

  it("is not offered when the plain remake works, or the job is somewhere else", () => {
    expect(alsoOffered(state("delivered")).warranty_remake).toBe(false);
    for (const stage of [null, "ready", "edged", "qc_failed", "cancelled"] as const) {
      expect([stage, alsoOffered(blanked(stage)).warranty_remake]).toEqual([stage, false]);
    }
    // Only a packet that is ours to rewrite and to work from.
    for (const status of ["submitted", "submitting", "failed", "pending_rx", "cancelled"]) {
      expect([status, alsoOffered(blanked("delivered", { status })).warranty_remake]).toEqual([
        status,
        false,
      ]);
    }
    // Not while the job is held or a cut question is open.
    expect(alsoOffered(blanked("labelled", { on_hold: true })).warranty_remake).toBe(false);
  });
});

describe("where a report starts", () => {
  it("is the Monday, in Bangkok, of the first of the weeks asked for", () => {
    // Saturday 21 November 2026 in Bangkok. Its week began Monday the 16th.
    const now = new Date("2026-11-21T05:00:00Z");
    expect(reportFrom(now, 1)).toBe("2026-11-16");
    expect(reportFrom(now, 2)).toBe("2026-11-09");
    expect(reportFrom(now, 12)).toBe("2026-08-31");
  });

  it("uses the Bangkok day: late Sunday evening UTC is already Monday there", () => {
    expect(reportFrom(new Date("2026-11-22T16:59:00Z"), 1)).toBe("2026-11-16");
    expect(reportFrom(new Date("2026-11-22T17:00:00Z"), 1)).toBe("2026-11-23");
  });

  it("keeps the number of weeks between 1 and 52", () => {
    const now = new Date("2026-11-21T05:00:00Z");
    expect(reportFrom(now, 0)).toBe("2026-11-16");
    expect(reportFrom(now, -3)).toBe("2026-11-16");
    expect(reportFrom(now, Number.NaN)).toBe(reportFrom(now, 12));
    expect(reportFrom(now, 500)).toBe(reportFrom(now, 52));
  });
});
