// What the production writer records for the Website (contract 6), on a
// real Postgres: the state to show, its sequence and its own time, written
// in the same transaction as the stage; and which sequence the Website has
// received.

import type LmsModuleService from "../service";
import type { ProductionAction } from "../production";
import type { BuildPacketResult } from "../types";
import { sql } from "./db-harness";

const USER = { type: "user" as const, id: "user_lab_1" };
const SYSTEM = { type: "system" as const, id: "test" };
let counter = 0;
const key = () => `projection-key-${++counter}-${Date.now()}`;

const built = (orderId: string): BuildPacketResult => ({
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
    submitted_at: "2026-11-25T00:00:00.000Z",
  },
});

type Projection = {
  projection_state: string | null;
  projection_seq: number;
  stage_version: number;
  projection_sent_seq: number;
  warranty_remakes: number;
};

async function projection(jobId: string): Promise<Projection> {
  const [row] = await sql<Projection>(
    `select projection_state, projection_seq, stage_version, projection_sent_seq, warranty_remakes
       from lab_job where id = $1`,
    [jobId],
  );
  return row;
}

/** Run inside the one runner in lms.db.spec.ts. */
export function projectionSuite(service: LmsModuleService): void {
  async function act(jobId: string, action: ProductionAction, detail?: Record<string, unknown>, happenedAt?: Date) {
    const [job] = await sql<{ stage_version: number }>(`select stage_version from lab_job where id = $1`, [jobId]);
    return service.applyProductionAction({
      job_id: jobId,
      action,
      idempotency_key: key(),
      expected_version: job.stage_version,
      actor: USER,
      detail,
      happened_at: happenedAt,
    });
  }
  const system = (jobId: string, action: ProductionAction, k: string) =>
    service.applyProductionAction({ job_id: jobId, action, idempotency_key: k, actor: SYSTEM });

  describe("the state the Website shows", () => {
    it("is recorded with each stage, numbered by the job's version, through a whole order and a warranty remake", async () => {
      const job = (await service.createFromBuild(built("order_proj_1")))!;
      const seen: Array<[string | null, boolean, number]> = [];
      const note = async () => {
        const p = await projection(job.id);
        seen.push([p.projection_state, p.projection_seq === p.stage_version, p.warranty_remakes]);
      };
      await note(); // ready
      await act(job.id, "PRINTED");
      await note();
      await act(job.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
      await note();
      await act(job.id, "EDGED");
      await act(job.id, "MOUNTED");
      await act(job.id, "QC_FAILED", { reason: "scratch" });
      await note();
      await act(job.id, "REMAKE_STARTED", { cause: "scratch" });
      await note();
      await act(job.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
      await act(job.id, "EDGED");
      await act(job.id, "MOUNTED");
      await act(job.id, "QC_PASSED");
      await note();
      await act(job.id, "PACKED");
      await note();
      await system(job.id, "LABELLED", "labelled:ful_proj_1");
      await note();
      await system(job.id, "DELIVERED", "delivered:ful_proj_1");
      await note();
      await act(job.id, "REMAKE_STARTED", { cause: "lens cracked" });
      await note();

      expect(seen).toEqual([
        ["pending_lab", true, 0],
        ["sent_to_lab", true, 0],
        ["in_production", true, 0],
        ["qc_fail", true, 0],
        ["in_production", true, 0], // a QC remake is still "being made" to the customer
        ["qc_pass", true, 0],
        ["assembled", true, 0],
        ["assembled", false, 0], // the label: nothing new to show
        ["assembled", false, 0], // the delivery: the carrier says so
        ["remake_required", true, 1], // after delivery: a warranty remake
      ]);
    });

    it("keeps the time it happened, when entered later from the paper log", async () => {
      const job = (await service.createFromBuild(built("order_proj_2")))!;
      const at = new Date(Date.now() - 3 * 3600 * 1000);
      await act(job.id, "PRINTED", undefined, at);
      const [row] = await sql<{ projection_at: Date }>(`select projection_at from lab_job where id = $1`, [job.id]);
      expect(new Date(row.projection_at).toISOString()).toBe(at.toISOString());
    });

    it("does not change with a note, a hold or a repeated action", async () => {
      const job = (await service.createFromBuild(built("order_proj_3")))!;
      const before = await projection(job.id);
      await act(job.id, "HOLD", { reason: "waiting for lens stock" });
      await act(job.id, "NOTE", { text: "called the customer" });
      await act(job.id, "RELEASE");
      expect(await projection(job.id)).toEqual(before);
      await system(job.id, "READY", `ready:${job.id}`); // the packet build's own key, again
      expect(await projection(job.id)).toEqual(before);
    });

    it("is not recorded when the action fails", async () => {
      const job = (await service.createFromBuild(built("order_proj_4")))!;
      const before = await projection(job.id);
      await expect(act(job.id, "QC_PASSED")).rejects.toThrow();
      expect(await projection(job.id)).toEqual(before);
    });
  });

  describe("what the Website has received", () => {
    it("lists jobs whose latest state was not received, and stops once it is", async () => {
      const job = (await service.createFromBuild(built("order_proj_5")))!;
      await act(job.id, "PRINTED");
      const p = await projection(job.id);
      expect((await service.listUnsentProjections()).map((j) => j.id)).toContain(job.id);
      expect(await service.getProjection(job.id)).toMatchObject({
        id: job.id,
        order_id: "order_proj_5",
        projection_state: "sent_to_lab",
        projection_seq: p.projection_seq,
        projection_sent_seq: 0,
        warranty_remakes: 0,
      });

      await service.markProjectionDelivered(job.id, p.projection_seq);
      expect((await service.listUnsentProjections()).map((j) => j.id)).not.toContain(job.id);
      // A late answer to an older send never takes it back.
      await service.markProjectionDelivered(job.id, p.projection_seq - 1);
      expect((await projection(job.id)).projection_sent_seq).toBe(p.projection_seq);

      await act(job.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100"] });
      expect((await service.listUnsentProjections()).map((j) => j.id)).toContain(job.id);
    });

    it("measures the 30 days from when the state was recorded, not from a back-dated lab time", async () => {
      const job = (await service.createFromBuild(built("order_proj_10")))!;
      await act(job.id, "PRINTED", undefined, new Date(Date.now() - 40 * 24 * 3600 * 1000));
      expect((await service.listUnsentProjections()).map((j) => j.id)).toContain(job.id);
      expect((await service.giveUpProjections()).map((j) => j.id)).not.toContain(job.id);
    });

    it("gives up on a job whose state has not been received for 30 days, and says so once", async () => {
      const job = (await service.createFromBuild(built("order_proj_6")))!;
      await sql(`update lab_job set projection_recorded_at = now() - interval '31 days' where id = $1`, [job.id]);
      expect((await service.listUnsentProjections()).map((j) => j.id)).not.toContain(job.id);
      expect((await service.giveUpProjections()).map((j) => j.id)).toContain(job.id);
      expect((await service.giveUpProjections()).map((j) => j.id)).not.toContain(job.id);
    });

    it("stops sending a state the Website keeps calling not ready, and gives it up", async () => {
      const job = (await service.createFromBuild(built("order_proj_7")))!;
      for (let i = 0; i < 48; i++) await service.markProjectionAttempt(job.id, true);
      expect((await service.listUnsentProjections()).map((j) => j.id)).not.toContain(job.id);
      expect((await service.giveUpProjections()).map((j) => j.id)).toContain(job.id);
      // A new state starts again.
      await act(job.id, "PRINTED");
      expect((await service.listUnsentProjections()).map((j) => j.id)).toContain(job.id);
    });

    it("tries the jobs tried longest ago first, never-tried ones before all", async () => {
      const a = (await service.createFromBuild(built("order_proj_8")))!;
      const b = (await service.createFromBuild(built("order_proj_9")))!;
      await service.markProjectionAttempt(a.id, false);
      const ids = (await service.listUnsentProjections()).map((j) => j.id);
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    });
  });
}
