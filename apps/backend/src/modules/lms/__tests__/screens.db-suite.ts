import type LmsModuleService from "../service";
import type { BuildPacketResult } from "../types";
import {
  ACTIONS,
  STAGES,
  SYSTEM_ONLY_ACTIONS,
  offeredActions,
  type ProductionAction,
} from "../production";
import { reportFrom } from "../board";
import { startWarrantyRemake } from "../rebuild";
import { NO_ORDER_FACTS, rxRedactionReason } from "../rx-retention";
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


let screenKey = 0;
const USER = { type: "user" as const, id: "user_lab_1" };

/** Run inside the one runner in lms.db.spec.ts. */
export function screensSuite(service: LmsModuleService): void {
  const act = async (jobId: string, action: ProductionAction, detail?: Record<string, unknown>) => {
    const [row] = await sql(`select stage_version from lab_job where id = $1`, [jobId]);
    return service.applyProductionAction({
      job_id: jobId,
      action,
      idempotency_key: `screen-key-${++screenKey}-${Date.now()}`,
      expected_version: row.stage_version as number,
      actor: USER,
      detail,
    });
  };

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
      // The job still waiting for a prescription has no stage yet. It is on
      // the board all the same, because nothing else shows ops that an
      // order is stuck before production.
      const waiting = await sql(`select id from lab_job where order_id = 'order_w'`);
      // It has waited since it was created, which was before the last job
      // was cancelled.
      expect(queue.map((j) => j.id)).toEqual([b!.id, a!.id, waiting[0].id, asked!.id]);

      // A job with no stage has waited since it was created: an old one
      // comes first, not last.
      await sql(`update lab_job set created_at = now() - interval '9 days' where id = $1`, [
        waiting[0].id,
      ]);
      expect((await service.listQueue()).map((j) => j.id)).toEqual([
        waiting[0].id,
        b!.id,
        a!.id,
        asked!.id,
      ]);
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

  describe("the labs already used", () => {
    it("lists each outside lab once, however it was typed", async () => {
      for (const [order, vendor] of [
        ["order_a", "Bangkok Optics"],
        ["order_b", "bangkok  optics"],
        ["order_c", "Siam Lens"],
      ]) {
        const job = await service.createFromBuild(ok(order));
        await act(job!.id, "PRINTED");
        await act(job!.id, "SENT_TO_LAB", { vendor, quoted_satang: 100 });
      }
      // The spelling used most recently, whatever the database's sort order.
      expect(await service.listLabVendors()).toEqual(["bangkok optics", "Siam Lens"]);
      const again = await service.createFromBuild(ok("order_d"));
      await act(again!.id, "PRINTED");
      await act(again!.id, "SENT_TO_LAB", { vendor: "Bangkok Optics", quoted_satang: 100 });
      expect(await service.listLabVendors()).toEqual(["Bangkok Optics", "Siam Lens"]);
    });
  });

  describe("what a job offers against what the writer accepts", () => {
    // Details good enough for every step, written here.
    const GOOD: Partial<Record<ProductionAction, Record<string, unknown>>> = {
      LENS_ISSUED: { lenses: ["LENS-A1"] },
      SENT_TO_LAB: { vendor: "Lab One", quoted_satang: 1 },
      QC_FAILED: { reason: "r" },
      REMAKE_STARTED: { cause: "c" },
      LENS_SPOILED: { reason: "r" },
      FRAME_DAMAGED: { sku: "FRAME-A1", reason: "r" },
      LENS_RETURNED_UNUSED: { lenses: ["LENS-A1"] },
      HOLD: { reason: "r" },
      LAB_INVOICED: { invoiced_satang: 1 },
      NOTE: { text: "t" },
    };
    // Refusals that depend on rows the offer cannot see from the job alone:
    // a lab quote (the route adds that check itself) and which lenses were
    // issued. Everything else must agree exactly.
    const NEEDS_OTHER_ROWS = new Set(["LAB_INVOICED", "RECEIVED_FROM_LAB", "LENS_RETURNED_UNUSED"]);

    it("offers a step exactly when the writer records it, across stages and packet states", async () => {
      const made = await service.createFromBuild(ok("order_walk"));
      const id = made!.id;
      const cases: Array<{ stage: string | null; status: string; redacted: boolean; question: boolean; hold: boolean }> = [];
      for (const stage of [null, ...STAGES]) {
        for (const status of ["queued", "pending_rx", "failed", "submitted"]) {
          cases.push({ stage, status, redacted: false, question: false, hold: false });
        }
        cases.push({ stage, status: "submitted", redacted: true, question: false, hold: false });
        cases.push({ stage, status: "queued", redacted: true, question: false, hold: false });
        cases.push({ stage, status: "submitting", redacted: false, question: false, hold: false });
        cases.push({ stage, status: "cancelled", redacted: false, question: false, hold: false });
        cases.push({ stage, status: "queued", redacted: false, question: true, hold: false });
        cases.push({ stage, status: "queued", redacted: false, question: false, hold: true });
      }
      const disagreements: string[] = [];
      for (const c of cases) {
        const put = () =>
          sql(
            `update lab_job set stage = $2, status = $3, rx_redacted_at = $4,
                    cut_question_pending = $5, on_hold = $6, hold_reason = $7,
                    next_issue_reason = 'order', remake_count = 0
              where id = $1 returning stage_version`,
            [id, c.stage, c.status, c.redacted ? new Date() : null, c.question, c.hold, c.hold ? "h" : null],
          );
        await put();
        const job = await service.retrieveLabJob(id);
        const offered = new Set(offeredActions(job as never));
        for (const action of ACTIONS) {
          if (SYSTEM_ONLY_ACTIONS.has(action) || action.startsWith("PACKET_")) continue;
          if (NEEDS_OTHER_ROWS.has(action)) continue;
          const [row] = await put();
          let accepted = true;
          try {
            await service.applyProductionAction({
              job_id: id,
              action,
              idempotency_key: `walk-${++screenKey}-${Date.now()}`,
              expected_version: row.stage_version as number,
              actor: USER,
              detail: GOOD[action],
            });
          } catch (err) {
            if ((err as { code?: string }).code !== "not_allowed") throw err;
            accepted = false;
          }
          if (accepted !== offered.has(action)) {
            disagreements.push(
              `${action} at ${c.stage}/${c.status}${c.redacted ? "/blanked" : ""}${c.question ? "/question" : ""}${c.hold ? "/held" : ""}: offered ${offered.has(action)}, accepted ${accepted}`,
            );
          }
        }
      }
      expect(disagreements).toEqual([]);
    });
  });

  describe("a person's idempotency key", () => {
    it("cannot be one of the system's, so a job cannot be blocked with it", async () => {
      // A job waiting for its prescription: the system will put it at
      // ready under the key "ready:<job>". A key is unique across all jobs,
      // so a note recorded under that key would stop it for good.
      const waiting = await service.createFromBuild({
        outcome: "pending_rx",
        reason: "awaiting prescription",
        snapshot: { job_ref: "klear-order_w", klear_order_id: "order_w" },
      });
      const id = waiting!.id;
      for (const key of [`ready:${id}`, `cancel:${id}`, "cancelled:order_w", "has space 1", "semi;colon1"]) {
        await expect(
          service.applyProductionAction({
            job_id: id,
            action: "NOTE",
            idempotency_key: key,
            actor: USER,
            detail: { text: "x" },
          }),
        ).rejects.toMatchObject({ code: "invalid_detail" });
      }
      expect(await service.listProductionEventsForJob(id)).toHaveLength(0);
      // The system still can.
      await service.updateJobFromBuild(id, ok("order_w"));
      expect((await sql(`select stage from lab_job where id = $1`, [id]))[0].stage).toBe("ready");
    });
  });

  describe("a packet whose prescription was removed", () => {
    it("cannot be marked printed until it is rebuilt", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      await sql(`update lab_job set rx_redacted_at = now() where id = $1`, [job!.id]);
      await expect(act(job!.id, "PRINTED")).rejects.toMatchObject({
        code: "not_allowed",
        message: expect.stringMatching(/rebuild the packet/),
      });
      // A rebuild puts the prescription back, and the job can start.
      await service.updateJobFromBuild(job!.id, ok("order_a"));
      expect((await act(job!.id, "PRINTED")).job.stage).toBe("printed");
    });
  });

  describe("a warranty remake after the prescription was removed", () => {
    const container = { resolve: () => service } as never;
    const built = (orderId: string) =>
      telling(orderId) as Extract<BuildPacketResult, { outcome: "ok" }>;
    // Stands in for the real build, which needs the order module and the
    // vault. Counts how often a prescription would have been decrypted.
    let decrypted = 0;
    const build = (async () => {
      decrypted++;
      return built("order_a");
    }) as never;
    beforeEach(() => {
      decrypted = 0;
    });

    const delivered = async (orderId = "order_a") => {
      const job = await service.createFromBuild(telling(orderId));
      await sql(`update lab_job set stage = 'delivered', stage_since = now() where id = $1`, [job!.id]);
      await service.redactJobRx(job!.id);
      return job!.id;
    };
    const state = async (id: string) =>
      (
        await sql(
          `select packet_snapshot->'prescription' as rx, rx_redacted_at, stage, status,
                  stage_version, event_seq, updated_at from lab_job where id = $1`,
          [id],
        )
      )[0];
    const ask = async (id: string, over: object = {}) => {
      const s = await state(id);
      return startWarrantyRemake(
        container,
        {
          job_id: id,
          idempotency_key: `remake-${++screenKey}-${Date.now()}`,
          expected_version: s.stage_version as number,
          cause: "scratched",
          actor_id: "user_ops",
          ...over,
        },
        build,
      );
    };

    it("puts the prescription back and records the remake, together, as the person who asked", async () => {
      const id = await delivered();
      const before = await state(id);
      expect(before.rx).toBeNull();

      const done = await ask(id);
      expect(done.outcome).toBe("started");
      const after = await state(id);
      expect(after.rx).toEqual({ sph_right: -2.25, sph_left: -3.75 });
      expect(after.rx_redacted_at).toBeNull();
      expect([after.stage, after.status]).toEqual(["printed", "queued"]);
      // The packet changed, so a screen showing the blanked one drops it.
      expect((after.updated_at as Date).getTime()).toBeGreaterThan((before.updated_at as Date).getTime());
      const events = await service.listProductionEventsForJob(id);
      const last = events[events.length - 1];
      expect([last.action, last.actor_type, last.actor_id]).toEqual(["REMAKE_STARTED", "user", "user_ops"]);
      // The record says the prescription was put back, and holds none of it.
      expect(last.detail).toEqual({ cause: "scratched", warranty: true, prescription_restored: true });
      expect(decrypted).toBe(1);
    });

    it("changes nothing, and decrypts nothing, when the request is going to be refused", async () => {
      const id = await delivered();
      const before = await state(id);
      const refused = async (over: object, code: string) => {
        await expect(ask(id, over)).rejects.toMatchObject({ code });
        expect(await state(id)).toEqual(before);
      };
      await refused({ expected_version: (before.stage_version as number) + 5 }, "conflict");
      await refused({ cause: "" }, "invalid_detail");
      await refused({ cause: undefined }, "invalid_detail");
      await sql(`update lab_job set status = 'failed' where id = $1`, [id]);
      await expect(ask(id)).rejects.toMatchObject({ code: "not_allowed" });
      await sql(`update lab_job set status = 'submitted' where id = $1`, [id]);
      await expect(ask(id)).rejects.toMatchObject({ code: "not_allowed" });
      await sql(`update lab_job set status = 'queued', stage = 'labelled', on_hold = true where id = $1`, [id]);
      await expect(ask(id)).rejects.toMatchObject({ code: "not_allowed" });
      for (const stage of ["ready", "edged", "qc_failed", "cancelled"]) {
        await sql(`update lab_job set on_hold = false, stage = $2 where id = $1`, [id, stage]);
        await expect(ask(id)).rejects.toMatchObject({ code: "not_allowed" });
      }
      expect((await state(id)).rx).toBeNull();
      expect((await state(id)).rx_redacted_at).not.toBeNull();
      expect(await service.listProductionEventsForJob(id)).toHaveLength(1);
      expect(decrypted).toBe(0);
    });

    it("leaves the prescription out when the writer refuses after it was fetched", async () => {
      // The job moves between the check and the write: the one case where
      // a prescription is decrypted for nothing. It is still not stored.
      const id = await delivered();
      const moving = (async () => {
        decrypted++;
        await sql(`update lab_job set stage_version = stage_version + 1 where id = $1`, [id]);
        return built("order_a");
      }) as never;
      const s = await state(id);
      await expect(
        startWarrantyRemake(
          container,
          {
            job_id: id,
            idempotency_key: "remake-moving-0001",
            expected_version: s.stage_version as number,
            cause: "scratched",
            actor_id: "user_ops",
          },
          moving,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      const after = await state(id);
      expect([after.rx, after.rx_redacted_at === null, after.stage]).toEqual([null, false, "delivered"]);
      expect(await service.listProductionEventsForJob(id)).toHaveLength(1);
    });

    it("answers a repeated request with the first result and fetches nothing again", async () => {
      const id = await delivered();
      const s = await state(id);
      const request = {
        job_id: id,
        idempotency_key: "remake-repeat-0001",
        expected_version: s.stage_version as number,
        cause: "scratched",
        actor_id: "user_ops",
      };
      await startWarrantyRemake(container, request, build);
      expect(decrypted).toBe(1);
      // Much later: the remake was delivered and blanked again. The same
      // request arrives once more (a stuck retry, or someone replaying it).
      await sql(`update lab_job set stage = 'delivered' where id = $1`, [id]);
      await service.redactJobRx(id);
      const events = (await service.listProductionEventsForJob(id)).length;
      const again = await startWarrantyRemake(container, request, build);
      expect(again.outcome === "started" && again.result.replayed).toBe(true);
      expect(decrypted).toBe(1);
      expect((await state(id)).rx).toBeNull();
      expect(await service.listProductionEventsForJob(id)).toHaveLength(events);
    });

    it("says so, and changes nothing, when the stored prescription cannot be fetched", async () => {
      const id = await delivered();
      const before = await state(id);
      const gone = (async () => ({ outcome: "failed", reason: "x", snapshot: {} })) as never;
      const s = await state(id);
      const done = await startWarrantyRemake(
        container,
        {
          job_id: id,
          idempotency_key: "remake-gone-0001",
          expected_version: s.stage_version as number,
          cause: "scratched",
          actor_id: "user_ops",
        },
        gone,
      );
      expect(done).toEqual({ outcome: "not_built", buildOutcome: "failed" });
      expect(await state(id)).toEqual(before);
    });

    it("starts the plain remake, fetching nothing, when the packet still has its prescription", async () => {
      const job = await service.createFromBuild(telling("order_a"));
      await sql(`update lab_job set stage = 'delivered' where id = $1`, [job!.id]);
      const done = await ask(job!.id);
      expect(done.outcome).toBe("started");
      expect(decrypted).toBe(0);
      const events = await service.listProductionEventsForJob(job!.id);
      expect(events[events.length - 1].detail).toEqual({ cause: "scratched", warranty: true });
    });

    it("lets the writer put a prescription back for a warranty remake and nothing else", async () => {
      const id = await delivered();
      const packet = built("order_a").packet;
      const s = await state(id);
      const write = (over: object) =>
        service.applyProductionAction({
          job_id: id,
          action: "REMAKE_STARTED",
          idempotency_key: `writer-${++screenKey}-${Date.now()}`,
          expected_version: s.stage_version as number,
          actor: USER,
          detail: { cause: "c" },
          restore_packet: packet,
          ...over,
        });
      await expect(write({ action: "NOTE", detail: { text: "t" } })).rejects.toMatchObject({
        code: "not_allowed",
      });
      await sql(`update lab_job set stage = 'qc_failed' where id = $1`, [id]);
      await expect(write({})).rejects.toMatchObject({ code: "not_allowed" });
      await sql(`update lab_job set stage = 'delivered', rx_redacted_at = null where id = $1`, [id]);
      await expect(write({})).rejects.toMatchObject({ code: "not_allowed" });
      expect((await state(id)).rx).toBeNull();
    });

    it("tells the nightly sweep what it needs to leave the remake alone", async () => {
      const id = await delivered();
      await ask(id);
      // An old job: by its age alone it would be blanked tonight.
      await sql(`update lab_job set created_at = now() - interval '300 days' where id = $1`, [id]);
      const [row] = (await service.listJobsHoldingRx()).filter((j) => j.id === id);
      expect(row.stage).toBe("printed");
      expect(row.rx_restored_at).toBeTruthy();
      const longAgo = { deliveredAt: new Date(Date.now() - 200 * 24 * 3600_000), cancelled: false };
      for (const order of [longAgo, NO_ORDER_FACTS]) {
        expect(rxRedactionReason(row, order, new Date())).toBeNull();
        // The same job without the stamp would be blanked tonight.
        expect(rxRedactionReason({ ...row, rx_restored_at: null }, order, new Date())).not.toBeNull();
      }
    });

    it("stamps the job only when a prescription is put back", async () => {
      // A remake after a QC failure, and a plain remake of a delivered job
      // that still has its prescription, are not restores.
      const qc = await service.createFromBuild(ok("order_qc"));
      for (const [action, detail] of [
        ["PRINTED", undefined],
        ["LENS_ISSUED", { lenses: ["LENS-A1", "LENS-A2"] }],
        ["EDGED", undefined],
        ["MOUNTED", undefined],
        ["QC_FAILED", { reason: "r" }],
        ["REMAKE_STARTED", { cause: "c" }],
      ] as const) {
        await act(qc!.id, action, detail as never);
      }
      const plain = await service.createFromBuild(ok("order_plain"));
      await sql(`update lab_job set stage = 'delivered' where id = $1`, [plain!.id]);
      await ask(plain!.id);
      expect(
        await sql(`select rx_restored_at from lab_job where id in ($1, $2)`, [qc!.id, plain!.id]),
      ).toEqual([{ rx_restored_at: null }, { rx_restored_at: null }]);

      const id = await delivered("order_b");
      await ask(id);
      expect((await sql(`select rx_restored_at from lab_job where id = $1`, [id]))[0].rx_restored_at).not.toBeNull();
    });

    it("holds at the writer itself: status, a repeated key, a packet that is not one", async () => {
      const id = await delivered();
      const packet = built("order_a").packet;
      const s = await state(id);
      const request = {
        job_id: id,
        action: "REMAKE_STARTED" as const,
        idempotency_key: "writer-restore-0001",
        expected_version: s.stage_version as number,
        actor: USER,
        detail: { cause: "c" },
      };
      for (const status of ["failed", "pending_rx", "submitted", "submitting"]) {
        await sql(`update lab_job set status = $2 where id = $1`, [id, status]);
        await expect(
          service.applyProductionAction({ ...request, restore_packet: packet }),
        ).rejects.toMatchObject({ code: "not_allowed" });
      }
      await sql(`update lab_job set status = 'queued' where id = $1`, [id]);
      for (const notAPacket of [null, "x", 5, []]) {
        await expect(
          service.applyProductionAction({ ...request, restore_packet: notAPacket as never }),
        ).rejects.toMatchObject({ code: "invalid_detail" });
      }
      expect((await state(id)).rx).toBeNull();

      await service.applyProductionAction({ ...request, restore_packet: packet });
      // Delivered and blanked again; the same key arrives WITH a packet.
      await sql(`update lab_job set stage = 'delivered' where id = $1`, [id]);
      await service.redactJobRx(id);
      const again = await service.applyProductionAction({ ...request, restore_packet: packet });
      expect(again.replayed).toBe(true);
      expect((await state(id)).rx).toBeNull();
    });

    it("never carries the packet out of a restore that fails in the database", async () => {
      const id = await delivered();
      const s = await state(id);
      await sql(`
        create function test_fail() returns trigger language plpgsql as $$
        begin raise exception 'forced failure'; end $$;
        create trigger test_fail before insert on production_event
          for each row execute function test_fail();`);
      let caught: unknown;
      try {
        await service.applyProductionAction({
          job_id: id,
          action: "REMAKE_STARTED",
          idempotency_key: "writer-restore-fail-1",
          expected_version: s.stage_version as number,
          actor: USER,
          detail: { cause: "c" },
          restore_packet: built("order_a").packet,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(everythingIn(caught)).not.toMatch(/2\.25|3\.75|Secretname|66811112222|sph_right/);
      // Rolled back with the event: nothing was put back.
      await sql(`drop trigger test_fail on production_event`);
      expect((await state(id)).rx).toBeNull();
      expect((await state(id)).rx_redacted_at).not.toBeNull();
    });
  });

  describe("a packet on a screen", () => {
    it("is stamped so the screen can tell when it stops being the packet to work from", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      const seen = await service.viewPacket(job!.id, "user_lab", "stamp-key-0001");
      const stamp = async () => new Date((await service.retrieveLabJob(job!.id)).updated_at).getTime();
      expect(await stamp()).toBe(new Date(seen.as_of).getTime());
      // The lab's own steps, and another look, leave the stamp alone.
      await act(job!.id, "NOTE", { text: "seen" });
      await service.viewPacket(job!.id, "user_ops", "stamp-key-0002");
      expect(await stamp()).toBe(new Date(seen.as_of).getTime());
      // A rebuilt packet does not.
      await new Promise((r) => setTimeout(r, 15));
      await service.updateJobFromBuild(job!.id, telling("order_a"));
      expect(await stamp()).not.toBe(new Date(seen.as_of).getTime());
    });
  });

  describe("the production report", () => {
    const NOW = new Date();
    // Usage is dated when it is written. If Monday begins in Bangkok while
    // a test is writing, its rows fall in two weeks; that run proves
    // nothing about the report, so it is not judged.
    const sameWeek = (before: Date) => reportFrom(before, 1) === reportFrom(new Date(), 1);

    it("counts lenses per week and per job, and never names a lens", async () => {
      // Job one: a clean pair. Job two: a spoiled lens replaced, then a QC
      // failure and a remake, and a frame broken on the way.
      const one = await service.createFromBuild(ok("order_a"));
      await act(one!.id, "PRINTED");
      await act(one!.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });

      const two = await service.createFromBuild(ok("order_b"));
      await act(two!.id, "PRINTED");
      await act(two!.id, "LENS_ISSUED", { lenses: ["LENS-SV-160-M0200", "LENS-SV-160-M0225"] });
      await act(two!.id, "LENS_SPOILED", { reason: "chipped" });
      await act(two!.id, "LENS_ISSUED", { lenses: ["LENS-SV-160-M0200"] });
      await act(two!.id, "EDGED");
      await act(two!.id, "FRAME_DAMAGED", { sku: "KLR-1", reason: "hinge" });
      await act(two!.id, "MOUNTED");
      await act(two!.id, "QC_FAILED", { reason: "axis off" });
      await act(two!.id, "REMAKE_STARTED", { cause: "edging" });
      await act(two!.id, "LENS_ISSUED", { lenses: ["LENS-SV-160-M0200", "LENS-SV-160-M0225"] });

      const report = await service.productionReport(4, new Date());
      if (!sameWeek(NOW)) return;
      expect(report.weeks).toHaveLength(1);
      expect(report.weeks[0]).toMatchObject({
        issued_for_orders: 4,
        spoilage_replacements: 3,
        remake_lenses: 0,
        frames_spoiled: 1,
        returned_unused: 0,
        qc_failed: 1,
        remakes_started: 1,
        spoilage_rate: 0.75,
        remake_rate: 0,
      });
      expect(report.weeks[0].week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${report.weeks[0].week_start}T00:00:00Z`).getUTCDay()).toBe(1);

      // Job two first: 5 lenses, and one remake explains 4.
      expect(report.jobs_truncated).toBe(false);
      expect(report.jobs).toEqual([
        {
          lab_job_id: two!.id,
          order_id: "order_b",
          stage: "lens_issued",
          remake_count: 1,
          lenses_issued: 5,
          lenses_returned: 0,
          unexplained: 1,
        },
        {
          lab_job_id: one!.id,
          order_id: "order_a",
          stage: "lens_issued",
          remake_count: 0,
          lenses_issued: 2,
          lenses_returned: 0,
          unexplained: 0,
        },
      ]);
      // A lens SKU beside a job is a lens power beside an order.
      expect(JSON.stringify(report)).not.toMatch(/LENS-|KLR-/);
    });

    it("takes a returned lens off a job's count", async () => {
      const job = await service.createFromBuild(ok("order_a"));
      await act(job!.id, "PRINTED");
      await act(job!.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
      await service.cancelJob(job!.id);
      await act(job!.id, "LENS_RETURNED_UNUSED", { lenses: ["LENS-SV-167-M0100"] });
      const report = await service.productionReport(1, NOW);
      expect(report.jobs).toEqual([
        expect.objectContaining({ lenses_issued: 2, lenses_returned: 1, unexplained: 0 }),
      ]);
      expect(report.weeks[0]).toMatchObject({ issued_for_orders: 2, returned_unused: 1 });
    });

    it("lists first the job with the most lenses its remakes do not explain, and leaves out a deleted job", async () => {
      // Four lenses and a remake: explained. Three lenses and no remake: one over.
      const explained = await service.createFromBuild(ok("order_a"));
      await act(explained!.id, "PRINTED");
      await act(explained!.id, "LENS_ISSUED", { lenses: ["LENS-A1", "LENS-A2"] });
      await act(explained!.id, "EDGED");
      await act(explained!.id, "MOUNTED");
      await act(explained!.id, "QC_FAILED", { reason: "r" });
      await act(explained!.id, "REMAKE_STARTED", { cause: "c" });
      await act(explained!.id, "LENS_ISSUED", { lenses: ["LENS-A1", "LENS-A2"] });
      const over = await service.createFromBuild(ok("order_b"));
      await act(over!.id, "PRINTED");
      await act(over!.id, "LENS_ISSUED", { lenses: ["LENS-A1", "LENS-A2"] });
      await act(over!.id, "LENS_SPOILED", { reason: "r" });
      await act(over!.id, "LENS_ISSUED", { lenses: ["LENS-A1"] });
      const gone = await service.createFromBuild(ok("order_c"));
      await act(gone!.id, "PRINTED");
      await act(gone!.id, "LENS_ISSUED", { lenses: ["LENS-A1", "LENS-A2"] });
      await sql(`update lab_job set deleted_at = now() where id = $1`, [gone!.id]);

      const report = await service.productionReport(1, new Date());
      expect(report.jobs.map((j) => [j.order_id, j.lenses_issued, j.unexplained])).toEqual([
        ["order_b", 3, 1],
        ["order_a", 4, 0],
      ]);
    });

    it("leaves out weeks before the ones asked for, and is empty with nothing to report", async () => {
      expect(await service.productionReport(12, NOW)).toEqual({
        from: expect.any(String),
        weeks: [],
        jobs: [],
        jobs_truncated: false,
      });
      const job = await service.createFromBuild(ok("order_a"));
      await act(job!.id, "PRINTED");
      await act(job!.id, "LENS_ISSUED", { lenses: ["LENS-SV-167-M0100", "LENS-SV-167-M0125"] });
      // Asked from a year ahead, this week's usage is too old to be in it.
      const later = new Date(NOW.getTime() + 370 * 24 * 3600_000);
      const report = await service.productionReport(12, later);
      expect(report.weeks).toEqual([]);
      expect(report.jobs).toEqual([]);
    });
  });
}
