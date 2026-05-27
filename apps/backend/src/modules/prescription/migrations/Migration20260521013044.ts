import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260521013044 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "prescription_ref" ("id" text not null, "order_id" text not null, "prescription_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "prescription_ref_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_prescription_ref_deleted_at" ON "prescription_ref" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "prescription_ref" cascade;`);
  }

}
