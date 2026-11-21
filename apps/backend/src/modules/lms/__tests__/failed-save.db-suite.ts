import type LmsModuleService from "../service";
import type { BuildPacketResult } from "../types";
import fs from "fs";
import path from "path";
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
export function failedSaveSuite(service: LmsModuleService): void {
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
        // The failed write itself, not a refusal thrown before it.
        expect((caught as Error)?.name).toBe("ProductionWriteError");
        expect(everythingIn(caught)).not.toMatch(/2\.25|3\.75|Secretname|66811112222|sph_right/);
      }
    });

    it("does not mistake another failure for a duplicate because of what the packet says", async () => {
      // The driver's message is the INSERT with the packet written in. A
      // phone number or a name must not be able to change what the failure
      // is taken to be.
      await failOn("insert");
      const built = telling("order_words") as Extract<BuildPacketResult, { outcome: "ok" }>;
      for (const customer of [
        { ...built.packet.customer, phone: "+66812350512" },
        { ...built.packet.customer, name: "Unique Constraint Co" },
        { ...built.packet.customer, name: "duplicate key value" },
      ]) {
        let caught: unknown;
        try {
          await service.createFromBuild({ outcome: "ok", packet: { ...built.packet, customer } });
        } catch (err) {
          caught = err;
        }
        expect([customer.name, (caught as Error)?.name]).toEqual([customer.name, "ProductionWriteError"]);
        expect(everythingIn(caught)).toMatch(/P0001/);
      }
    });

    it("saves a lab job through the two guarded methods only", () => {
      // The generated createLabJobs / updateLabJobs throw the driver's error.
      // A new call to either, anywhere, would reopen the leak without
      // failing any other test.
      const dir = path.join(__dirname, "..", "..", "..");
      const offenders: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (e.name !== "__tests__" && e.name !== "node_modules") walk(full);
          } else if (/\.tsx?$/.test(e.name)) {
            const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
            lines.forEach((line, i) => {
              if (/\.(createLabJobs|updateLabJobs)\s*\(/.test(line)) {
                offenders.push(`${path.relative(dir, full).split(path.sep).join("/")}:${i + 1}`);
              }
            });
          }
        }
      };
      walk(dir);
      expect(offenders).toHaveLength(2);
      for (const o of offenders) expect(o).toMatch(/^modules\/lms\/service\.ts:\d+$/);
    });

    it("still adopts the first job when the same order is inserted twice", async () => {
      const first = await service.createFromBuild(telling("order_twice"));
      const second = await service.createFromBuild(telling("order_twice"));
      expect(second!.id).toBe(first!.id);
    });
  });
}
