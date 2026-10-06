import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `lab_job.rx_redacted_at` — when the readable prescription in
 * `packet_snapshot` was blanked (null while the snapshot still holds one).
 *
 * The `redact-lab-job-rx` scheduled job blanks the prescription once the
 * order is cancelled, delivered long enough ago, or two years old, and
 * stamps this column. It doubles as the job's work queue: only rows where it
 * is null are looked at.
 *
 * Additive and nullable; existing rows keep their snapshot until the job's
 * first run decides on them. Hand-written (not `medusa db:generate`):
 * generation needs a live DB, and this is one deterministic column.
 */
export class Migration20261006000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "lab_job" ADD COLUMN IF NOT EXISTS "rx_redacted_at" timestamptz NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "lab_job" DROP COLUMN IF EXISTS "rx_redacted_at";`);
  }
}
