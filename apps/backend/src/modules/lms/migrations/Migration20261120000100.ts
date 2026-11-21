import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Production in the lab system: stages on `lab_job`, the `production_event`
 * history, `lab_usage` (lenses and frames used) and `lab_cost` (an outside
 * lab's quote per job).
 *
 * The table and column statements were generated (`medusa db:generate lms`)
 * from the models, so the snapshot matches. Added by hand below them:
 *
 *   1. Triggers that make `production_event` and `lab_usage` insert-only:
 *      no update, no delete, and no row inserted already soft-deleted (it
 *      would sit outside the unique indexes, which are partial on
 *      `deleted_at is null`). Medusa connects as the table owner, so this
 *      is a guard against a mistake in code, not against someone with the
 *      database password. TRUNCATE is deliberately not blocked: Medusa's
 *      HTTP integration test runner truncates every table between tests.
 *   2. A starting stage for RECENT jobs. A job created in the last 30 days
 *      whose packet is built starts at `ready`, a cancelled one at
 *      `cancelled`, each with the one event that explains it. Jobs still
 *      waiting for a prescription or failed keep no stage until their
 *      packet builds.
 *
 *      Older jobs get no stage. No lab provider was ever wired, so every
 *      past order whose packet built is still `queued`, delivered or not,
 *      and there is no record of where the glasses are. Putting them all
 *      at `ready` would fill the lab's queue with orders shipped long ago.
 *      A recent order that was already made by hand does show as `ready`;
 *      it is walked forward or cancelled once the lab's screens exist.
 *
 * `lock_timeout` makes a deploy that cannot get the table fail fast (the
 * previous deployment keeps serving) instead of hanging the store.
 *
 * Additive: no existing column is changed, and code from before this
 * migration keeps working against the migrated table.
 */

export class Migration20261120000100 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`set local lock_timeout = '5s';`);
    this.addSql(`create table if not exists "lab_cost" ("id" text not null, "lab_job_id" text not null, "vendor" text not null, "quoted_satang" integer not null, "expected_on" text null, "sent_event_id" text not null, "received_at" timestamptz null, "invoiced_satang" integer null, "invoiced_at" timestamptz null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_cost_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_cost_deleted_at" ON "lab_cost" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_cost_job" ON "lab_cost" ("lab_job_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "lab_usage" ("id" text not null, "lab_job_id" text not null, "production_event_id" text not null, "sku" text not null, "reason" text not null, "qty" integer not null, "entered_on" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_usage_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_usage_deleted_at" ON "lab_usage" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_usage_entered_on" ON "lab_usage" ("entered_on") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_usage_event" ON "lab_usage" ("production_event_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "production_event" ("id" text not null, "lab_job_id" text not null, "seq" integer not null, "action" text not null, "from_stage" text null, "to_stage" text null, "idempotency_key" text not null, "actor_type" text not null, "actor_id" text not null, "happened_at" timestamptz null, "detail" jsonb not null, "request_hash" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "production_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_production_event_deleted_at" ON "production_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_production_event_job_seq" ON "production_event" ("lab_job_id", "seq") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_production_event_idempotency_key" ON "production_event" ("idempotency_key") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "lab_job" add column if not exists "stage" text null, add column if not exists "stage_since" timestamptz null, add column if not exists "stage_version" integer not null default 0, add column if not exists "event_seq" integer not null default 0, add column if not exists "remake_count" integer not null default 0, add column if not exists "on_hold" boolean not null default false, add column if not exists "hold_reason" text null, add column if not exists "cut_question_pending" boolean not null default false, add column if not exists "next_issue_reason" text not null default 'order';`);

    // 1. Insert-only guards.
    this.addSql(`
      create or replace function lms_refuse_change() returns trigger
      language plpgsql as $fn$
      begin
        raise exception '% is insert-only: % refused', tg_table_name, tg_op
          using errcode = 'P0001';
      end
      $fn$;`);
    for (const table of ["production_event", "lab_usage"]) {
      this.addSql(`drop trigger if exists "${table}_insert_only" on "${table}";`);
      this.addSql(
        `create trigger "${table}_insert_only" before update or delete on "${table}"
           for each row execute function lms_refuse_change();`,
      );
      this.addSql(`drop trigger if exists "${table}_no_deleted_insert" on "${table}";`);
      this.addSql(
        `create trigger "${table}_no_deleted_insert" before insert on "${table}"
           for each row when (new."deleted_at" is not null)
           execute function lms_refuse_change();`,
      );
    }

    // 2. A starting stage for the jobs that exist. The event first (it reads
    //    "stage is null"), then the cache.
    this.addSql(`
      insert into "production_event"
        ("id", "lab_job_id", "seq", "action", "from_stage", "to_stage",
         "idempotency_key", "actor_type", "actor_id", "detail", "happened_at")
      select 'prodevt_' || replace(gen_random_uuid()::text, '-', ''), j."id", 1,
             case when j."status" = 'cancelled' then 'CANCELLED' else 'READY' end,
             null,
             case when j."status" = 'cancelled' then 'cancelled' else 'ready' end,
             'backfill:' || j."id", 'system', 'migration',
             '{"backfill": true}'::jsonb, j."updated_at"
        from "lab_job" j
       where j."deleted_at" is null
         and j."stage" is null
         and j."created_at" > now() - interval '30 days'
         and j."status" in ('queued', 'submitting', 'submitted', 'cancelled');`);
    this.addSql(`
      update "lab_job"
         set "stage" = case when "status" = 'cancelled' then 'cancelled' else 'ready' end,
             "stage_since" = "updated_at",
             "stage_version" = 1,
             "event_seq" = 1
       where "deleted_at" is null
         and "stage" is null
         and "created_at" > now() - interval '30 days'
         and "status" in ('queued', 'submitting', 'submitted', 'cancelled');`);
  }

  override async down(): Promise<void> {
    // Destroys the production history. For a local reset only.
    this.addSql(`drop table if exists "lab_cost" cascade;`);

    this.addSql(`drop table if exists "lab_usage" cascade;`);

    this.addSql(`drop table if exists "production_event" cascade;`);

    this.addSql(`drop function if exists lms_refuse_change();`);

    this.addSql(`alter table if exists "lab_job" drop column if exists "stage", drop column if exists "stage_since", drop column if exists "stage_version", drop column if exists "event_seq", drop column if exists "remake_count", drop column if exists "on_hold", drop column if exists "hold_reason", drop column if exists "cut_question_pending", drop column if exists "next_issue_reason";`);
  }

}
