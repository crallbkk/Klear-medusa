import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema for the `lms` module.
 *
 * `lab_job` is the append-driven queue of lab-handoff jobs. One row
 * per attempt to ship a Medusa order to the optical lab partner.
 *
 * **PDPA-sensitive**: `packet_snapshot` is a jsonb column containing
 * decrypted Rx data (required for the lab). Never log, never include
 * in audit payloads, never expose from the customer-facing Store API.
 * Access is restricted to the LMS module's own service methods.
 */
export class Migration20260520000000 extends Migration {
  async up(): Promise<void> {
    this.addSql(
      `create table if not exists "lab_job" (
        "id" text not null,
        "order_id" text not null,
        "status" text not null,
        "packet_snapshot" jsonb not null,
        "provider_job_id" text null,
        "provider_name" text null,
        "attempts" integer not null default 0,
        "last_error" text null,
        "submitted_at" timestamptz null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "lab_job_pkey" primary key ("id")
      );`,
    );
    this.addSql(
      `create index if not exists "IDX_lab_job_order_id" on "lab_job" ("order_id") where deleted_at is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_lab_job_status" on "lab_job" ("status") where deleted_at is null;`,
    );
    this.addSql(
      `create index if not exists "IDX_lab_job_provider_job_id" on "lab_job" ("provider_job_id") where provider_job_id is not null;`,
    );
    this.addSql(
      `create index if not exists "IDX_lab_job_deleted_at" on "lab_job" ("deleted_at");`,
    );
  }

  async down(): Promise<void> {
    this.addSql(`drop table if exists "lab_job" cascade;`);
  }
}
