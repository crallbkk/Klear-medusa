// Writing off an outside lab's quote whose work came back and that the lab
// will never invoice (a remake it does not bill): through the one writer,
// out of "back, not invoiced", counted on its own, reversed by an invoice.

import type LmsModuleService from "../service";
import {
  ProductionError,
  writeOffRefusal,
  wouldAccept,
  type ProductionAction,
} from "../production";
import type { BuildPacketResult } from "../types";
import { sendProductionError } from "../../../api/admin/lab-jobs/production-http";
import * as sentry from "../../../lib/observability/sentry";
import { sql } from "./db-harness";

const ok = (orderId: string): BuildPacketResult => ({
  outcome: "ok",
  packet: {
    job_ref: `klear-${orderId}`,
    klear_order_id: orderId,
    frame_sku: "KLR-1",
    lens_type: "single_vision",
    lens_index: 1.67,
    coating_addons: [],
    prescription: null,
    customer: {
      name: "A B",
      phone: "+66800000000",
      delivery_address: { line1: "x", city: "c", province: "p", postal_code: "10110", country_code: "TH" },
    },
    submitted_at: "2026-11-20T00:00:00.000Z",
  },
});

const OPS = { type: "user" as const, id: "user_ops_1" };
// What a person might type: a customer's name. It must stay on the quote.
const REASON = "Remake for Somchai Secretname, the lab does not bill it";
let n = 0;
const key = () => `wo-key-${++n}-${Date.now()}`;

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProductionError) return err.code;
    throw err;
  }
  return "no error";
}

const everythingIn = (err: unknown) =>
  [
    String(err),
    (err as Error)?.message ?? "",
    (err as Error)?.stack ?? "",
    JSON.stringify(err, Object.getOwnPropertyNames((err ?? {}) as object)),
  ].join("\n");

/** Run inside the one runner in lms.db.spec.ts. */
export function writeOffSuite(service: LmsModuleService): void {
  const version = async (jobId: string) =>
    (await sql<{ stage_version: number }>(`select stage_version from lab_job where id = $1`, [jobId]))[0]
      .stage_version;

  const act = async (
    jobId: string,
    action: ProductionAction,
    detail?: Record<string, unknown>,
    k: string = key(),
  ) =>
    service.applyProductionAction({
      job_id: jobId,
      action,
      idempotency_key: k,
      expected_version: await version(jobId),
      actor: OPS,
      detail,
    });

  const writeOff = (jobId: string, costId: string, k?: string, reason: unknown = REASON) =>
    act(jobId, "LAB_QUOTE_WRITTEN_OFF", { lab_cost_id: costId, reason }, k);

  /** A job sent out and back: one quote, back and not invoiced. */
  async function backFromLab(orderId = "order_wo", quoted = 45000): Promise<{ jobId: string; costId: string }> {
    const job = await service.createFromBuild(ok(orderId));
    const jobId = job!.id;
    await act(jobId, "PRINTED");
    await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: quoted });
    await act(jobId, "RECEIVED_FROM_LAB");
    const [cost] = await sql<{ id: string }>(`select id from lab_cost where lab_job_id = $1`, [jobId]);
    return { jobId, costId: cost.id };
  }

  const quote = async (costId: string) =>
    (
      await sql(
        `select received_at is not null as back, invoiced_satang, written_off_at is not null as written_off,
                written_off_by, written_off_reason
           from lab_cost where id = $1`,
        [costId],
      )
    )[0];

  describe("writing off a lab quote", () => {
    it("records who, when and why on the quote, and an event in the history without the reason", async () => {
      const { jobId, costId } = await backFromLab();
      const before = (await sql(`select stage, stage_version from lab_job where id = $1`, [jobId]))[0];
      const done = await writeOff(jobId, costId, undefined, `  ${REASON}  `);
      expect(done.replayed).toBe(false);
      expect(await quote(costId)).toEqual({
        back: true,
        invoiced_satang: null,
        written_off: true,
        written_off_by: "user_ops_1",
        written_off_reason: REASON,
      });
      const [stamp] = await sql<{ near: boolean }>(
        `select abs(extract(epoch from (written_off_at - now()))) < 60 as near from lab_cost where id = $1`,
        [costId],
      );
      expect(stamp.near).toBe(true);
      // The job does not move.
      expect((await sql(`select stage, stage_version from lab_job where id = $1`, [jobId]))[0]).toEqual(before);
      const [event] = await sql(
        `select action, actor_type, actor_id, from_stage, to_stage, detail from production_event
          where lab_job_id = $1 order by seq desc limit 1`,
        [jobId],
      );
      expect(event).toEqual({
        action: "LAB_QUOTE_WRITTEN_OFF",
        actor_type: "user",
        actor_id: "user_ops_1",
        from_stage: "received_from_lab",
        to_stage: null,
        detail: { lab_cost_id: costId, vendor: "Lab One", quoted_satang: 45000 },
      });
      // The reason is nowhere but on the quote.
      expect(JSON.stringify(await sql(`select * from production_event`))).not.toMatch(/Secretname/);
      expect(JSON.stringify(await sql(`select * from lab_job`))).not.toMatch(/Secretname/);
      expect(JSON.stringify(done)).not.toMatch(/Secretname/);
    });

    it("answers a repeated identical request as a replay, and a new request as already written off", async () => {
      const { jobId, costId } = await backFromLab();
      const k = key();
      await writeOff(jobId, costId, k);
      const again = await writeOff(jobId, costId, k);
      expect(again.replayed).toBe(true);
      expect(await sql(`select count(*)::int as n from production_event where action = 'LAB_QUOTE_WRITTEN_OFF'`)).toEqual([
        { n: 1 },
      ]);
      // The same key with another reason is a different request.
      expect(await code(writeOff(jobId, costId, k, "another reason"))).toBe("key_reused");
      expect(await code(writeOff(jobId, costId))).toBe("quote_written_off");
    });

    it("refuses a quote that is not back, invoiced, or not this job's, each with its own code", async () => {
      const job = await service.createFromBuild(ok("order_out"));
      const jobId = job!.id;
      await act(jobId, "PRINTED");
      await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 100 });
      const [sent] = await sql<{ id: string }>(`select id from lab_cost where lab_job_id = $1`, [jobId]);
      expect(await code(writeOff(jobId, sent.id))).toBe("quote_not_back");

      const { jobId: other, costId: back } = await backFromLab("order_other");
      // Another job's quote, and one that does not exist.
      expect(await code(writeOff(jobId, back))).toBe("quote_not_found");
      expect(await code(writeOff(jobId, "labcost_NOSUCHQUOTE"))).toBe("quote_not_found");
      await sql(`update lab_cost set deleted_at = now() where id = $1`, [sent.id]);
      expect(await code(writeOff(jobId, sent.id))).toBe("quote_not_found");

      await act(other, "LAB_INVOICED", { invoiced_satang: 100 });
      expect(await code(writeOff(other, back))).toBe("quote_invoiced");
      expect(
        await sql(`select count(*)::int as n from lab_cost where written_off_at is not null`),
      ).toEqual([{ n: 0 }]);
      expect(
        await sql(`select count(*)::int as n from production_event where action = 'LAB_QUOTE_WRITTEN_OFF'`),
      ).toEqual([{ n: 0 }]);
    });

    it("needs a reason, a quote, and the job as the screen showed it", async () => {
      const { jobId, costId } = await backFromLab();
      for (const reason of ["", "   ", 5, "x".repeat(301)]) {
        expect([reason, await code(writeOff(jobId, costId, undefined, reason))]).toEqual([reason, "invalid_detail"]);
      }
      expect(await code(act(jobId, "LAB_QUOTE_WRITTEN_OFF", { lab_cost_id: costId }))).toBe("invalid_detail");
      expect(await code(act(jobId, "LAB_QUOTE_WRITTEN_OFF", { reason: REASON }))).toBe("invalid_detail");
      const without = service.applyProductionAction({
        job_id: jobId,
        action: "LAB_QUOTE_WRITTEN_OFF",
        idempotency_key: key(),
        actor: OPS,
        detail: { lab_cost_id: costId, reason: REASON },
      });
      expect(await code(without)).toBe("invalid_detail");
      const stale = service.applyProductionAction({
        job_id: jobId,
        action: "LAB_QUOTE_WRITTEN_OFF",
        idempotency_key: key(),
        expected_version: (await version(jobId)) - 1,
        actor: OPS,
        detail: { lab_cost_id: costId, reason: REASON },
      });
      expect(await code(stale)).toBe("conflict");
      expect((await quote(costId)).written_off).toBe(false);
    });

    it("is possible on a cancelled job and on a held one: the lab may never bill either", async () => {
      const a = await backFromLab("order_cancel");
      await service.cancelJob(a.jobId);
      await writeOff(a.jobId, a.costId);
      expect((await quote(a.costId)).written_off).toBe(true);

      const b = await backFromLab("order_held");
      await act(b.jobId, "HOLD", { reason: "waiting" });
      await writeOff(b.jobId, b.costId);
      expect((await quote(b.costId)).written_off).toBe(true);
    });

    it("never carries the reason out of a database failure, to the caller, the answer, the log or Sentry", async () => {
      const { jobId, costId } = await backFromLab();
      // The database's own error text holds the row's reason, as a driver
      // error holds the values of the statement that failed.
      await sql(`
        create function test_fail() returns trigger language plpgsql as $$
        begin raise exception 'forced failure: %', NEW.written_off_reason; end $$;
        create trigger test_fail before update on lab_cost
          for each row execute function test_fail();`);
      // Control: the marker really is in the database's error.
      await expect(
        sql(`update lab_cost set written_off_reason = $2 where id = $1`, [costId, REASON]),
      ).rejects.toThrow(/Secretname/);
      let caught: unknown;
      try {
        await writeOff(jobId, costId);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const all = everythingIn(caught);
      expect(all).not.toMatch(/Secretname/);
      expect(all).toMatch(/P0001/);

      // The route's answer to that error: the HTTP body, the log line and
      // what is handed to Sentry, seen at the SDK: every error captured and
      // every tag and context set on its scope.
      const logged = jest.spyOn(console, "error").mockImplementation(() => {});
      const scoped: unknown[] = [];
      const scope = {
        setTag: (...a: unknown[]) => scoped.push(a),
        setContext: (...a: unknown[]) => scoped.push(a),
      };
      const withScope = jest
        .spyOn(sentry.Sentry, "withScope")
        .mockImplementation(((cb: (s: typeof scope) => unknown) => cb(scope)) as never);
      const captured = jest.spyOn(sentry.Sentry, "captureException").mockImplementation(() => "");
      const res = { status: jest.fn(), json: jest.fn() };
      res.status.mockReturnValue(res);
      try {
        sendProductionError(res as never, caught, "admin/lab-jobs/ops-actions", jobId);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(captured).toHaveBeenCalledTimes(1);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(res.json.mock.calls)).not.toMatch(/Secretname/);
        expect(JSON.stringify(logged.mock.calls)).not.toMatch(/Secretname/);
        const sentToSentry = [
          ...captured.mock.calls.map(([err]) => everythingIn(err)),
          JSON.stringify(scoped),
        ].join("\n");
        expect(sentToSentry).not.toMatch(/Secretname/);
      } finally {
        logged.mockRestore();
        withScope.mockRestore();
        captured.mockRestore();
      }
      // Rolled back whole: no event either.
      expect(
        await sql(`select count(*)::int as n from production_event where action = 'LAB_QUOTE_WRITTEN_OFF'`),
      ).toEqual([{ n: 0 }]);
    });
  });

  describe("an invoice after a write-off", () => {
    it("is still taken, reverses the write-off in the same step, and says so in the history", async () => {
      const { jobId, costId } = await backFromLab();
      await writeOff(jobId, costId);
      await act(jobId, "LAB_INVOICED", { invoiced_satang: 40000 });
      const q = await quote(costId);
      // Invoiced now; the write-off stays on record as it was made.
      expect(q).toMatchObject({ invoiced_satang: 40000, written_off: true, written_off_by: "user_ops_1" });
      const [row] = await sql(`select * from lab_cost where id = $1`, [costId]);
      expect(writeOffRefusal(row as never)?.code).toBe("quote_invoiced");
      const [event] = await sql(
        `select action, detail from production_event where lab_job_id = $1 order by seq desc limit 1`,
        [jobId],
      );
      expect(event).toEqual({
        action: "LAB_INVOICED",
        detail: { invoiced_satang: 40000, lab_cost_id: costId, reversed_write_off: true },
      });
    });

    it("goes to a quote still waiting for one before a written-off one", async () => {
      const { jobId, costId: first } = await backFromLab("order_twice", 40000);
      // QC fails, the remake goes out to the same lab again and comes back.
      await act(jobId, "MOUNTED");
      await act(jobId, "QC_FAILED", { reason: "axis" });
      await act(jobId, "REMAKE_STARTED", { cause: "axis" });
      await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 30000 });
      await act(jobId, "RECEIVED_FROM_LAB");
      const [second] = await sql<{ id: string }>(
        `select id from lab_cost where lab_job_id = $1 and id <> $2`,
        [jobId, first],
      );
      // The remake is the one the lab does not bill: the NEWER quote.
      await writeOff(jobId, second.id);
      await act(jobId, "LAB_INVOICED", { invoiced_satang: 40000 });
      expect(await quote(first)).toMatchObject({ invoiced_satang: 40000, written_off: false });
      expect(await quote(second.id)).toMatchObject({ invoiced_satang: null, written_off: true });
      const [event] = await sql(
        `select detail from production_event where lab_job_id = $1 order by seq desc limit 1`,
        [jobId],
      );
      expect(event.detail).toEqual({ invoiced_satang: 40000 });
    });
  });

  describe("an invoice that names its quote", () => {
    /** Quote A sent and never back (the job was re-sent after a changed
     *  prescription), quote B back and written off. */
    async function twoQuotes(orderId: string): Promise<{ jobId: string; a: string; b: string }> {
      const job = await service.createFromBuild(ok(orderId));
      const jobId = job!.id;
      await act(jobId, "PRINTED");
      await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 40000 });
      await service.applyProductionAction({
        job_id: jobId,
        action: "RX_CHANGED",
        idempotency_key: key(),
        actor: { type: "system", id: "test" },
      });
      await service.updateJobFromBuild(jobId, ok(orderId));
      await act(jobId, "PRINTED");
      await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 45000 });
      await act(jobId, "RECEIVED_FROM_LAB");
      const rows = await sql<{ id: string; quoted_satang: number }>(
        `select id, quoted_satang from lab_cost where lab_job_id = $1 order by quoted_satang`,
        [jobId],
      );
      const [a, b] = rows.map((r) => r.id);
      await writeOff(jobId, b);
      return { jobId, a, b };
    }

    it("lands on the quote it names", async () => {
      const { jobId, a, b } = await twoQuotes("order_named");
      await act(jobId, "LAB_INVOICED", { invoiced_satang: 40000, lab_cost_id: a });
      expect(await quote(a)).toMatchObject({ back: false, invoiced_satang: 40000, written_off: false });
      expect(await quote(b)).toMatchObject({ invoiced_satang: null, written_off: true });
      const [event] = await sql(
        `select detail from production_event where lab_job_id = $1 order by seq desc limit 1`,
        [jobId],
      );
      expect(event.detail).toEqual({ invoiced_satang: 40000, lab_cost_id: a });
    });

    it("without a name, goes to work that came back, a written-off quote before one never back", async () => {
      const { jobId, a, b } = await twoQuotes("order_unnamed");
      await act(jobId, "LAB_INVOICED", { invoiced_satang: 45000 });
      expect(await quote(b)).toMatchObject({ invoiced_satang: 45000, written_off: true });
      expect(await quote(a)).toMatchObject({ invoiced_satang: null });
      const [event] = await sql(
        `select detail from production_event where lab_job_id = $1 order by seq desc limit 1`,
        [jobId],
      );
      expect(event.detail).toEqual({ invoiced_satang: 45000, lab_cost_id: b, reversed_write_off: true });
    });

    it("refuses a quote that is not this job's, is deleted, or is already invoiced", async () => {
      const { jobId, a, b } = await twoQuotes("order_refused");
      const other = await backFromLab("order_elsewhere");
      const invoice = (id: string) => act(jobId, "LAB_INVOICED", { invoiced_satang: 1, lab_cost_id: id });
      expect(await code(invoice(other.costId))).toBe("quote_not_found");
      expect(await code(invoice("labcost_NOSUCHQUOTE"))).toBe("quote_not_found");
      expect(await code(act(jobId, "LAB_INVOICED", { invoiced_satang: 1, lab_cost_id: "nope" }))).toBe(
        "invalid_detail",
      );
      await act(jobId, "LAB_INVOICED", { invoiced_satang: 45000, lab_cost_id: b });
      expect(await code(invoice(b))).toBe("quote_invoiced");
      await sql(`update lab_cost set deleted_at = now() where id = $1`, [a]);
      expect(await code(invoice(a))).toBe("quote_not_found");
      expect(await quote(other.costId)).toMatchObject({ invoiced_satang: null });
      expect(
        await sql(`select count(*)::int as n from lab_cost where invoiced_satang is not null`),
      ).toEqual([{ n: 1 }]);
    });

    it("chooses exactly as before on a job with no write-off", async () => {
      const job = await service.createFromBuild(ok("order_old_order"));
      const jobId = job!.id;
      await sql(`update lab_job set stage = 'mounted' where id = $1`, [jobId]);
      // Not back and oldest; two back at the same moment (the id decides);
      // one back and newest.
      for (const [id, created, received] of [
        ["labcost_p1", "2026-11-01T00:00:00Z", null],
        ["labcost_p2", "2026-11-02T00:00:00Z", "2026-11-05T00:00:00Z"],
        ["labcost_p0", "2026-11-02T00:00:00Z", "2026-11-04T00:00:00Z"],
        ["labcost_p3", "2026-11-03T00:00:00Z", "2026-11-06T00:00:00Z"],
      ]) {
        await sql(
          `insert into lab_cost (id, lab_job_id, vendor, quoted_satang, sent_event_id, created_at, received_at)
           values ($1, $2, 'Lab One', 100, 'prodevt_x', $3, $4)`,
          [id, jobId, created, received],
        );
      }
      const chosen: string[] = [];
      for (let i = 0; i < 4; i++) {
        // The choice the writer made before write-offs existed, word for word.
        const [old] = await sql<{ id: string }>(
          `select "id" from "lab_cost"
            where "lab_job_id" = $1 and "invoiced_satang" is null and "deleted_at" is null
            order by ("received_at" is null) asc, "created_at" asc, "id" asc limit 1`,
          [jobId],
        );
        await act(jobId, "LAB_INVOICED", { invoiced_satang: 100 + i });
        const [now] = await sql<{ id: string }>(
          `select id from lab_cost where lab_job_id = $1 and invoiced_satang = $2`,
          [jobId, 100 + i],
        );
        expect([i, now.id]).toEqual([i, old.id]);
        chosen.push(now.id);
      }
      expect(chosen).toEqual(["labcost_p0", "labcost_p2", "labcost_p3", "labcost_p1"]);
    });
  });

  describe("what the job screen offers against what the writer accepts", () => {
    it("offers a write-off on a quote exactly when the writer records it", async () => {
      // Written out by hand: what the writer answers for each quote state at
      // each stage, held or not ("ok" when it records the write-off).
      const IN_PRODUCTION = {
        sent: "quote_not_back",
        back: "ok",
        invoiced: "quote_invoiced",
        invoiced_unreceived: "quote_invoiced",
        written_off: "quote_written_off",
      };
      const EXPECTED: Record<string, Record<string, string>> = {
        received_from_lab: IN_PRODUCTION,
        mounted: IN_PRODUCTION,
        delivered: IN_PRODUCTION,
        cancelled: IN_PRODUCTION,
        // A job never put into production has no quote to write off.
        none: {
          sent: "not_allowed",
          back: "not_allowed",
          invoiced: "not_allowed",
          invoiced_unreceived: "not_allowed",
          written_off: "not_allowed",
        },
      };
      const disagreements: string[] = [];
      const at = new Date("2026-11-20T03:00:00Z");
      const states = [
        { name: "sent", received_at: null, invoiced_satang: null, invoiced_at: null, written_off_at: null },
        { name: "back", received_at: at, invoiced_satang: null, invoiced_at: null, written_off_at: null },
        { name: "invoiced", received_at: at, invoiced_satang: 5, invoiced_at: at, written_off_at: null },
        { name: "invoiced_unreceived", received_at: null, invoiced_satang: 5, invoiced_at: at, written_off_at: null },
        { name: "written_off", received_at: at, invoiced_satang: null, invoiced_at: null, written_off_at: at },
      ];
      const { jobId, costId } = await backFromLab("order_walk");
      for (const stage of ["received_from_lab", "mounted", "delivered", "cancelled", null]) {
        for (const hold of [false, true]) {
          for (const s of states) {
            await sql(`update lab_job set stage = $2, on_hold = $3 where id = $1`, [jobId, stage, hold]);
            await sql(
              `update lab_cost set received_at = $2, invoiced_satang = $3, invoiced_at = $4,
                      written_off_at = $5, written_off_by = null, written_off_reason = null
                where id = $1`,
              [costId, s.received_at, s.invoiced_satang, s.invoiced_at, s.written_off_at],
            );
            const job = await service.retrieveLabJob(jobId);
            const [row] = await sql(`select * from lab_cost where id = $1`, [costId]);
            const offered =
              wouldAccept(job as never, "LAB_QUOTE_WRITTEN_OFF") && writeOffRefusal(row as never) === null;
            const result = await code(writeOff(jobId, costId));
            const answer = result === "no error" ? "ok" : result;
            const expected = EXPECTED[stage ?? "none"][s.name];
            const where = `${stage ?? "no stage"}${hold ? "/held" : ""}/${s.name}`;
            if (answer !== expected) disagreements.push(`${where}: writer answered ${answer}, expected ${expected}`);
            if (offered !== (expected === "ok")) {
              disagreements.push(`${where}: offered ${offered}, expected ${expected === "ok"}`);
            }
          }
        }
      }
      expect(disagreements).toEqual([]);
    });
  });

  describe("lab totals for Klear Operations", () => {
    const SUNDAY = 0;
    let costN = 0;
    async function cost(quoted: number, receivedAt: string | null, writtenOffAt: string | null, invoicedAt: string | null) {
      await sql(
        `insert into lab_cost
           (id, lab_job_id, vendor, quoted_satang, sent_event_id, created_at, received_at,
            invoiced_satang, invoiced_at, written_off_at, written_off_by, written_off_reason)
         values ($1, 'labjob_seed', 'Lab One', $2, 'prodevt_seed', '2026-11-03T03:00:00Z', $3, $4, $5, $6, $7, $8)`,
        [
          `labcost_w${++costN}`,
          quoted,
          receivedAt,
          invoicedAt ? quoted : null,
          invoicedAt,
          writtenOffAt,
          writtenOffAt ? "user_ops_1" : null,
          writtenOffAt ? REASON : null,
        ],
      );
    }

    it("takes a written-off quote out of 'back, not invoiced' as of the day it was written off, and serves it as an amount", async () => {
      await sql(
        `insert into production_event
           (id, lab_job_id, seq, action, idempotency_key, actor_type, actor_id, detail, created_at)
         values ('prodevt_seed', 'labjob_seed', 1, 'READY', 'seed-key-0001', 'system', 'x', '{}', '2026-11-03T02:00:00Z')`,
      );
      // Back on the 5th, never invoiced, never written off.
      await cost(10000, "2026-11-05T03:00:00Z", null, null);
      // Back on the 5th, written off on the 6th.
      await cost(20000, "2026-11-05T03:00:00Z", "2026-11-06T03:00:00Z", null);
      // Back on the 5th, written off on the 10th (after the first window).
      await cost(30000, "2026-11-05T03:00:00Z", "2026-11-10T03:00:00Z", null);
      // Written off on the 6th, then invoiced on the 12th: the write-off is reversed.
      await cost(40000, "2026-11-05T03:00:00Z", "2026-11-06T03:00:00Z", "2026-11-12T03:00:00Z");

      await service.releaseDueWindows(new Date("2026-11-15T17:30:00Z"), SUNDAY);
      expect(
        await sql(
          `select as_of, quoted_uninvoiced_satang as open, written_off_satang as off,
                  invoiced_to_date_satang as invoiced
             from lab_total_day order by as_of`,
        ),
      ).toEqual([
        { as_of: "2026-11-08", open: 40000, off: 60000, invoiced: 0 },
        { as_of: "2026-11-15", open: 10000, off: 50000, invoiced: 40000 },
      ]);

      const windows = await service.listReleasedWindows(null);
      for (const w of windows) {
        for (const t of w.lab_totals) {
          expect(Object.keys(t).sort()).toEqual([
            "as_of",
            "id",
            "invoiced_to_date_satang",
            "quoted_uninvoiced_satang",
            "vendor",
            "written_off_satang",
          ]);
        }
      }
      expect(windows[0].lab_totals[0].written_off_satang).toBe(60000);
      // Never the reason, nor who wrote it off.
      expect(JSON.stringify(windows)).not.toMatch(/Secretname|user_ops|labcost_/);
    });
  });

  describe("the lab report", () => {
    it("counts quotes back and not invoiced apart from those written off, per lab", async () => {
      const a = await backFromLab("order_r1", 10000);
      await backFromLab("order_r2", 20000);
      const c = await backFromLab("order_r3", 30000);
      await writeOff(a.jobId, a.costId);
      await writeOff(c.jobId, c.costId);
      // Invoiced after the write-off: neither waiting nor written off.
      await act(c.jobId, "LAB_INVOICED", { invoiced_satang: 30000 });
      // Sent and not back: neither.
      const d = await service.createFromBuild(ok("order_r4"));
      await act(d!.id, "PRINTED");
      // The most recent spelling of that lab is the one shown.
      await act(d!.id, "SENT_TO_LAB", { vendor: " LAB  One ", quoted_satang: 99 });

      const report = await service.productionReport(4);
      expect(report.quotes).toEqual([
        {
          vendor: "LAB One",
          back_not_invoiced: 1,
          back_not_invoiced_satang: 20000,
          written_off: 1,
          written_off_satang: 10000,
        },
      ]);
      expect(JSON.stringify(report)).not.toMatch(/Secretname/);
    });

    it("leaves out a write-off older than the period asked for, but never a quote still waiting", async () => {
      const a = await backFromLab("order_old", 10000);
      const b = await backFromLab("order_wait", 20000);
      await writeOff(a.jobId, a.costId);
      await sql(`update lab_cost set written_off_at = now() - interval '200 days' where id = $1`, [a.costId]);
      await sql(`update lab_cost set received_at = now() - interval '200 days' where id = $1`, [b.costId]);
      expect((await service.productionReport(4)).quotes).toEqual([
        {
          vendor: "Lab One",
          back_not_invoiced: 1,
          back_not_invoiced_satang: 20000,
          written_off: 0,
          written_off_satang: 0,
        },
      ]);
    });
  });
}
