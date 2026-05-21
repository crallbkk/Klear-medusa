import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260521015604 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "lab_job" ("id" text not null, "order_id" text not null, "status" text not null, "packet_snapshot" jsonb not null, "provider_job_id" text null, "provider_name" text null, "attempts" integer not null default 0, "last_error" text null, "submitted_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_job_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_job_deleted_at" ON "lab_job" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "lab_job" cascade;`);
  }

}
