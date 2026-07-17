import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Drop the `prescription_ref` table.
 *
 * The table linked a Medusa order to a Supabase prescription id, but it
 * had ZERO writers in either repo — `linkPrescriptionToOrder` was never
 * called from anywhere, so the table was provably always empty and every
 * `decryptForLabHandoff(order_id)` threw "no prescription linked". The
 * storefront instead stamps `klear_prescription_id` directly onto Medusa
 * order/line-item metadata at checkout (and the send-later flow writes it
 * onto the order post-payment), so metadata is the wire contract and this
 * table is dead. `decryptForLabHandoff` now takes a prescription id
 * directly (resolved from metadata by the LMS orchestrator).
 *
 * Hand-written (not `medusa db:generate`): generation requires a live DB
 * connection, and the drop is a single deterministic statement.
 */
export class Migration20260717000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`drop table if exists "prescription_ref" cascade;`);
  }

  override async down(): Promise<void> {
    // Recreate the (empty) table so the migration is reversible. It has no
    // writers, so it will remain empty — parity with the original schema.
    this.addSql(
      `create table if not exists "prescription_ref" ("id" text not null, "order_id" text not null, "prescription_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "prescription_ref_pkey" primary key ("id"));`,
    );
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_prescription_ref_deleted_at" ON "prescription_ref" ("deleted_at") WHERE deleted_at IS NULL;`,
    );
  }
}
