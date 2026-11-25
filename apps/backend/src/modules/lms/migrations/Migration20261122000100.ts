import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `lab_job.rx_restored_at`: when the readable prescription was put back
 * into a job's packet to start a warranty remake. Set by the production
 * writer in the same transaction as the REMAKE_STARTED event, and by
 * nothing else. The retention rule reads it to keep the prescription while
 * that remake is made (`rx-retention.ts`).
 *
 * Additive: one nullable column, no backfill. Every existing row has null,
 * which means "never restored" and leaves its retention exactly as it was.
 */
export class Migration20261122000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "lab_job" add column if not exists "rx_restored_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "lab_job" drop column if exists "rx_restored_at";`);
  }
}
