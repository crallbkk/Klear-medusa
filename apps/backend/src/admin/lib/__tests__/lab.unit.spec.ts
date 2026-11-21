import {
  ACTION_FIELDS,
  ACTION_LABEL,
  BOARD_COLUMNS,
  bahtToSatang,
  buildDetail,
  eventSummary,
  failureMessage,
  formatBaht,
  fieldsFor,
  keyFor,
  newKey,
  NO_ANSWER,
  NO_PRESCRIPTION_HERE,
  packetIsCurrent,
  requestIdentity,
  percent,
  shortId,
  stageLabel,
  tidySku,
  waited,
  wasAnswered,
} from "../lab";
import { ACTIONS, STAGES, decide, type JobState, type Stage } from "../../../modules/lms/production";
import { LAB_ACTIONS, OPS_ACTIONS } from "../../../api/admin/lab-jobs/production-http";
import { boardColumn } from "../../../modules/lms/board";
import { FetchError } from "@medusajs/js-sdk";

const state = (stage: Stage | null, over: Partial<JobState> = {}): JobState => ({
  stage,
  remake_count: 0,
  on_hold: false,
  cut_question_pending: false,
  next_issue_reason: "order",
  ...over,
});

// What a person would type into each step's form, and a job the step is
// allowed on.
const TYPED: Record<string, { values: Record<string, string>; on: JobState }> = {
  PRINTED: { values: {}, on: state("ready") },
  LENS_ISSUED: { values: { lens_1: " lens-sv-167-m0100 ", lens_2: "LENS-SV-167-M0125" }, on: state("printed") },
  SENT_TO_LAB: {
    values: { vendor: " Bangkok   Optics ", quoted: "1,250.5", expected_on: "2026-12-01" },
    on: state("printed"),
  },
  RECEIVED_FROM_LAB: { values: {}, on: state("sent_to_lab") },
  EDGED: { values: {}, on: state("lens_issued") },
  MOUNTED: { values: {}, on: state("edged") },
  QC_PASSED: { values: {}, on: state("mounted") },
  QC_FAILED: { values: { reason: "axis off" }, on: state("mounted") },
  REMAKE_STARTED: { values: { cause: "edging error" }, on: state("qc_failed") },
  REWORK: { values: {}, on: state("qc_failed") },
  LENS_SPOILED: { values: { reason: "chipped" }, on: state("edged") },
  PACKED: { values: {}, on: state("qc_passed") },
  FRAME_DAMAGED: { values: { sku: "klr-1", reason: "hinge" }, on: state("edged") },
  LENS_RETURNED_UNUSED: {
    values: { lens_1: "LENS-SV-167-M0100", lens_2: "" },
    on: state("cancelled", { cut_question_pending: true }),
  },
  LENS_CUT_CONFIRMED: { values: {}, on: state("cancelled", { cut_question_pending: true }) },
  LAB_INVOICED: { values: { invoiced: "1300" }, on: state("received_from_lab") },
  NOTE: { values: { text: "called the lab" }, on: state("edged") },
  HOLD: { values: { reason: "customer asked" }, on: state("edged") },
  RELEASE: { values: {}, on: state("edged", { on_hold: true }) },
};

describe("a step's form becomes a request the production rules accept", () => {
  const offered = [...LAB_ACTIONS, ...OPS_ACTIONS];

  it("for every step a person can record", () => {
    for (const action of offered) {
      const typed = TYPED[action];
      expect([action, typed !== undefined]).toEqual([action, true]);
      const built = buildDetail(action, typed.values);
      expect([action, built.ok]).toEqual([action, true]);
      if (!built.ok) continue;
      // The real rules, not a copy of them.
      expect(() => decide(typed.on, action, built.detail ?? {})).not.toThrow();
    }
  });

  it("has words for every action and a form only for steps a person records", () => {
    for (const action of ACTIONS) expect([action, typeof ACTION_LABEL[action]]).toEqual([action, "string"]);
    for (const action of Object.keys(ACTION_FIELDS)) {
      expect([action, offered.includes(action as never)]).toEqual([action, true]);
    }
  });

  it("sends exactly what was meant: capitals, one spelling of the lab, whole satang", () => {
    expect(buildDetail("LENS_ISSUED", TYPED.LENS_ISSUED.values)).toEqual({
      ok: true,
      detail: { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] },
    });
    expect(buildDetail("LENS_ISSUED", { lens_1: "LENS-A", lens_2: "  " })).toEqual({
      ok: true,
      detail: { lenses: ["LENS-A"] },
    });
    expect(buildDetail("SENT_TO_LAB", TYPED.SENT_TO_LAB.values)).toEqual({
      ok: true,
      detail: { vendor: "Bangkok Optics", quoted_satang: 125050, expected_on: "2026-12-01" },
    });
    expect(buildDetail("SENT_TO_LAB", { vendor: "Lab", quoted: "0" })).toEqual({
      ok: true,
      detail: { vendor: "Lab", quoted_satang: 0 },
    });
    expect(buildDetail("LAB_INVOICED", { invoiced: "1300" })).toEqual({
      ok: true,
      detail: { invoiced_satang: 130000 },
    });
    expect(buildDetail("FRAME_DAMAGED", TYPED.FRAME_DAMAGED.values)).toEqual({
      ok: true,
      detail: { sku: "KLR-1", reason: "hinge" },
    });
    expect(buildDetail("PACKED", { stray: "x" })).toEqual({ ok: true, detail: undefined });
  });

  it("names the field that is wrong instead of sending it", () => {
    const wrong = (action: string, values: Record<string, string>) => {
      const built = buildDetail(action, values);
      return built.ok ? "sent" : built.field;
    };
    expect(wrong("LENS_ISSUED", {})).toBe("lens_1");
    expect(wrong("LENS_ISSUED", { lens_1: "two words" })).toBe("lens_1");
    expect(wrong("LENS_ISSUED", { lens_1: "LENS-A", lens_2: "-1.25" })).toBe("lens_2");
    expect(wrong("SENT_TO_LAB", { quoted: "100" })).toBe("vendor");
    expect(wrong("SENT_TO_LAB", { vendor: "Lab" })).toBe("quoted");
    expect(wrong("SENT_TO_LAB", { vendor: "Lab", quoted: "12.345" })).toBe("quoted");
    expect(wrong("SENT_TO_LAB", { vendor: "Lab", quoted: "-5" })).toBe("quoted");
    expect(wrong("SENT_TO_LAB", { vendor: "Lab", quoted: "5", expected_on: "2026-02-31" })).toBe(
      "expected_on",
    );
    expect(wrong("QC_FAILED", { reason: "   " })).toBe("reason");
    expect(wrong("QC_FAILED", { reason: "x".repeat(501) })).toBe("reason");
    expect(wrong("NOTE", { text: "x".repeat(2000) })).toBe("sent");
    expect(wrong("NOTE", { text: "x".repeat(2001) })).toBe("text");
    expect(wrong("HOLD", {})).toBe("reason");
  });
});

describe("money on the screen", () => {
  it("reads baht as typed into whole satang without floating point", () => {
    expect(bahtToSatang("450")).toBe(45000);
    expect(bahtToSatang("450.5")).toBe(45050);
    expect(bahtToSatang("450.05")).toBe(45005);
    expect(bahtToSatang(" 1,250.75 ")).toBe(125075);
    expect(bahtToSatang("0")).toBe(0);
    // 0.1 + 0.2 style traps: these are exact because no float is involved.
    expect(bahtToSatang("0.29")).toBe(29);
    expect(bahtToSatang("1.15")).toBe(115);
    expect(bahtToSatang("19999999.99")).toBe(1999999999);
    for (const bad of ["", "abc", "-1", "1.234", "1.", ".5", "1e3", "1 000", "20000000.01", "999999999"]) {
      expect([bad, bahtToSatang(bad)]).toEqual([bad, null]);
    }
  });

  it("never reads a decimal comma as thousands", () => {
    // A phone set to a comma-decimal language offers "," on the number pad.
    for (const bad of ["450,50", "12,5", "1,2,3", ",5", "1,,2", "1,2345", "1234,567", "1,250,5", "0,5"]) {
      expect([bad, bahtToSatang(bad)]).toEqual([bad, null]);
    }
    expect(bahtToSatang("1,250")).toBe(125000);
    expect(bahtToSatang("12,345,678.9")).toBe(1234567890);
  });

  it("shows satang as baht with two decimals", () => {
    expect(formatBaht(0)).toBe("0.00");
    expect(formatBaht(5)).toBe("0.05");
    expect(formatBaht(45050)).toBe("450.50");
    expect(formatBaht(125075)).toBe("1,250.75");
    expect(formatBaht(-125075)).toBe("-1,250.75");
    expect(formatBaht(null)).toBe("");
    expect(formatBaht(undefined)).toBe("");
  });

  it("round-trips every amount it shows", () => {
    for (const satang of [0, 1, 99, 100, 101, 45050, 125075, 1999999999]) {
      expect(bahtToSatang(formatBaht(satang))).toBe(satang);
    }
  });
});

describe("small things the screens show", () => {
  it("tidies a SKU or refuses it", () => {
    expect(tidySku(" lens-sv-167-m0100 ")).toBe("LENS-SV-167-M0100");
    expect(tidySku("A")).toBeNull();
    expect(tidySku("-1.25")).toBeNull();
    expect(tidySku("two words")).toBeNull();
  });

  it("has a name and a place on the board for every column a job can be in", () => {
    const columns = new Set<string>();
    for (const stage of [null, ...STAGES]) {
      for (const status of ["queued", "failed", "pending_rx"]) {
        for (const on_hold of [false, true]) {
          for (const cut_question_pending of [false, true]) {
            columns.add(boardColumn({ stage, status, on_hold, cut_question_pending }));
          }
        }
      }
    }
    for (const column of columns) {
      expect([column, stageLabel(column) !== column]).toEqual([column, true]);
      // Finished jobs and jobs with nothing wrong and no stage are not on the board.
      if (["delivered", "cancelled", "none"].includes(column)) continue;
      expect([column, (BOARD_COLUMNS as readonly string[]).includes(column)]).toEqual([column, true]);
    }
    expect(stageLabel(null)).toBe("Not in production");
    expect(new Set(BOARD_COLUMNS).size).toBe(BOARD_COLUMNS.length);
  });

  it("says how long a job has waited", () => {
    const now = new Date("2026-11-21T12:00:00Z");
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    expect(waited(ago(0), now)).toBe("now");
    expect(waited(ago(25), now)).toBe("25 min");
    expect(waited(ago(60), now)).toBe("1 h");
    expect(waited(ago(47 * 60), now)).toBe("47 h");
    expect(waited(ago(48 * 60), now)).toBe("2 d");
    expect(waited(null, now)).toBe("");
    expect(waited("nonsense", now)).toBe("");
  });

  it("makes a new key every time, long enough for the routes", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newKey()));
    expect(keys.size).toBe(200);
    for (const key of keys) {
      expect(key.length).toBeGreaterThanOrEqual(8);
      expect(key.length).toBeLessThanOrEqual(200);
    }
  });

  it("shortens an id, shows a rate, and sums up an event", () => {
    expect(shortId("order_01JABCDEFGH12345678")).toBe("12345678");
    expect(shortId("short")).toBe("short");
    expect(percent(0.125)).toBe("12.5%");
    expect(percent(0)).toBe("0.0%");
    expect(percent(null)).toBe("-");
    expect(
      eventSummary({ action: "SENT_TO_LAB", detail: { vendor: "Lab", quoted_satang: 45000, expected_on: null } }),
    ).toBe("Lab · quoted 450.00");
    expect(eventSummary({ action: "LENS_ISSUED", detail: { lenses: ["A-1", "B-2"], reason: "spoilage_replacement" } })).toBe(
      "A-1, B-2 · spoilage replacement",
    );
    expect(eventSummary({ action: "PACKED", detail: null })).toBe("");
    // What a person typed is shown as typed.
    expect(eventSummary({ action: "NOTE", detail: { text: "frame KLR_1 swapped" } })).toBe(
      "frame KLR_1 swapped",
    );
    expect(eventSummary({ action: "QC_FAILED", detail: { reason: "axis_off" } })).toBe("axis_off");
  });

  it("warns beside every box a person can type free text into", () => {
    const actions = [...LAB_ACTIONS, ...OPS_ACTIONS];
    let boxes = 0;
    for (const action of actions) {
      for (const field of fieldsFor(action)) {
        if (field.kind !== "text" && field.kind !== "vendor") continue;
        boxes++;
        expect([action, field.name, field.help?.includes(NO_PRESCRIPTION_HERE)]).toEqual([
          action,
          field.name,
          true,
        ]);
      }
    }
    expect(boxes).toBeGreaterThanOrEqual(7);
  });

  it("tells a refusal from a request that never got an answer, with the SDK's own error", () => {
    const refused = new FetchError("PRINTED is not possible while the job is edged", "Conflict", 409);
    expect(wasAnswered(refused)).toBe(true);
    expect(failureMessage(refused)).toBe("PRINTED is not possible while the job is edged");
    // Over HTTP/2 there is no status text; a route that sent no message
    // leaves the SDK with an empty one.
    expect(failureMessage(new FetchError("", "", 409))).toBe("The request was refused.");
    expect(wasAnswered(new FetchError("Internal Server Error", "Internal Server Error", 500))).toBe(false);
    expect(wasAnswered(new TypeError("Failed to fetch"))).toBe(false);
  });

  it("never shows the text of an error that is not a refusal", () => {
    // A parser's message can quote part of the response it choked on.
    const parse = new SyntaxError('Unexpected token \'<\', "<html>sph_right -2.25" is not valid JSON');
    expect(failureMessage(parse)).toBe(NO_ANSWER);
    expect(failureMessage(new TypeError("Failed to fetch"))).toBe(NO_ANSWER);
    expect(failureMessage(new FetchError("select ... LENS-SV", "Internal Server Error", 500))).toBe(NO_ANSWER);
    expect(failureMessage(undefined)).toBe(NO_ANSWER);
  });
});

describe("one request, one key", () => {
  const job = { id: "labjob_1", stage_version: 3, event_seq: 7 };

  it("gives a second press and a retry of the same request the same key", () => {
    const kept = new Map<string, string>();
    const first = keyFor(kept, requestIdentity("EDGED", job));
    expect(keyFor(kept, requestIdentity("EDGED", job))).toBe(first);
    const typed = keyFor(kept, requestIdentity("NOTE", job, { text: "called the lab" }));
    expect(keyFor(kept, requestIdentity("NOTE", job, { text: " called the lab " }))).toBe(typed);
    expect(keyFor(kept, requestIdentity("FRAME_DAMAGED", job, { sku: "A-1", reason: "x", extra: "" }))).toBe(
      keyFor(kept, requestIdentity("FRAME_DAMAGED", job, { reason: "x", sku: "A-1" })),
    );
  });

  it("gives a different request a different key", () => {
    const kept = new Map<string, string>();
    const base = keyFor(kept, requestIdentity("NOTE", job, { text: "one" }));
    // Other details: the route refuses a key reused with different contents.
    expect(keyFor(kept, requestIdentity("NOTE", job, { text: "two" }))).not.toBe(base);
    // Another step, another job.
    expect(keyFor(kept, requestIdentity("HOLD", job, { text: "one" }))).not.toBe(base);
    expect(keyFor(kept, requestIdentity("NOTE", { ...job, id: "labjob_2" }, { text: "one" }))).not.toBe(base);
  });

  it("does not reuse a key once the job has moved on, even back at the same stage", () => {
    // "Edged" was written but its answer was lost; the key stayed. The job
    // is spoiled, reissued, and is at lens_issued again on the same screen.
    // Pressing Edged now must record, not replay the old press.
    const kept = new Map<string, string>();
    const lost = keyFor(kept, requestIdentity("EDGED", job));
    const later = { ...job, stage_version: 6, event_seq: 11 };
    expect(keyFor(kept, requestIdentity("EDGED", later))).not.toBe(lost);
    // A note or a packet look moves the event number, not the stage version.
    expect(keyFor(kept, requestIdentity("NOTE", { ...job, event_seq: 8 }, { text: "one" }))).not.toBe(
      keyFor(kept, requestIdentity("NOTE", job, { text: "one" })),
    );
  });
});

describe("a packet on the screen", () => {
  const stamp = "2026-11-21T05:00:00.000Z";

  it("stays while the job row is the one it was read from", () => {
    expect(packetIsCurrent(stamp, { updated_at: stamp }, true)).toBe(true);
    // The same instant written another way.
    expect(packetIsCurrent(stamp, { updated_at: "2026-11-21T12:00:00.000+07:00" }, true)).toBe(true);
  });

  it("goes once the packet was rebuilt or blanked, or may no longer be shown", () => {
    expect(packetIsCurrent(stamp, { updated_at: "2026-11-21T05:00:00.001Z" }, true)).toBe(false);
    expect(packetIsCurrent(stamp, { updated_at: stamp }, false)).toBe(false);
    expect(packetIsCurrent(null, { updated_at: stamp }, true)).toBe(false);
    expect(packetIsCurrent(stamp, {}, true)).toBe(false);
    expect(packetIsCurrent("nonsense", { updated_at: "nonsense" }, true)).toBe(false);
  });
});
