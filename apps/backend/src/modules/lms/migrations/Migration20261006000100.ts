import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `lab_job.rx_redacted_at` — when the readable prescription in
 * `packet_snapshot` was blanked (null while the snapshot still holds one).
 *
 * The `redact-lab-job-rx` scheduled job blanks the prescription once the
 * order is cancelled, delivered long enough ago, or past the age limit, and
 * stamps this column. It doubles as the job's work queue: only rows where it
 * is null are looked at.
 *
 * Additive and nullable; live rows keep their snapshot until the job's first
 * run decides on them.
 *
 * Soft-deleted rows are blanked HERE, once. The job cannot reach them: every
 * MedusaService list and update skips rows with `deleted_at` set. The UPDATE
 * matches every soft-deleted row; today those are the duplicates
 * Migration20260717000100 soft-deleted (nothing else soft-deletes a lab job),
 * each still holding a full readable prescription that nothing will read
 * again. Only the `prescription` key is set to null; the rest of the
 * snapshot stays.
 *
 * This deliberately reverses that earlier migration's stance ("forensic data
 * we never destroy in a migration") for the prescription alone: keeping a
 * readable prescription indefinitely on rows no code can reach is the thing
 * this change exists to stop. The prescription itself is not lost; the
 * encrypted record in Supabase is untouched.
 *
 * Hand-written (not `medusa db:generate`): generation needs a live DB, and
 * this is one deterministic column.
 */
export class Migration20261006000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `ALTER TABLE "lab_job" ADD COLUMN IF NOT EXISTS "rx_redacted_at" timestamptz NULL;`,
    );
    this.addSql(
      `UPDATE "lab_job"
         SET "packet_snapshot" = jsonb_set("packet_snapshot", '{prescription}', 'null'::jsonb, true),
             "rx_redacted_at" = now()
       WHERE "deleted_at" IS NOT NULL
         AND "rx_redacted_at" IS NULL
         AND jsonb_typeof("packet_snapshot") = 'object';`,
    );
  }

  // Dropping the column is reversible. The blanked prescriptions on the
  // soft-deleted duplicates are not, by design.
  override async down(): Promise<void> {
    this.addSql(`ALTER TABLE "lab_job" DROP COLUMN IF EXISTS "rx_redacted_at";`);
  }
}
