import type LmsModuleService from "../service";
import { LMS_MODULE, LabJobNotRebuildableError } from "../service";
import { recordOrderEvent, recordOrderEventSafely } from "../order-events";
import { ProductionWriteError } from "../service";
import { applyChangedPrescription } from "../rebuild";
import { buildLabJobPacket } from "../build-packet";
import labJobOrderEventsHandler from "../../../subscribers/lab-job-order-events";
import type { BuildPacketResult, LabJobPacket } from "../types";
import { sql } from "./db-harness";

jest.mock("../build-packet", () => ({ buildLabJobPacket: jest.fn() }));
const mockBuild = buildLabJobPacket as jest.MockedFunction<typeof buildLabJobPacket>;

const packet = (orderId: string, lensIndex = 1.67): LabJobPacket => ({
  job_ref: `klear-${orderId}`,
  klear_order_id: orderId,
  frame_sku: "KLR-1",
  lens_type: "single_vision",
  lens_index: lensIndex,
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
});
const ok = (orderId: string, lensIndex?: number): BuildPacketResult => ({
  outcome: "ok",
  packet: packet(orderId, lensIndex),
});

/** Run inside the one runner in lms.db.spec.ts. */
export function orderEventsSuite(service: LmsModuleService): void {
  // The real service behind a container, as a subscriber sees it.
  const container = {
    resolve: (key: string) => {
      if (key === LMS_MODULE) return service;
      if (key === "query") {
        return {
          // Medusa's fulfillments, as far as these tests need them.
          graph: async ({ filters }: { filters: { id: string[] } }) => ({
            data: filters.id.map((id) => ({
              id,
              order: { id: "order_e" },
              canceled_at: cancelledInMedusa.has(id) ? new Date() : null,
            })),
          }),
        };
      }
      throw new Error(`unexpected resolve(${key})`);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const cancelledInMedusa = new Set<string>();
  beforeEach(() => cancelledInMedusa.clear());

  let n = 0;
  async function walk(jobId: string, actions: string[]) {
    for (const action of actions) {
      const [row] = await sql<{ stage_version: number }>(
        `select stage_version from lab_job where id = $1`,
        [jobId],
      );
      await service.applyProductionAction({
        job_id: jobId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        action: action as any,
        idempotency_key: `walk-${++n}-${Date.now()}`,
        expected_version: row.stage_version,
        actor: { type: "user", id: "user_1" },
        detail: action === "LENS_ISSUED" ? { lenses: ["LENS-A", "LENS-B"] } : undefined,
      });
    }
  }
  const TO_PACKED = ["PRINTED", "LENS_ISSUED", "EDGED", "MOUNTED", "QC_PASSED", "PACKED"];
  const stage = async (jobId: string) =>
    (await sql<{ stage: string; status: string }>(`select stage, status from lab_job where id = $1`, [jobId]))[0];
  const emit = (name: string, data: Record<string, unknown>) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labJobOrderEventsHandler({ event: { name, data }, container } as any);

  describe("order events on a lab job", () => {
    beforeEach(() => {
      jest.spyOn(console, "info").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    it("follows a packed job through label, label cancelled, label again and delivery, once each", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);

      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_0" });
      expect((await stage(job!.id)).stage).toBe("labelled");
      // The same event delivered again records nothing.
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_0" });

      await emit("order.fulfillment_canceled", { order_id: "order_e", fulfillment_id: "ful_0" });
      expect((await stage(job!.id)).stage).toBe("packed");

      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_1" });
      expect((await stage(job!.id)).stage).toBe("labelled");

      // delivery.created carries the fulfillment id only; the order is looked up.
      await emit("delivery.created", { id: "ful_1" });
      await emit("delivery.created", { id: "ful_1" });
      expect((await stage(job!.id)).stage).toBe("delivered");

      const events = await service.listProductionEventsForJob(job!.id);
      expect(events.slice(7).map((e) => [e.action, e.actor_type, e.actor_id])).toEqual([
        ["LABELLED", "system", "event:order.fulfillment_created"],
        ["LABEL_CANCELLED", "system", "event:order.fulfillment_canceled"],
        ["LABELLED", "system", "event:order.fulfillment_created"],
        ["DELIVERED", "system", "event:delivery.created"],
      ]);
    });

    it("says so, and changes nothing, when the job is not where the event needs it", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      expect(
        await recordOrderEvent(container, "order_e", "LABELLED", "labelled:ful_x", "test"),
      ).toBe("refused");
      expect(await recordOrderEvent(container, "order_e", "DELIVERED", "delivered:ful_x", "test")).toBe(
        "refused",
      );
      expect((await stage(job!.id)).stage).toBe("ready");
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(1);
    });

    it("ignores an order with no lab job", async () => {
      expect(
        await recordOrderEvent(container, "order_frame_only", "LABELLED", "labelled:ful_y", "test"),
      ).toBe("no_job");
      await emit("order.canceled", { id: "order_frame_only" });
      // Events missing the ids they should carry are ignored, not guessed at.
      await emit("order.fulfillment_created", { order_id: "order_frame_only" });
      await emit("delivery.created", {});
      expect(await sql(`select count(*)::int as n from production_event`)).toEqual([{ n: 0 }]);
    });

    it("lets only the fulfillment that labelled the job cancel that label or deliver it", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_A" });
      // A second fulfillment on the same order (an accessory, a split
      // parcel): it is not the glasses' label.
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_B" });
      await emit("order.fulfillment_canceled", { order_id: "order_e", fulfillment_id: "ful_B" });
      expect((await stage(job!.id)).stage).toBe("labelled");
      expect(
        await recordOrderEvent(container, "order_e", "DELIVERED", "delivered:ful_B", "test", "ful_B"),
      ).toBe("refused");
      expect((await stage(job!.id)).stage).toBe("labelled");
      expect(
        await recordOrderEvent(container, "order_e", "DELIVERED", "delivered:ful_A", "test", "ful_A"),
      ).toBe("recorded");
      expect((await stage(job!.id)).stage).toBe("delivered");
    });

    it("moves the label to a new fulfillment when the old one was cancelled and that cancel was never recorded", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_A" });
      // A is cancelled in Medusa, but its cancel event was lost.
      cancelledInMedusa.add("ful_A");
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_B" });
      await emit("delivery.created", { id: "ful_B" });
      expect((await stage(job!.id)).stage).toBe("delivered");
      const events = await service.listProductionEventsForJob(job!.id);
      expect(events.slice(7).map((e) => [e.action, e.idempotency_key])).toEqual([
        ["LABELLED", "labelled:ful_A"],
        ["LABEL_CANCELLED", "label-cancelled:ful_A"],
        ["LABELLED", "labelled:ful_B"],
        ["DELIVERED", "delivered:ful_B"],
      ]);
    });

    it("still follows the label after a thousand other events on the job", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      await sql(
        `insert into production_event
           (id, lab_job_id, seq, action, idempotency_key, actor_type, actor_id, detail)
         select 'prodevt_bulk' || g, $1, 7 + g, 'PACKET_VIEWED', 'bulk-view-' || g, 'user', 'u', '{}'
           from generate_series(1, 1100) g`,
        [job!.id],
      );
      await sql(`update lab_job set event_seq = 1107 where id = $1`, [job!.id]);
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_A" });
      await emit("delivery.created", { id: "ful_A" });
      expect((await stage(job!.id)).stage).toBe("delivered");
    });

    it("tries again when the write fails for a passing reason, and never throws when it keeps failing", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      jest.spyOn(console, "error").mockImplementation(() => {});
      let failures = 2;
      let attempts = 0;
      const flaky = {
        resolve: (key: string) => {
          if (key !== LMS_MODULE) return container.resolve(key);
          return {
            getJobByOrderId: (id: string) => service.getJobByOrderId(id),
            lastLabelKey: (id: string) => service.lastLabelKey(id),
            hasProductionEventKey: (k: string) => service.hasProductionEventKey(k),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            applyProductionAction: (input: any) => {
              attempts++;
              if (failures-- > 0) throw new ProductionWriteError({ code: "55P03" });
              return service.applyProductionAction(input);
            },
          };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      expect(
        await recordOrderEventSafely(flaky, "order_e", "LABELLED", "labelled:ful_A", "test", "ful_A"),
      ).toBe("recorded");
      expect(attempts).toBe(3);
      expect((await stage(job!.id)).stage).toBe("labelled");

      failures = 99;
      attempts = 0;
      expect(
        await recordOrderEventSafely(flaky, "order_e", "LABEL_CANCELLED", "label-cancelled:ful_A", "test", "ful_A"),
      ).toBe("failed");
      expect(attempts).toBe(3);
      expect((await stage(job!.id)).stage).toBe("labelled");
    });

    it("cancels the job with its order, once", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await emit("order.canceled", { id: "order_e" });
      expect(await stage(job!.id)).toEqual({ stage: "cancelled", status: "cancelled" });
      // Redelivered, and cancelled again by another door: still one event.
      await emit("order.canceled", { id: "order_e" });
      expect(await recordOrderEvent(container, "order_e", "CANCELLED", "another-key-1", "test")).toBe(
        "repeat",
      );
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(2);
    });
  });

  describe("a changed prescription on a job in production", () => {
    beforeEach(() => mockBuild.mockReset());

    it("rebuilds the packet, sends the job back to ready and asks about the issued lens", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED", "LENS_ISSUED"]);
      mockBuild.mockResolvedValue(ok("order_e", 1.74));

      // Whatever order the builder is asked about, it is the job's own.
      const result = await applyChangedPrescription(container, job!.id, "rx-key-0001", "user_9");
      expect(mockBuild).toHaveBeenCalledWith(expect.objectContaining({ orderId: "order_e" }));
      expect(result.outcome).toBe("changed");
      expect(
        await sql(
          `select stage, cut_question_pending, packet_snapshot->>'lens_index' as lens_index
             from lab_job where id = $1`,
          [job!.id],
        ),
      ).toEqual([{ stage: "ready", cut_question_pending: true, lens_index: "1.74" }]);
      const events = await service.listProductionEventsForJob(job!.id);
      expect(events[events.length - 1]).toMatchObject({
        action: "RX_CHANGED",
        actor_id: "rx-changed:user_9",
      });

      // The same request again: no second event, packet still the new one.
      await applyChangedPrescription(container, job!.id, "rx-key-0001", "user_9");
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(events.length);
      expect(await stage(job!.id)).toEqual({ stage: "ready", status: "queued" });
    });

    it("keeps the lab from printing the old packet if storing the new one fails, and heals on the next rebuild", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED"]);
      mockBuild.mockResolvedValue(ok("order_e", 1.74));
      const failing = {
        resolve: (key: string) => {
          if (key !== LMS_MODULE) return container.resolve(key);
          return {
            retrieveLabJob: (id: string) => service.retrieveLabJob(id),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            applyProductionAction: (input: any) => service.applyProductionAction(input),
            updateJobFromBuild: async () => {
              throw new Error("db blip");
            },
          };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
      await expect(
        applyChangedPrescription(failing, job!.id, "rx-key-0004", "user_9"),
      ).rejects.toThrow("db blip");
      // Back at ready, but with no packet to work from: it cannot be printed.
      expect(await stage(job!.id)).toEqual({ stage: "ready", status: "pending_rx" });
      const [row] = await sql<{ stage_version: number }>(
        `select stage_version from lab_job where id = $1`,
        [job!.id],
      );
      await expect(
        service.applyProductionAction({
          job_id: job!.id,
          action: "PRINTED",
          idempotency_key: "print-old-packet-1",
          expected_version: row.stage_version,
          actor: { type: "user", id: "user_1" },
        }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      // The same request again (or the half-hourly heal sweep) finishes it.
      const again = await applyChangedPrescription(container, job!.id, "rx-key-0004", "user_9");
      expect(again.outcome).toBe("changed");
      expect(
        await sql(
          `select stage, status, packet_snapshot->>'lens_index' as lens_index from lab_job where id = $1`,
          [job!.id],
        ),
      ).toEqual([{ stage: "ready", status: "queued", lens_index: "1.74" }]);
    });

    it("answers plainly when the same request is repeated after the lab has moved on", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED"]);
      mockBuild.mockResolvedValue(ok("order_e", 1.74));
      await applyChangedPrescription(container, job!.id, "rx-key-0007", "user_9");
      await walk(job!.id, ["PRINTED", "LENS_ISSUED"]);
      const again = await applyChangedPrescription(container, job!.id, "rx-key-0007", "user_9");
      expect(again.outcome).toBe("changed");
      expect(await stage(job!.id)).toEqual({ stage: "lens_issued", status: "queued" });
      expect(
        (await service.listProductionEventsForJob(job!.id)).filter((e) => e.action === "RX_CHANGED"),
      ).toHaveLength(1);
    });

    it("answers too_late when a label is booked while the new packet is being built", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      // The label lands after the stage was read and before RX_CHANGED.
      mockBuild.mockImplementation(async () => {
        await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_A" });
        return ok("order_e", 1.74);
      });
      expect(await applyChangedPrescription(container, job!.id, "rx-key-0008", "user_9")).toEqual({
        outcome: "too_late",
        stage: "labelled",
      });
      expect(
        await sql(`select packet_snapshot->>'lens_index' as lens_index from lab_job where id = $1`, [
          job!.id,
        ]),
      ).toEqual([{ lens_index: "1.67" }]);
    });

    it("refuses RX_CHANGED on a job whose packet a lab provider already has", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED"]);
      await sql(`update lab_job set status = 'submitted' where id = $1`, [job!.id]);
      await expect(
        service.applyProductionAction({
          job_id: job!.id,
          action: "RX_CHANGED",
          idempotency_key: "rx-direct-0001",
          actor: { type: "system", id: "test" },
        }),
      ).rejects.toMatchObject({ code: "not_allowed" });
      expect(await stage(job!.id)).toEqual({ stage: "printed", status: "submitted" });
    });

    it("answers, without building or recording anything, for a job that is not in production or already out", async () => {
      const waiting = await service.createFromBuild({
        outcome: "pending_rx",
        reason: "awaiting prescription",
        snapshot: { job_ref: "klear-order_w", klear_order_id: "order_w" },
      });
      expect(
        await applyChangedPrescription(container, waiting!.id, "rx-key-0005", "user_9"),
      ).toEqual({ outcome: "not_in_production" });
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, TO_PACKED);
      await emit("order.fulfillment_created", { order_id: "order_e", fulfillment_id: "ful_A" });
      expect(await applyChangedPrescription(container, job!.id, "rx-key-0006", "user_9")).toEqual({
        outcome: "too_late",
        stage: "labelled",
      });
      expect(mockBuild).not.toHaveBeenCalled();
    });

    it("touches nothing when the new packet cannot be built", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED"]);
      mockBuild.mockResolvedValue({
        outcome: "pending_rx",
        reason: "awaiting prescription",
        snapshot: { job_ref: "klear-order_e", klear_order_id: "order_e" },
      });
      const result = await applyChangedPrescription(container, job!.id, "rx-key-0002", "user_9");
      expect(result).toMatchObject({ outcome: "not_built", buildOutcome: "pending_rx" });
      expect(await stage(job!.id)).toEqual({ stage: "printed", status: "queued" });
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(2);
    });

    it("refuses, before recording anything, a job whose packet cannot be replaced", async () => {
      const job = await service.createFromBuild(ok("order_e"));
      await walk(job!.id, ["PRINTED"]);
      await sql(`update lab_job set status = 'submitted' where id = $1`, [job!.id]);
      mockBuild.mockResolvedValue(ok("order_e", 1.74));
      await expect(
        applyChangedPrescription(container, job!.id, "rx-key-0003", "user_9"),
      ).rejects.toBeInstanceOf(LabJobNotRebuildableError);
      expect(mockBuild).not.toHaveBeenCalled();
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(2);
    });
  });
}
