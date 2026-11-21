import type LmsModuleService from "../service";
import type { BuildPacketResult } from "../types";
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
});

// A packet with values a leak would show.
const telling = (orderId: string): BuildPacketResult => {
  const built = ok(orderId) as Extract<BuildPacketResult, { outcome: "ok" }>;
  return {
    outcome: "ok",
    packet: {
      ...built.packet,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prescription: { sph_right: -2.25, sph_left: -3.75 } as any,
      customer: { ...built.packet.customer, name: "Somchai Secretname", phone: "+66811112222" },
    },
  };
};

const everythingIn = (err: unknown) =>
  [
    String(err),
    (err as Error)?.message ?? "",
    (err as Error)?.stack ?? "",
    JSON.stringify(err, Object.getOwnPropertyNames((err ?? {}) as object)),
  ].join("\n");

/** Run inside the one runner in lms.db.spec.ts. */
export function screensSuite(service: LmsModuleService): void {
  describe("a failed save of a job", () => {
    // The driver's error for a failed insert or update is the SQL with its
    // values written in: the whole packet. Routes, jobs and subscribers log
    // such errors and send them to Sentry, whose scrubber cannot clean an
    // error message. So the service must never let that text out.
    const failOn = (when: "insert" | "update") =>
      sql(`
        create function test_fail() returns trigger language plpgsql as $$
        begin raise exception 'forced failure'; end $$;
        create trigger test_fail before ${when} on lab_job
          for each row execute function test_fail();`);

    it("never carries the packet out of a failed insert", async () => {
      await failOn("insert");
      let caught: unknown;
      try {
        await service.createFromBuild(telling("order_leak"));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(everythingIn(caught)).not.toMatch(/2\.25|3\.75|Secretname|66811112222|sph_right/);
      expect(everythingIn(caught)).toMatch(/P0001/);
    });

    it("never carries the packet out of a failed rebuild or a failed blanking", async () => {
      const job = await service.createFromBuild({
        outcome: "pending_rx",
        reason: "awaiting prescription",
        snapshot: { job_ref: "klear-order_leak", klear_order_id: "order_leak" },
      });
      const built = await service.createFromBuild(telling("order_leak2"));
      await failOn("update");
      for (const attempt of [
        () => service.updateJobFromBuild(job!.id, telling("order_leak")),
        () => service.redactJobRx(built!.id),
      ]) {
        let caught: unknown;
        try {
          await attempt();
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(everythingIn(caught)).not.toMatch(/2\.25|3\.75|Secretname|66811112222|sph_right/);
      }
    });

    it("still adopts the first job when the same order is inserted twice", async () => {
      const first = await service.createFromBuild(telling("order_twice"));
      const second = await service.createFromBuild(telling("order_twice"));
      expect(second!.id).toBe(first!.id);
    });
  });

  describe("the queue", () => {
    it("lists jobs the lab still has work on, without their packets, longest-waiting first", async () => {
      const a = await service.createFromBuild(ok("order_a"));
      const b = await service.createFromBuild(ok("order_b"));
      const done = await service.createFromBuild(ok("order_done"));
      const cancelled = await service.createFromBuild(ok("order_cancelled"));
      const asked = await service.createFromBuild(ok("order_asked"));
      await service.createFromBuild({
        outcome: "pending_rx",
        reason: "awaiting prescription",
        snapshot: { job_ref: "klear-order_w", klear_order_id: "order_w" },
      });
      await sql(`update lab_job set stage = 'delivered' where id = $1`, [done!.id]);
      await sql(`update lab_job set stage_since = now() - interval '2 days' where id = $1`, [b!.id]);
      await service.cancelJob(cancelled!.id);
      await service.cancelJob(asked!.id);
      await sql(`update lab_job set cut_question_pending = true where id = $1`, [asked!.id]);

      const queue = await service.listQueue();
      // b has waited longest; the cancelled job with an open question is
      // still someone's work.
      expect(queue.map((j) => j.id)).toEqual([b!.id, a!.id, asked!.id]);
      expect(queue.length).toBeLessThanOrEqual(1000);
      for (const job of queue) {
        expect(Object.keys(job)).not.toContain("packet_snapshot");
        expect(JSON.stringify(job)).not.toMatch(/delivery_address|phone/);
      }
    });
  });

  describe("looking at a packet", () => {
    it("records every look before handing the packet over; a used key shows nothing", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      const seen = await service.viewPacket(job!.id, "user_lab", "view-key-0001");
      expect(seen.packet.klear_order_id).toBe("order_a");
      // The same key again, by the same person or by someone who saw it in
      // the history: no packet without a new record.
      await expect(service.viewPacket(job!.id, "user_lab", "view-key-0001")).rejects.toMatchObject({
        code: "key_reused",
      });
      await expect(service.viewPacket(job!.id, "user_other", "view-key-0001")).rejects.toMatchObject({
        code: "key_reused",
      });
      await service.viewPacket(job!.id, "user_ops", "view-key-0002", true);
      const events = await service.listProductionEventsForJob(job!.id);
      expect(events.slice(1).map((e) => [e.action, e.actor_type, e.actor_id])).toEqual([
        ["PACKET_VIEWED", "user", "user_lab"],
        ["PACKET_PRINTED", "user", "user_ops"],
      ]);
      // Looking does not move the job.
      expect(await sql(`select stage, stage_version from lab_job where id = $1`, [job!.id])).toEqual([
        { stage: "ready", stage_version: 1 },
      ]);
    });

    it("does not hand over a packet it could not record the view of", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      await sql(`
        create function test_fail() returns trigger language plpgsql as $$
        begin raise exception 'forced failure'; end $$;
        create trigger test_fail before insert on production_event
          for each row execute function test_fail();`);
      await expect(service.viewPacket(job!.id, "user_lab", "view-key-0003")).rejects.toThrow(
        /could not be recorded/,
      );
    });

    it("refuses a packet that is not the one to work from, and records no view of it", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      const refused = async (key: string) => {
        await expect(service.viewPacket(job!.id, "user_lab", key)).rejects.toMatchObject({
          code: "not_allowed",
        });
      };
      // A changed prescription not rebuilt yet: the stored packet is the old one.
      await sql(`update lab_job set status = 'pending_rx' where id = $1`, [job!.id]);
      await refused("view-key-0004");
      await sql(`update lab_job set status = 'failed' where id = $1`, [job!.id]);
      await refused("view-key-0005");
      // Blanked after delivery.
      await sql(`update lab_job set status = 'queued', rx_redacted_at = now() where id = $1`, [job!.id]);
      await refused("view-key-0006");
      expect(await service.listProductionEventsForJob(job!.id)).toHaveLength(1);
      await expect(service.viewPacket("labjob_nope", "user_lab", "view-key-0007")).rejects.toMatchObject({
        type: "not_found",
      });
    });
  });
}
