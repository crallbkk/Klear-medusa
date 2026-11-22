import type LmsModuleService from "../service";
import { LensSnapshotRefused } from "../service";
import { sql } from "./db-harness";

let usageId = 0;
async function usage(enteredOn: string, sku: string, reason: string, qty: number) {
  await sql(
    `insert into lab_usage (id, lab_job_id, production_event_id, sku, reason, qty, entered_on)
     values ($1, 'labjob_seed', 'prodevt_seed', $2, $3, $4, $5)`,
    [`labuse_ls${++usageId}`, sku, reason, qty, enteredOn],
  );
}

async function windowEnding(start: string, end: string) {
  await sql(
    `insert into lab_release_window (id, window_start, window_end, released_at)
     values ($1, $2, $3, now())`,
    [`labwin_${end}`, start, end],
  );
}

const held = () =>
  sql<{ sku: string; on_hand: number; as_of: string }>(
    `select sku, on_hand, as_of from lens_stock_snapshot order by sku`,
  );

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LensSnapshotRefused) return err.code;
    throw err;
  }
  return "accepted";
}

/** Run inside the one runner in lms.db.spec.ts. */
export function lensStockSuite(service: LmsModuleService): void {
  describe("the lens snapshot from Klear Operations", () => {
    it("is stored whole, and the next one replaces it, SKUs it no longer lists included", async () => {
      await windowEnding("2026-11-01", "2026-11-08");
      await windowEnding("2026-11-09", "2026-11-15");
      expect(
        await service.replaceLensSnapshot("2026-11-08", [
          { sku: "LENS-A", on_hand: 5 },
          { sku: "LENS-B", on_hand: 2 },
        ]),
      ).toBe(2);
      expect(await held()).toEqual([
        { sku: "LENS-A", on_hand: 5, as_of: "2026-11-08" },
        { sku: "LENS-B", on_hand: 2, as_of: "2026-11-08" },
      ]);
      await service.replaceLensSnapshot("2026-11-15", [{ sku: "LENS-A", on_hand: 4 }]);
      expect(await held()).toEqual([{ sku: "LENS-A", on_hand: 4, as_of: "2026-11-15" }]);
      // The same date again is a correction.
      await service.replaceLensSnapshot("2026-11-15", [{ sku: "LENS-A", on_hand: 3 }]);
      expect(await held()).toEqual([{ sku: "LENS-A", on_hand: 3, as_of: "2026-11-15" }]);
      // Medusa's own list method reads the table the migration made.
      const listed = await service.listLensStockSnapshots({}, { select: ["sku", "on_hand", "as_of"] });
      expect(listed.map((r) => [r.sku, r.on_hand, r.as_of])).toEqual([["LENS-A", 3, "2026-11-15"]]);
    });

    it("refuses an older snapshot than the one held, and changes nothing", async () => {
      await windowEnding("2026-11-01", "2026-11-08");
      await windowEnding("2026-11-09", "2026-11-15");
      await service.replaceLensSnapshot("2026-11-15", [{ sku: "LENS-A", on_hand: 4 }]);
      expect(await refusal(service.replaceLensSnapshot("2026-11-08", [{ sku: "LENS-A", on_hand: 9 }]))).toBe(
        "older_than_stored",
      );
      expect(await held()).toEqual([{ sku: "LENS-A", on_hand: 4, as_of: "2026-11-15" }]);
    });

    it("refuses a date usage has not been released up to, once there is usage", async () => {
      // Before any lens was used, any date will do: nothing is left out.
      expect(await refusal(service.replaceLensSnapshot("2026-11-04", [{ sku: "LENS-A", on_hand: 1 }]))).toBe(
        "accepted",
      );
      await usage("2026-11-03", "LENS-A", "order", -1);
      // Not a window's end: usage on or before it may not be in the figure.
      expect(await refusal(service.replaceLensSnapshot("2026-11-05", [{ sku: "LENS-A", on_hand: 1 }]))).toBe(
        "not_a_release",
      );
      await windowEnding("2026-11-01", "2026-11-08");
      expect(await refusal(service.replaceLensSnapshot("2026-11-08", [{ sku: "LENS-A", on_hand: 1 }]))).toBe(
        "accepted",
      );
    });

    it("refuses a date that has not ended yet in Bangkok, so a snapshot from the future cannot block real ones", async () => {
      // Bangkok's date on the database's own clock, as the service reads it.
      const [{ today, tomorrow, yesterday }] = await sql<{ today: string; tomorrow: string; yesterday: string }>(
        `select to_char(d, 'YYYY-MM-DD') as today,
                to_char(d + 1, 'YYYY-MM-DD') as tomorrow,
                to_char(d - 1, 'YYYY-MM-DD') as yesterday
           from (select (now() at time zone 'Asia/Bangkok')::date as d) x`,
      );
      // No usage at all: before this rule, any date was taken.
      for (const asOf of [today, tomorrow, "2099-12-31"]) {
        expect([asOf, await refusal(service.replaceLensSnapshot(asOf, [{ sku: "LENS-A", on_hand: 9 }]))]).toEqual([
          asOf,
          "not_yet_closed",
        ]);
      }
      expect(await held()).toEqual([]);
      // Nothing from the future was kept, so real, earlier snapshots go in.
      expect(await refusal(service.replaceLensSnapshot("2026-11-01", [{ sku: "LENS-A", on_hand: 1 }]))).toBe(
        "accepted",
      );
      expect(await refusal(service.replaceLensSnapshot(yesterday, [{ sku: "LENS-A", on_hand: 2 }]))).toBe("accepted");
      // And the same date again is still a correction.
      expect(await refusal(service.replaceLensSnapshot(yesterday, [{ sku: "LENS-A", on_hand: 3 }]))).toBe("accepted");
      expect(await held()).toEqual([{ sku: "LENS-A", on_hand: 3, as_of: yesterday }]);
    });

    it("shows the lab the figure plus what was used after its date", async () => {
      await usage("2026-11-03", "LENS-A", "order", -1);
      await usage("2026-11-08", "LENS-A", "order", -1);
      await windowEnding("2026-11-01", "2026-11-08");
      // After the window Operations applied: two used, one put back uncut.
      await usage("2026-11-09", "LENS-A", "order", -1);
      await usage("2026-11-10", "LENS-A", "spoilage_replacement", -1);
      await usage("2026-11-10", "LENS-A", "return_unused", 1);
      await usage("2026-11-11", "LENS-C", "order", -1);
      await service.replaceLensSnapshot("2026-11-08", [
        { sku: "LENS-A", on_hand: 10 },
        { sku: "LENS-B", on_hand: 3 },
      ]);
      expect(await service.lensStock()).toEqual([
        { sku: "LENS-A", on_hand_at_release: 10, as_of: "2026-11-08", used_since: -1, available: 9 },
        { sku: "LENS-B", on_hand_at_release: 3, as_of: "2026-11-08", used_since: 0, available: 3 },
      ]);
      expect(await service.lensStock(["LENS-B", "LENS-C"])).toEqual([
        { sku: "LENS-B", on_hand_at_release: 3, as_of: "2026-11-08", used_since: 0, available: 3 },
      ]);
      expect(await service.lensStock([])).toEqual([]);
    });
  });
}
