import type LmsModuleService from "../service";
import { LabJobNotRebuildableError } from "../service";
import { ProductionError, type ProductionAction } from "../production";
import type { BuildPacketResult, LabJobPacket } from "../types";
import {
  migrationNames,
  resetDatabase,
  runMigrations,
  sql,
} from "./db-harness";

const PACKET: LabJobPacket = {
  job_ref: "klear-order_1",
  klear_order_id: "order_1",
  frame_sku: "KLR-1",
  lens_type: "single_vision",
  lens_index: 1.67,
  coating_addons: [],
  // Deliberately no real values: these tests never read the prescription.
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
};

const ok = (orderId: string): BuildPacketResult => ({
  outcome: "ok",
  packet: { ...PACKET, klear_order_id: orderId, job_ref: `klear-${orderId}` },
});
const pending = (orderId: string): BuildPacketResult => ({
  outcome: "pending_rx",
  reason: "awaiting prescription",
  snapshot: { job_ref: `klear-${orderId}`, klear_order_id: orderId },
});

const USER = { type: "user" as const, id: "user_lab_1" };
const SYSTEM = { type: "system" as const, id: "test" };
let keyCounter = 0;
const key = () => `test-key-${++keyCounter}-${Date.now()}`;

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProductionError) return err.code;
    throw err;
  }
  return "no error";
}

/** Run inside the one runner in lms.db.spec.ts. */
export function productionSuite(service: LmsModuleService): void {
    /** A person moving a job, reading the version first as a screen would. */
    async function act(
      jobId: string,
      action: ProductionAction,
      detail?: Record<string, unknown>,
    ) {
      const [job] = await sql<{ stage_version: number }>(
        `select stage_version from lab_job where id = $1`,
        [jobId],
      );
      return service.applyProductionAction({
        job_id: jobId,
        action,
        idempotency_key: key(),
        expected_version: job.stage_version,
        actor: USER,
        detail,
      });
    }

    async function readyJob(orderId = "order_1"): Promise<string> {
      const job = await service.createFromBuild(ok(orderId));
      return job!.id;
    }

    describe("the migrated schema", () => {
      it("serves every model the service lists", async () => {
        // Each list selects every column of its model, so a column the
        // migrations do not create fails here.
        await expect(service.listLabJobs({})).resolves.toEqual([]);
        await expect(service.listProductionEvents({})).resolves.toEqual([]);
        await expect(service.listLabUsages({})).resolves.toEqual([]);
        await expect(service.listLabCosts({})).resolves.toEqual([]);
      });

      it("gives jobs that existed before production a starting stage and the event that explains it", async () => {
        const names = migrationNames();
        const at = names.indexOf("Migration20261120000100");
        expect(at).toBeGreaterThan(0);
        await resetDatabase(names.slice(0, at));
        await sql(
          `insert into lab_job (id, order_id, status, packet_snapshot, attempts) values
             ('labjob_q', 'order_q', 'queued', '{}', 0),
             ('labjob_s', 'order_s', 'submitted', '{}', 1),
             ('labjob_c', 'order_c', 'cancelled', '{}', 0),
             ('labjob_p', 'order_p', 'pending_rx', '{}', 0),
             ('labjob_f', 'order_f', 'failed', '{}', 0),
             ('labjob_g', 'order_g', 'submitting', '{}', 0)`,
        );
        // A soft-deleted duplicate, and a job from long before production
        // existed: neither gets a stage.
        await sql(
          `insert into lab_job (id, order_id, status, packet_snapshot, attempts, deleted_at)
             values ('labjob_d', 'order_q', 'queued', '{}', 0, now())`,
        );
        await sql(
          `insert into lab_job (id, order_id, status, packet_snapshot, attempts, created_at)
             values ('labjob_o', 'order_o', 'queued', '{}', 0, now() - interval '60 days')`,
        );
        await runMigrations(names.slice(at));

        const jobs = await sql(
          `select id, stage, stage_version, event_seq, stage_since = updated_at as since_ok
             from lab_job order by id`,
        );
        expect(jobs).toEqual([
          { id: "labjob_c", stage: "cancelled", stage_version: 1, event_seq: 1, since_ok: true },
          { id: "labjob_d", stage: null, stage_version: 0, event_seq: 0, since_ok: null },
          { id: "labjob_f", stage: null, stage_version: 0, event_seq: 0, since_ok: null },
          { id: "labjob_g", stage: "ready", stage_version: 1, event_seq: 1, since_ok: true },
          { id: "labjob_o", stage: null, stage_version: 0, event_seq: 0, since_ok: null },
          { id: "labjob_p", stage: null, stage_version: 0, event_seq: 0, since_ok: null },
          { id: "labjob_q", stage: "ready", stage_version: 1, event_seq: 1, since_ok: true },
          { id: "labjob_s", stage: "ready", stage_version: 1, event_seq: 1, since_ok: true },
        ]);
        const events = await sql(
          `select lab_job_id, seq, action, to_stage from production_event order by lab_job_id`,
        );
        expect(events).toEqual([
          { lab_job_id: "labjob_c", seq: 1, action: "CANCELLED", to_stage: "cancelled" },
          { lab_job_id: "labjob_g", seq: 1, action: "READY", to_stage: "ready" },
          { lab_job_id: "labjob_q", seq: 1, action: "READY", to_stage: "ready" },
          { lab_job_id: "labjob_s", seq: 1, action: "READY", to_stage: "ready" },
        ]);
      });

      it("refuses update and delete on the event and usage tables", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
        for (const table of ["production_event", "lab_usage"]) {
          await expect(sql(`update ${table} set id = id`)).rejects.toThrow(/insert-only/);
          await expect(sql(`delete from ${table}`)).rejects.toThrow(/insert-only/);
        }
      });

      it("refuses a row inserted as already deleted, which would sit outside the unique indexes", async () => {
        const jobId = await readyJob();
        await expect(
          sql(
            `insert into production_event
               (id, lab_job_id, seq, action, idempotency_key, actor_type, actor_id, detail, deleted_at)
             values ('prodevt_x', $1, 1, 'READY', $2, 'system', 'x', '{}', now())`,
            [jobId, `ready:${jobId}`],
          ),
        ).rejects.toThrow(/insert-only/);
      });
    });

    describe("the packet build", () => {
      it("puts a job at ready when its packet builds, and not before", async () => {
        const waiting = await service.createFromBuild(pending("order_w"));
        expect(
          await sql(`select stage, event_seq from lab_job where id = $1`, [waiting!.id]),
        ).toEqual([{ stage: null, event_seq: 0 }]);
        expect(
          await code(
            service.applyProductionAction({
              job_id: waiting!.id,
              action: "READY",
              idempotency_key: key(),
              actor: SYSTEM,
            }),
          ),
        ).toBe("not_allowed");

        await service.updateJobFromBuild(waiting!.id, ok("order_w"));
        expect(
          await sql(`select stage, stage_version, event_seq from lab_job where id = $1`, [
            waiting!.id,
          ]),
        ).toEqual([{ stage: "ready", stage_version: 1, event_seq: 1 }]);

        // A second rebuild of a ready job records nothing more.
        await service.updateJobFromBuild(waiting!.id, ok("order_w"));
        expect(await service.listProductionEventsForJob(waiting!.id)).toHaveLength(1);
      });

      it("never lets a failed stage write break the hand-off, and the sweep repairs it", async () => {
        await sql(`
          create function test_fail() returns trigger language plpgsql as $$
          begin raise exception 'forced failure'; end $$;
          create trigger test_fail before insert on production_event
            for each row execute function test_fail();`);
        const job = await service.createFromBuild(ok("order_h"));
        expect(job!.status).toBe("queued");
        expect(await sql(`select stage from lab_job where id = $1`, [job!.id])).toEqual([
          { stage: null },
        ]);
        await sql(`drop trigger test_fail on production_event`);
        expect(await service.markStagelessJobsReady()).toBe(1);
        expect(await sql(`select stage from lab_job where id = $1`, [job!.id])).toEqual([
          { stage: "ready" },
        ]);
        expect(await service.markStagelessJobsReady()).toBe(0);
      });

      it("leaves a stageless job from long ago alone in the sweep", async () => {
        await sql(
          `insert into lab_job (id, order_id, status, packet_snapshot, attempts, created_at)
             values ('labjob_o', 'order_o', 'queued', '{}', 0, now() - interval '60 days')`,
        );
        expect(await service.markStagelessJobsReady()).toBe(0);
      });

      it("puts a job made with createJob at ready", async () => {
        const job = await service.createJob({ ...PACKET, klear_order_id: "order_cj" });
        expect(await sql(`select stage from lab_job where id = $1`, [job.id])).toEqual([
          { stage: "ready" },
        ]);
      });

      it("refuses to rebuild the packet of a job the lab has started on", async () => {
        const jobId = await readyJob("order_rb");
        await act(jobId, "PRINTED");
        await expect(service.updateJobFromBuild(jobId, ok("order_rb"))).rejects.toBeInstanceOf(
          LabJobNotRebuildableError,
        );
      });

      it("does not let the lab start a job whose packet is no longer built", async () => {
        const jobId = await readyJob("order_nb");
        // A retry whose rebuild now waits for a prescription: the job keeps
        // its stage but has no packet to work from.
        await service.updateJobFromBuild(jobId, pending("order_nb"));
        expect(await sql(`select status, stage from lab_job where id = $1`, [jobId])).toEqual([
          { status: "pending_rx", stage: "ready" },
        ]);
        expect(await code(act(jobId, "PRINTED"))).toBe("not_allowed");
        // It can still heal, because it never left ready.
        await service.updateJobFromBuild(jobId, ok("order_nb"));
        expect((await act(jobId, "PRINTED")).job.stage).toBe("printed");
      });

      it("sweeps every stageless job, not only the first page, and skips ones that have a stage", async () => {
        const staged = await readyJob("order_staged");
        await sql(
          `insert into lab_job (id, order_id, status, packet_snapshot, attempts)
             select 'labjob_n' || n, 'order_n' || n, 'queued', '{}', 0 from generate_series(1, 7) n`,
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await (service as any).markStagelessJobsReady(3)).toBe(7);
        expect(
          await sql(`select count(*)::int as n from lab_job where stage = 'ready'`),
        ).toEqual([{ n: 8 }]);
        expect(await service.listProductionEventsForJob(staged)).toHaveLength(1);
      });

      it("records one READY when the same order is created twice", async () => {
        const first = await service.createFromBuild(ok("order_dup"));
        const second = await service.createFromBuild(ok("order_dup"));
        expect(second!.id).toBe(first!.id);
        expect(await service.listProductionEventsForJob(first!.id)).toHaveLength(1);
      });
    });

    describe("an in-house job", () => {
      it("walks from ready to delivered, numbering every event and booking two lenses to the order", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
        await act(jobId, "EDGED");
        await act(jobId, "MOUNTED");
        await act(jobId, "QC_PASSED");
        const packed = await act(jobId, "PACKED");
        expect(packed.job.stage).toBe("packed");
        for (const action of ["LABELLED", "DELIVERED"] as const) {
          await service.applyProductionAction({
            job_id: jobId,
            action,
            idempotency_key: key(),
            actor: SYSTEM,
          });
        }

        const events = await service.listProductionEventsForJob(jobId);
        expect(events.map((e) => [e.seq, e.action, e.from_stage, e.to_stage])).toEqual([
          [1, "READY", null, "ready"],
          [2, "PRINTED", "ready", "printed"],
          [3, "LENS_ISSUED", "printed", "lens_issued"],
          [4, "EDGED", "lens_issued", "edged"],
          [5, "MOUNTED", "edged", "mounted"],
          [6, "QC_PASSED", "mounted", "qc_passed"],
          [7, "PACKED", "qc_passed", "packed"],
          [8, "LABELLED", "packed", "labelled"],
          [9, "DELIVERED", "labelled", "delivered"],
        ]);
        expect(events[2].actor_type).toBe("user");
        expect(events[2].actor_id).toBe(USER.id);
        expect(
          await sql(`select stage, stage_version, event_seq from lab_job where id = $1`, [jobId]),
        ).toEqual([{ stage: "delivered", stage_version: 9, event_seq: 9 }]);
        expect(
          await sql(`select sku, reason, qty from lab_usage order by sku`),
        ).toEqual([
          { sku: "LENS-SV-167-M0100", reason: "order", qty: -1 },
          { sku: "LENS-SV-167-M0125", reason: "order", qty: -1 },
        ]);
      });

      it("refuses a step out of order and a person recording a system step", async () => {
        const jobId = await readyJob();
        expect(await code(act(jobId, "EDGED"))).toBe("not_allowed");
        expect(await code(act(jobId, "LABELLED"))).toBe("not_allowed");
        expect(await code(act(jobId, "CANCELLED"))).toBe("not_allowed");
        expect(await code(act(jobId, "LENS_ISSUED", { lenses: ["LENS-1", "LENS-2"] }))).toBe(
          "not_allowed",
        );
        await act(jobId, "PRINTED");
        expect(await code(act(jobId, "LENS_ISSUED", { lenses: [] }))).toBe("invalid_detail");
        expect(await code(act(jobId, "LENS_ISSUED", { lenses: ["lower case"] }))).toBe(
          "invalid_detail",
        );
        expect(await service.listProductionEventsForJob(jobId)).toHaveLength(2);
      });

      it("books the replacement after a QC failure to spoilage and counts the remake", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        await act(jobId, "EDGED");
        await act(jobId, "MOUNTED");
        await act(jobId, "QC_FAILED", { reason: "axis off" });
        const remake = await act(jobId, "REMAKE_STARTED", { cause: "edging error" });
        expect(remake.job).toMatchObject({
          stage: "printed",
          remake_count: 1,
          next_issue_reason: "spoilage_replacement",
        });
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A"] });
        expect(
          await sql(`select sku, reason, qty from lab_usage order by created_at, sku`),
        ).toEqual([
          { sku: "LENS-A", reason: "order", qty: -1 },
          { sku: "LENS-B", reason: "order", qty: -1 },
          { sku: "LENS-A", reason: "spoilage_replacement", qty: -1 },
        ]);
      });

      it("asks whether the lens was cut when the prescription changes after issue, and puts an uncut lens back", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        const changed = await service.applyProductionAction({
          job_id: jobId,
          action: "RX_CHANGED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        expect(changed.job).toMatchObject({
          stage: "ready",
          cut_question_pending: true,
          next_issue_reason: "order",
        });
        // Nothing moves until the question is answered.
        expect(await code(act(jobId, "PRINTED"))).toBe("not_allowed");
        // Only a lens that was issued on this job can go back.
        expect(await code(act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-Z"] }))).toBe(
          "not_allowed",
        );
        const returned = await act(jobId, "LENS_RETURNED_UNUSED", {
          lenses: ["LENS-A", "LENS-B"],
        });
        expect(returned.job.cut_question_pending).toBe(false);
        expect(returned.event.to_stage).toBeNull();
        expect(
          await sql(`select sku, reason, qty from lab_usage where qty > 0 order by sku`),
        ).toEqual([
          { sku: "LENS-A", reason: "return_unused", qty: 1 },
          { sku: "LENS-B", reason: "return_unused", qty: 1 },
        ]);
        // The question is closed: it cannot be answered twice.
        expect(
          await code(act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-A"] })),
        ).toBe("not_allowed");
        expect(await code(act(jobId, "LENS_CUT_CONFIRMED"))).toBe("not_allowed");

        // The lens went back uncut, so the pair issued next is the order's
        // own lens cost, not a remake.
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-C", "LENS-D"] });
        expect(
          await sql(
            `select reason, sum(qty)::int as qty from lab_usage group by reason order by reason`,
          ),
        ).toEqual([
          { reason: "order", qty: -4 },
          { reason: "return_unused", qty: 2 },
        ]);
      });

      it("books the next pair as a remake when the issued lens had been cut", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        await service.applyProductionAction({
          job_id: jobId,
          action: "RX_CHANGED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        const cut = await act(jobId, "LENS_CUT_CONFIRMED");
        expect(cut.job).toMatchObject({ cut_question_pending: false, next_issue_reason: "remake" });
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-C", "LENS-D"] });
        expect(
          await sql(
            `select reason, sum(qty)::int as qty from lab_usage group by reason order by reason`,
          ),
        ).toEqual([
          { reason: "order", qty: -2 },
          { reason: "remake", qty: -2 },
        ]);
      });

      it("only puts back a lens from the issue the question is about, never one cut earlier", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        await act(jobId, "EDGED");
        const change = () =>
          service.applyProductionAction({
            job_id: jobId,
            action: "RX_CHANGED",
            idempotency_key: key(),
            actor: SYSTEM,
          });
        await change();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-C", "LENS-D"] });
        await change();
        // A and B were cut long ago.
        expect(
          await code(act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-A", "LENS-B"] })),
        ).toBe("not_allowed");
        await act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-C", "LENS-D"] });
        expect(await sql(`select sku from lab_usage where qty > 0 order by sku`)).toEqual([
          { sku: "LENS-C" },
          { sku: "LENS-D" },
        ]);
      });

      it("does not count a spoiled lens as one that can go back", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        await act(jobId, "LENS_SPOILED", { reason: "chipped" });
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A"] });
        await service.applyProductionAction({
          job_id: jobId,
          action: "RX_CHANGED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        expect(
          await code(act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-A", "LENS-A"] })),
        ).toBe("not_allowed");
      });

      it("treats cancelling an already cancelled job as done, whoever cancelled it", async () => {
        const jobId = await readyJob("order_cc");
        await service.applyProductionAction({
          job_id: jobId,
          action: "CANCELLED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        const row = await service.cancelJob(jobId);
        expect(row.status).toBe("cancelled");
        expect(await service.listProductionEventsForJob(jobId)).toHaveLength(2);
        // A job that never had a stage can be cancelled too.
        const waiting = await service.createFromBuild(pending("order_cw"));
        expect((await service.cancelJob(waiting!.id)).status).toBe("cancelled");
        expect(await sql(`select stage from lab_job where id = $1`, [waiting!.id])).toEqual([
          { stage: "cancelled" },
        ]);
      });

      it("does not let a submission that finishes late undo a cancel", async () => {
        const jobId = await readyJob("order_cs");
        await sql(`update lab_job set status = 'submitting' where id = $1`, [jobId]);
        await service.cancelJob(jobId);
        // What submitJob does when the provider call returns.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const late = await (service as any).finishSubmission_(jobId, {
          status: "queued",
          attempts: 1,
          last_error: "no provider",
        });
        expect(late).toBeNull();
        expect(await sql(`select status, stage from lab_job where id = $1`, [jobId])).toEqual([
          { status: "cancelled", stage: "cancelled" },
        ]);
      });

      it("will not put the same lens back twice", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        await service.applyProductionAction({
          job_id: jobId,
          action: "CANCELLED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        expect(
          await code(act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-A", "LENS-A"] })),
        ).toBe("not_allowed");
        await act(jobId, "LENS_RETURNED_UNUSED", { lenses: ["LENS-A"] });
        expect(await sql(`select sku, qty from lab_usage where qty > 0`)).toEqual([
          { sku: "LENS-A", qty: 1 },
        ]);
      });

      it("keeps status and stage in step when a job is cancelled, by either door", async () => {
        const a = await readyJob("order_ca");
        await service.applyProductionAction({
          job_id: a,
          action: "CANCELLED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        const b = await readyJob("order_cb");
        const row = await service.cancelJob(b);
        expect(row.status).toBe("cancelled");
        expect(
          await sql(`select status, stage from lab_job where id in ($1, $2)`, [a, b]),
        ).toEqual([
          { status: "cancelled", stage: "cancelled" },
          { status: "cancelled", stage: "cancelled" },
        ]);
        expect(await code(act(b, "PRINTED"))).toBe("not_allowed");
        expect((await service.listProductionEventsForJob(b)).map((e) => e.action)).toEqual([
          "READY",
          "CANCELLED",
        ]);
      });

      it("holds and releases without moving the job", async () => {
        const jobId = await readyJob();
        const held = await act(jobId, "HOLD", { reason: "waiting for lens stock" });
        expect(held.job).toMatchObject({
          stage: "ready",
          stage_version: 1,
          on_hold: true,
          hold_reason: "waiting for lens stock",
        });
        expect(await code(act(jobId, "HOLD", { reason: "again" }))).toBe("not_allowed");
        const released = await act(jobId, "RELEASE");
        expect(released.job).toMatchObject({ on_hold: false, hold_reason: null, stage_version: 1 });
      });

      it("refuses a warranty remake until the prescription is back in the packet", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] });
        for (const a of ["EDGED", "MOUNTED", "QC_PASSED", "PACKED"] as const) await act(jobId, a);
        for (const a of ["LABELLED", "DELIVERED"] as const) {
          await service.applyProductionAction({
            job_id: jobId,
            action: a,
            idempotency_key: key(),
            actor: SYSTEM,
          });
        }
        await sql(`update lab_job set rx_redacted_at = now() where id = $1`, [jobId]);
        expect(await code(act(jobId, "REMAKE_STARTED", { cause: "scratched" }))).toBe(
          "not_allowed",
        );
        await sql(`update lab_job set rx_redacted_at = null where id = $1`, [jobId]);
        const remake = await act(jobId, "REMAKE_STARTED", { cause: "scratched" });
        expect(remake.job).toMatchObject({
          stage: "printed",
          remake_count: 1,
          next_issue_reason: "remake",
        });
      });
    });

    describe("an outsourced job", () => {
      it("opens a quote when sent, marks it received, and takes the invoice", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        expect(await code(act(jobId, "LAB_INVOICED", { invoiced_satang: 1 }))).toBe(
          "not_allowed",
        );
        expect(await code(act(jobId, "SENT_TO_LAB", { vendor: "Lab One" }))).toBe(
          "invalid_detail",
        );
        await act(jobId, "SENT_TO_LAB", {
          vendor: "Lab One",
          quoted_satang: 45000,
          expected_on: "2026-11-27",
        });
        await act(jobId, "RECEIVED_FROM_LAB");
        await act(jobId, "MOUNTED");
        await act(jobId, "LAB_INVOICED", { invoiced_satang: 47000 });
        expect(
          await sql(
            `select vendor, quoted_satang, expected_on, received_at is not null as received,
                    invoiced_satang, invoiced_at is not null as invoiced
               from lab_cost`,
          ),
        ).toEqual([
          {
            vendor: "Lab One",
            quoted_satang: 45000,
            expected_on: "2026-11-27",
            received: true,
            invoiced_satang: 47000,
            invoiced: true,
          },
        ]);
        expect(await sql(`select count(*)::int as n from lab_usage`)).toEqual([{ n: 0 }]);
        // Invoiced once: a second invoice has no quote to land on.
        expect(await code(act(jobId, "LAB_INVOICED", { invoiced_satang: 1 }))).toBe(
          "not_allowed",
        );
      });
    });

    describe("an outsourced job sent twice", () => {
      it("puts the invoice on the quote whose work came back", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 40000 });
        await service.applyProductionAction({
          job_id: jobId,
          action: "RX_CHANGED",
          idempotency_key: key(),
          actor: SYSTEM,
        });
        await act(jobId, "PRINTED");
        await act(jobId, "SENT_TO_LAB", { vendor: "Lab One", quoted_satang: 45000 });
        await act(jobId, "RECEIVED_FROM_LAB");
        await act(jobId, "LAB_INVOICED", { invoiced_satang: 45000 });
        expect(
          await sql(
            `select quoted_satang, received_at is not null as received, invoiced_satang
               from lab_cost order by quoted_satang`,
          ),
        ).toEqual([
          { quoted_satang: 40000, received: false, invoiced_satang: null },
          { quoted_satang: 45000, received: true, invoiced_satang: 45000 },
        ]);
      });
    });

    describe("what an error may say", () => {
      it("never carries a lens SKU or a note's text out of a database failure", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await sql(`
          create function test_fail() returns trigger language plpgsql as $$
          begin raise exception 'forced failure'; end $$;
          create trigger test_fail before insert on lab_usage
            for each row execute function test_fail();`);
        let caught: unknown;
        try {
          await act(jobId, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0225", "LENS-SV-167-M0250"] });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        const everything = [
          String(caught),
          (caught as Error).stack ?? "",
          JSON.stringify(caught, Object.getOwnPropertyNames(caught as object)),
        ].join("\n");
        expect(everything).not.toMatch(/M0225|M0250/);
        expect(everything).not.toContain(jobId);
        expect(everything).toMatch(/P0001/);
      });

      it("still names the kind of failure when Medusa has rewritten the error", async () => {
        const jobId = await readyJob();
        // A clash on (lab_job_id, seq): Medusa turns it into its own error,
        // which has no database code.
        await sql(
          `insert into production_event
             (id, lab_job_id, seq, action, idempotency_key, actor_type, actor_id, detail)
           values ('prodevt_clash', $1, 2, 'NOTE', 'clash-key-0001', 'system', 'x', '{}')`,
          [jobId],
        );
        let caught: unknown;
        try {
          await act(jobId, "PRINTED");
        } catch (err) {
          caught = err;
        }
        expect((caught as Error).name).toBe("ProductionWriteError");
        expect((caught as Error).message).toMatch(/invalid_data/);
        expect((caught as Error).message).not.toContain(jobId);
      });

      it("refuses a time or a version that is not one", async () => {
        const jobId = await readyJob();
        expect(
          await code(
            service.applyProductionAction({
              job_id: jobId,
              action: "NOTE",
              idempotency_key: key(),
              actor: USER,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              happened_at: "2026-11-20T00:00:00Z" as any,
              detail: { text: "x" },
            }),
          ),
        ).toBe("invalid_detail");
        expect(
          await code(
            service.applyProductionAction({
              job_id: jobId,
              action: "PRINTED",
              idempotency_key: key(),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              expected_version: "1" as any,
              actor: USER,
            }),
          ),
        ).toBe("invalid_detail");
      });
    });

    describe("concurrency and repeats", () => {
      it("treats a missing optional field and an absent one as the same request, and two times as different", async () => {
        const jobId = await readyJob();
        const k1 = key();
        const note = (detail: Record<string, unknown>, k: string) =>
          service.applyProductionAction({
            job_id: jobId,
            action: "NOTE",
            idempotency_key: k,
            actor: USER,
            detail,
          });
        await note({ text: "x" }, k1);
        expect((await note({ text: "x", extra: undefined }, k1)).replayed).toBe(true);
        const k2 = key();
        await note({ text: "x", when: new Date("2026-11-01T00:00:00Z") }, k2);
        expect(await code(note({ text: "x", when: new Date("2026-11-02T00:00:00Z") }, k2))).toBe(
          "key_reused",
        );
      });

      it("refuses a repeated key that carries different details", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        const input = {
          job_id: jobId,
          action: "LENS_ISSUED" as const,
          idempotency_key: key(),
          expected_version: 2,
          actor: USER,
          detail: { lenses: ["LENS-A", "LENS-B"] },
        };
        await service.applyProductionAction(input);
        expect((await service.applyProductionAction(input)).replayed).toBe(true);
        expect(
          await code(
            service.applyProductionAction({ ...input, detail: { lenses: ["LENS-X", "LENS-Y"] } }),
          ),
        ).toBe("key_reused");
      });

      it("returns the first result when a key is repeated, and writes nothing more", async () => {
        const jobId = await readyJob();
        const input = {
          job_id: jobId,
          action: "PRINTED" as const,
          idempotency_key: key(),
          expected_version: 1,
          actor: USER,
        };
        const first = await service.applyProductionAction(input);
        // The repeat carries the version the screen saw before the first
        // press. It must come back as the first result, not as a conflict.
        const again = await service.applyProductionAction(input);
        expect(first.replayed).toBe(false);
        expect(again.replayed).toBe(true);
        expect(again.event.id).toBe(first.event.id);
        expect(again.job.stage_version).toBe(2);
        expect(await service.listProductionEventsForJob(jobId)).toHaveLength(2);
        expect(
          await code(service.applyProductionAction({ ...input, action: "NOTE", detail: { text: "x" } })),
        ).toBe("key_reused");
      });

      it("refuses an action based on a version the job has left", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        expect(
          await code(
            service.applyProductionAction({
              job_id: jobId,
              action: "LENS_ISSUED",
              idempotency_key: key(),
              expected_version: 1,
              actor: USER,
              detail: { lenses: ["LENS-A", "LENS-B"] },
            }),
          ),
        ).toBe("conflict");
        expect(await sql(`select count(*)::int as n from lab_usage`)).toEqual([{ n: 0 }]);
      });

      it("lets exactly one of two people win when they act on the same job at once", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        const attempt = (lenses: string[]) =>
          code(
            service.applyProductionAction({
              job_id: jobId,
              action: "LENS_ISSUED",
              idempotency_key: key(),
              expected_version: 2,
              actor: USER,
              detail: { lenses },
            }),
          );
        const results = await Promise.all([
          attempt(["LENS-A", "LENS-B"]),
          attempt(["LENS-C", "LENS-D"]),
          attempt(["LENS-E", "LENS-F"]),
        ]);
        expect(results.filter((r) => r === "no error")).toHaveLength(1);
        expect(results.filter((r) => r === "conflict")).toHaveLength(2);
        expect(await sql(`select count(*)::int as n from lab_usage`)).toEqual([{ n: 2 }]);
        expect(
          await sql(`select stage, stage_version, event_seq from lab_job where id = $1`, [jobId]),
        ).toEqual([{ stage: "lens_issued", stage_version: 3, event_seq: 3 }]);
      });

      it("records one event when the same press arrives twice at once", async () => {
        const jobId = await readyJob();
        const input = {
          job_id: jobId,
          action: "PRINTED" as const,
          idempotency_key: key(),
          expected_version: 1,
          actor: USER,
        };
        const [a, b] = await Promise.all([
          service.applyProductionAction(input),
          service.applyProductionAction(input),
        ]);
        expect(a.event.id).toBe(b.event.id);
        expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
        expect(await service.listProductionEventsForJob(jobId)).toHaveLength(2);
      });

      it("numbers notes written at the same moment without a gap or a clash", async () => {
        const jobId = await readyJob();
        await Promise.all(
          [1, 2, 3, 4, 5].map((n) =>
            service.applyProductionAction({
              job_id: jobId,
              action: "NOTE",
              idempotency_key: key(),
              actor: USER,
              detail: { text: `note ${n}` },
            }),
          ),
        );
        const events = await service.listProductionEventsForJob(jobId);
        expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
      });

      it("rolls the whole action back when a later write fails", async () => {
        const jobId = await readyJob();
        await act(jobId, "PRINTED");
        await sql(`
          create function test_fail() returns trigger language plpgsql as $$
          begin raise exception 'forced failure'; end $$;
          create trigger test_fail before insert on lab_usage
            for each row execute function test_fail();`);
        await expect(
          act(jobId, "LENS_ISSUED", { lenses: ["LENS-A", "LENS-B"] }),
        ).rejects.toThrow(/could not be recorded/);
        expect(
          await sql(`select stage, stage_version, event_seq from lab_job where id = $1`, [jobId]),
        ).toEqual([{ stage: "printed", stage_version: 2, event_seq: 2 }]);
        expect(await service.listProductionEventsForJob(jobId)).toHaveLength(2);
      });
    });
}
