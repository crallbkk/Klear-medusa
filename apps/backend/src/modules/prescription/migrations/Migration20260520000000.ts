import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema for the `prescription` module.
 *
 * `prescription_ref` stores the (Medusa order_id → Supabase
 * prescription_id) pointer. Plaintext Rx never reaches this table —
 * the LMS module's lab-handoff path fetches the encrypted blob from
 * Supabase and decrypts via the Vault RPC at submit time.
 */
export class Migration20260520000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `create table if not exists "prescription_ref" (
        "id" text not null,
        "order_id" text not null,
        "prescription_id" text not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "prescription_ref_pkey" primary key ("id")
      );`,
    );
    this.addSql(
      `create index if not exists "IDX_prescription_ref_order_id" on "prescription_ref" ("order_id") where deleted_at is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_prescription_ref_prescription_id" on "prescription_ref" ("prescription_id") where deleted_at is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_prescription_ref_deleted_at" on "prescription_ref" ("deleted_at");`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`drop table if exists "prescription_ref" cascade;`);
  }
}
