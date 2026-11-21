import type LmsModuleService from "../service";
import { bangkokDate } from "../production";
import { addDays } from "../release";
import type { BuildPacketResult } from "../types";
import { sql, withClient } from "./db-harness";

const OK_BUILD: BuildPacketResult = {
  outcome: "ok",
  packet: {
    job_ref: "klear-order_r",
    klear_order_id: "order_r",
    frame_sku: "KLR-1",
    lens_type: "single_vision",
    lens_index: 1.67,
    coating_addons: [],
    prescription: null,
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
    submitted_at: "2026-11-20T00:00:00.000Z",
  },
};

const SUNDAY = 0;
// 00:30 on Monday 9 November 2026 in Bangkok: the window ending Sunday the
// 8th has just closed.
const MON_9 = new Date("2026-11-08T17:30:00Z");

async function seedEvent(createdAt: string) {
  await sql(
    `insert into production_event
       (id, lab_job_id, seq, action, idempotency_key, actor_type, actor_id, detail, created_at)
     values ('prodevt_seed', 'labjob_seed', 1, 'READY', 'seed-key-0001', 'system', 'x', '{}', $1)`,
    [createdAt],
  );
}

let usageId = 0;
async function usage(enteredOn: string, sku: string, reason: string, qty: number) {
  await sql(
    `insert into lab_usage (id, lab_job_id, production_event_id, sku, reason, qty, entered_on)
     values ($1, 'labjob_seed', 'prodevt_seed', $2, $3, $4, $5)`,
    [`labuse_t${++usageId}`, sku, reason, qty, enteredOn],
  );
}

let costId = 0;
async function cost(
  vendor: string,
  quoted: number,
  createdAt: string,
  receivedAt: string | null,
  invoiced: number | null,
  invoicedAt: string | null,
) {
  await sql(
    `insert into lab_cost
       (id, lab_job_id, vendor, quoted_satang, sent_event_id, created_at, received_at,
        invoiced_satang, invoiced_at)
     values ($1, 'labjob_seed', $2, $3, 'prodevt_seed', $4, $5, $6, $7)`,
    [`labcost_t${++costId}`, vendor, quoted, createdAt, receivedAt, invoiced, invoicedAt],
  );
}

const released = () =>
  sql(`select window_end, sku, reason, net_qty from lab_usage_release order by window_end, sku, reason`);
const markers = () =>
  sql(`select window_start, window_end from lab_release_window order by window_end`);

/** Run inside the one runner in lms.db.spec.ts. */
export function releaseSuite(service: LmsModuleService): void {
    describe("releasing usage windows", () => {
      it("releases nothing before production has started", async () => {
        expect(await service.releaseDueWindows(MON_9, SUNDAY)).toEqual([]);
        expect(await markers()).toEqual([]);
      });

      it("waits until the window's last day has ended in Bangkok", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        // 23:59 on Sunday the 8th in Bangkok.
        expect(await service.releaseDueWindows(new Date("2026-11-08T16:59:00Z"), SUNDAY)).toEqual(
          [],
        );
        expect(await service.releaseDueWindows(MON_9, SUNDAY)).toEqual([
          { window_start: "2026-11-03", window_end: "2026-11-08" },
        ]);
      });

      it("totals a window per SKU and reason, leaves out what nets to zero, and keeps later days for later", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        await usage("2026-11-03", "LENS-A", "order", -1);
        await usage("2026-11-05", "LENS-A", "return_unused", 1);
        await usage("2026-11-08", "LENS-B", "order", -1);
        await usage("2026-11-04", "LENS-D", "order", -1);
        await usage("2026-11-06", "LENS-D", "order", 1); // hand-made: nets to zero
        await usage("2026-11-09", "LENS-C", "order", -1); // next window
        await service.releaseDueWindows(MON_9, SUNDAY);
        expect(await released()).toEqual([
          { window_end: "2026-11-08", sku: "LENS-A", reason: "order", net_qty: -2 },
          { window_end: "2026-11-08", sku: "LENS-A", reason: "return_unused", net_qty: 1 },
          { window_end: "2026-11-08", sku: "LENS-B", reason: "order", net_qty: -1 },
        ]);
      });

      it("releases a window once, and reports usage that turned up inside a released window", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        // A group that nets to zero is deliberately not released; it is not drift.
        await usage("2026-11-03", "LENS-Z", "order", -1);
        await usage("2026-11-03", "LENS-Z", "order", 1);
        await service.releaseDueWindows(MON_9, SUNDAY);
        expect(await service.unreleasedUsageDrift()).toBe(0);
        const before = await sql(`select id, net_qty from lab_usage_release`);
        // The writer never dates a row inside a released window (next test).
        // If one appeared anyway (a hand-made row), the released totals must
        // not move, and the difference must be visible, not silent.
        await usage("2026-11-04", "LENS-A", "order", -1);
        expect(await service.releaseDueWindows(MON_9, SUNDAY)).toEqual([]);
        expect(await sql(`select id, net_qty from lab_usage_release`)).toEqual(before);
        expect(await service.unreleasedUsageDrift()).toBe(1);
        // Two late rows that cancel out in total are still two wrong totals.
        await usage("2026-11-05", "LENS-A", "order", 1);
        await usage("2026-11-05", "LENS-B", "return_unused", 1);
        await usage("2026-11-05", "LENS-C", "order", -1);
        expect(await service.unreleasedUsageDrift()).toBe(2);
      });

      it("makes an action that uses a lens wait for a release in progress, and dates it after that release", async () => {
        const job = await service.createFromBuild(OK_BUILD);
        const act = (action: "PRINTED" | "LENS_ISSUED" | "NOTE", version?: number, detail?: object) =>
          service.applyProductionAction({
            job_id: job!.id,
            action,
            idempotency_key: `lock-test-${action}`,
            expected_version: version,
            actor: { type: "user", id: "user_1" },
            detail: detail as Record<string, unknown>,
          });
        await act("PRINTED", 1);
        const today = bangkokDate(new Date());
        const releasedTo = addDays(today, 3);
        const result = await withClient(async (client) => {
          // A release in progress: the exclusive lock, and a window not yet
          // committed.
          await client.query("begin");
          await client.query(`select pg_advisory_xact_lock(hashtext('lms_usage_release'))`);
          await client.query(
            `insert into lab_release_window (id, window_start, window_end, released_at)
               values ('labwin_t', $1, $2, now())`,
            [today, releasedTo],
          );
          // A note records no usage and no cost: it does not wait.
          const note = await Promise.race([
            act("NOTE", undefined, { text: "x" }).then(() => "done"),
            new Promise((r) => setTimeout(() => r("waiting"), 2000)),
          ]);
          const pending = act("LENS_ISSUED", 2, { lenses: ["LENS-A", "LENS-B"] });
          const issue = await Promise.race([
            pending.then(() => "done"),
            new Promise((r) => setTimeout(() => r("waiting"), 700)),
          ]);
          await client.query("commit");
          await pending;
          return { note, issue };
        });
        expect(result).toEqual({ note: "done", issue: "waiting" });
        expect(await sql(`select distinct entered_on from lab_usage`)).toEqual([
          { entered_on: addDays(releasedTo, 1) },
        ]);
      });

      it("dates usage after the last released window, whatever the writer's clock says", async () => {
        // A window released up to three days from now: as if the releasing
        // process's clock ran ahead of the writer's, or the writer read the
        // clock just before midnight and wrote just after the release.
        const today = bangkokDate(new Date());
        const releasedTo = addDays(today, 3);
        await sql(
          `insert into lab_release_window (id, window_start, window_end, released_at)
             values ('labwin_t', $1, $2, now())`,
          [today, releasedTo],
        );
        const job = await service.createFromBuild(OK_BUILD);
        await service.applyProductionAction({
          job_id: job!.id,
          action: "PRINTED",
          idempotency_key: "clamp-test-printed",
          expected_version: 1,
          actor: { type: "user", id: "user_1" },
        });
        await service.applyProductionAction({
          job_id: job!.id,
          action: "LENS_ISSUED",
          idempotency_key: "clamp-test-issued",
          expected_version: 2,
          actor: { type: "user", id: "user_1" },
          detail: { lenses: ["LENS-A", "LENS-B"] },
        });
        expect(await sql(`select distinct entered_on from lab_usage`)).toEqual([
          { entered_on: addDays(releasedTo, 1) },
        ]);
        expect(await service.unreleasedUsageDrift()).toBe(0);
      });

      it("makes a release wait for an action that is still being written", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        // An open transaction holding the writer's side of the lock.
        const release = await withClient(async (client) => {
          await client.query("begin");
          await client.query(`select pg_advisory_xact_lock_shared(hashtext('lms_usage_release'))`);
          const pending = service.releaseDueWindows(MON_9, SUNDAY);
          const first = await Promise.race([
            pending.then(() => "released"),
            new Promise((r) => setTimeout(() => r("waiting"), 700)),
          ]);
          await client.query("commit");
          return { first, windows: await pending };
        });
        expect(release.first).toBe("waiting");
        expect(release.windows).toHaveLength(1);
      });

      it("catches up after a gap, marks empty windows, and cuts at the month end", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-09", "LENS-C", "order", -1);
        await usage("2026-11-30", "LENS-E", "spoilage_replacement", -1);
        await usage("2026-12-01", "LENS-F", "order", -1);
        // 00:30 on 2 December in Bangkok.
        await service.releaseDueWindows(new Date("2026-12-01T17:30:00Z"), SUNDAY);
        expect(await markers()).toEqual([
          { window_start: "2026-11-03", window_end: "2026-11-08" },
          { window_start: "2026-11-09", window_end: "2026-11-15" },
          { window_start: "2026-11-16", window_end: "2026-11-22" },
          { window_start: "2026-11-23", window_end: "2026-11-30" },
        ]);
        expect(await released()).toEqual([
          { window_end: "2026-11-15", sku: "LENS-C", reason: "order", net_qty: -1 },
          { window_end: "2026-11-30", sku: "LENS-E", reason: "spoilage_replacement", net_qty: -1 },
        ]);
      });

      it("releases each window once when two runs start together", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        const runs = await Promise.all([
          service.releaseDueWindows(MON_9, SUNDAY),
          service.releaseDueWindows(MON_9, SUNDAY),
          service.releaseDueWindows(MON_9, SUNDAY),
        ]);
        expect(runs.map((r) => r.length).sort()).toEqual([0, 0, 1]);
        expect(await markers()).toHaveLength(1);
        expect(await released()).toHaveLength(1);
      });

      it("takes usage recorded through the lab's actions on the day it was entered", async () => {
        const job = await service.createFromBuild(OK_BUILD);
        const act = (action: "PRINTED" | "LENS_ISSUED", version: number, detail?: object) =>
          service.applyProductionAction({
            job_id: job!.id,
            action,
            idempotency_key: `release-test-${action}`,
            expected_version: version,
            actor: { type: "user", id: "user_1" },
            detail: detail as Record<string, unknown>,
          });
        await act("PRINTED", 1);
        await act("LENS_ISSUED", 2, { lenses: ["LENS-A", "LENS-B"] });
        const today = bangkokDate(new Date());
        expect(await sql(`select distinct entered_on from lab_usage`)).toEqual([
          { entered_on: today },
        ]);
        // Released once enough time has passed for today's window to close.
        await service.releaseDueWindows(new Date(Date.now() + 12 * 24 * 3600 * 1000), SUNDAY);
        expect(
          await sql(`select sku, reason, net_qty from lab_usage_release order by sku`),
        ).toEqual([
          { sku: "LENS-A", reason: "order", net_qty: -1 },
          { sku: "LENS-B", reason: "order", net_qty: -1 },
        ]);
      });
    });

    describe("lab totals", () => {
      it("treats one lab written three ways as one lab", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await cost("Lab One", 10000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        await cost("lab one", 10000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        await cost(" Lab  One ", 10000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        await cost("\tLab One\n", 10000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        await service.releaseDueWindows(MON_9, SUNDAY);
        expect(
          await sql(`select vendor, quoted_uninvoiced_satang as open from lab_total_day`),
        ).toEqual([{ vendor: "lab one", open: 40000 }]);
      });

      it("counts an invoice entered before the work was marked back, and ignores a deleted quote", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await cost("Lab One", 10000, "2026-11-03T03:00:00Z", null, 11000, "2026-11-05T03:00:00Z");
        await cost("Lab One", 99000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        // lab_cost is not insert-only: a quote can be soft-deleted.
        await sql(`update lab_cost set deleted_at = now() where quoted_satang = 99000`);
        await service.releaseDueWindows(MON_9, SUNDAY);
        expect(
          await sql(
            `select vendor, quoted_uninvoiced_satang as open, invoiced_to_date_satang as invoiced
               from lab_total_day`,
          ),
        ).toEqual([{ vendor: "lab one", open: 0, invoiced: 11000 }]);
      });

      it("reports, per lab, work back and not yet invoiced, and everything invoiced, as of the window's last day", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        // Back on the 5th, never invoiced.
        await cost("Lab One", 40000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        // Back on the 6th, invoiced on the 7th.
        await cost("Lab One", 30000, "2026-11-03T03:00:00Z", "2026-11-06T03:00:00Z", 31000, "2026-11-07T03:00:00Z");
        // Back one second before midnight on the 8th, Bangkok time: counts.
        await cost("Lab One", 5000, "2026-11-03T03:00:00Z", "2026-11-08T16:59:59Z", null, null);
        // Back at midnight exactly: belongs to the 9th.
        await cost("Lab One", 20000, "2026-11-03T03:00:00Z", "2026-11-08T17:00:00Z", null, null);
        // Back on the 6th, invoiced on the 10th: still un-invoiced on the 8th.
        await cost("Lab One", 7000, "2026-11-03T03:00:00Z", "2026-11-06T03:00:00Z", 7500, "2026-11-10T03:00:00Z");
        // Sent, not back.
        await cost("Lab Two", 10000, "2026-11-04T03:00:00Z", null, null, null);
        // A lab first used after the window: no row for the 8th.
        await cost("Lab Three", 9000, "2026-11-10T03:00:00Z", null, null, null);

        await service.releaseDueWindows(new Date("2026-11-15T17:30:00Z"), SUNDAY);
        expect(
          await sql(
            `select vendor, as_of, quoted_uninvoiced_satang as open, invoiced_to_date_satang as invoiced
               from lab_total_day order by as_of, vendor`,
          ),
        ).toEqual([
          { vendor: "lab one", as_of: "2026-11-08", open: 52000, invoiced: 31000 },
          { vendor: "lab two", as_of: "2026-11-08", open: 0, invoiced: 0 },
          { vendor: "lab one", as_of: "2026-11-15", open: 65000, invoiced: 38500 },
          { vendor: "lab three", as_of: "2026-11-15", open: 0, invoiced: 0 },
          { vendor: "lab two", as_of: "2026-11-15", open: 0, invoiced: 0 },
        ]);
      });
    });

    describe("what the feed is given", () => {
      it("lists released windows after a cursor, each complete, with nothing but totals", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        await usage("2026-11-10", "LENS-C", "remake", -1);
        await cost("Lab One", 40000, "2026-11-03T03:00:00Z", "2026-11-05T03:00:00Z", null, null);
        await service.releaseDueWindows(new Date("2026-11-22T17:30:00Z"), SUNDAY);

        const all = await service.listReleasedWindows(null);
        expect(all.map((w) => w.window_end)).toEqual(["2026-11-08", "2026-11-15", "2026-11-22"]);
        expect(all[0].usage.map(({ sku, reason, net_qty }) => ({ sku, reason, net_qty }))).toEqual([
          { sku: "LENS-A", reason: "order", net_qty: -1 },
        ]);
        expect(all[2].usage).toEqual([]);
        expect(all[2].lab_totals).toHaveLength(1);

        // Exactly these keys, at every level: no job, order, event or day.
        for (const w of all) {
          expect(Object.keys(w).sort()).toEqual(["lab_totals", "released_at", "usage", "window_end"]);
          for (const u of w.usage) {
            expect(Object.keys(u).sort()).toEqual(["id", "net_qty", "reason", "sku"]);
          }
          for (const t of w.lab_totals) {
            expect(Object.keys(t).sort()).toEqual([
              "as_of",
              "id",
              "invoiced_to_date_satang",
              "quoted_uninvoiced_satang",
              "vendor",
            ]);
          }
        }
        expect(JSON.stringify(all)).not.toMatch(/labjob|prodevt|labuse_|order_/);

        const later = await service.listReleasedWindows("2026-11-08", 1);
        expect(later.map((w) => w.window_end)).toEqual(["2026-11-15"]);
        expect(await service.listReleasedWindows("2026-11-22")).toEqual([]);
      });

      it("refuses update and delete on the release tables", async () => {
        await seedEvent("2026-11-03T02:00:00Z");
        await usage("2026-11-03", "LENS-A", "order", -1);
        await cost("Lab One", 40000, "2026-11-03T03:00:00Z", null, null, null);
        await service.releaseDueWindows(MON_9, SUNDAY);
        for (const table of ["lab_release_window", "lab_usage_release", "lab_total_day"]) {
          expect(await sql(`select count(*)::int as n from ${table}`)).toEqual([{ n: 1 }]);
          await expect(sql(`update ${table} set id = id`)).rejects.toThrow(/insert-only/);
          await expect(sql(`delete from ${table}`)).rejects.toThrow(/insert-only/);
        }
      });
    });
}
