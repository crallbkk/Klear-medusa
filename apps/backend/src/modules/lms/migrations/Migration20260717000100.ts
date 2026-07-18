import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Idempotency hardening for `lab_job`: at most one live row per order.
 *
 * `order.placed` can be delivered more than once (event-bus retries, or two
 * workers racing the same event). The subscriber does a read-before-create
 * existence check, but that is not atomic — two concurrent handlers can both
 * miss the row and both insert. This partial unique index makes the second
 * insert fail at the DB with a unique violation, which the service catches
 * and treats as "already created".
 *
 * Partial (`where deleted_at is null`) so a soft-deleted row does not block a
 * legitimate re-creation, consistent with Medusa's soft-delete model.
 *
 * Hand-written (not `medusa db:generate`): generation needs a live DB, and
 * this is a single deterministic index.
 */
export class Migration20260717000100 extends Migration {
  override async up(): Promise<void> {
    // Dedup FIRST: if prod data already has >1 live row for an order (the
    // pre-index race window), CREATE UNIQUE INDEX would abort the migration.
    // Soft-delete every live duplicate except the EARLIEST row per order_id
    // (earliest = the one the original subscriber acted on; id breaks ties
    // deterministically). Soft-delete, not hard-delete — packet_snapshot is
    // PDPA-relevant forensic data we never destroy in a migration.
    this.addSql(
      `UPDATE "lab_job" SET deleted_at = now()
       WHERE deleted_at IS NULL
         AND id NOT IN (
           SELECT DISTINCT ON (order_id) id
           FROM "lab_job"
           WHERE deleted_at IS NULL
           ORDER BY order_id, created_at ASC, id ASC
         );`,
    );
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lab_job_order_id_active" ON "lab_job" ("order_id") WHERE deleted_at IS NULL;`,
    );
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "UQ_lab_job_order_id_active";`);
  }
}
