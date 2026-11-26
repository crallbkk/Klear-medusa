import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * The order's production state, told to the Website (contract 6,
 * `order-status-projection-v1`; see `projection.ts`).
 *
 *   lab_job.projection_state / projection_seq / projection_at /
 *   projection_recorded_at
 *     the Website state of the job's latest stage that has one, its
 *     sequence, when it happened and when this server recorded it (the
 *     30-day give-up counts from the latter). Written by the production
 *     writer only.
 *   lab_job.projection_sent_seq
 *     the highest sequence the Website has taken; the heal sweep sends the
 *     latest state again while it is lower.
 *   lab_job.projection_attempted_at / projection_not_ready_count /
 *   projection_gave_up_at
 *     delivery bookkeeping: when a send was last not taken, how many answers
 *     said "not ready", and when sending was given up (reported once).
 *   lab_job.warranty_remakes
 *     warranty remakes started after the glasses were labelled or delivered,
 *     sent with each state so the Website can tell a remake after delivery
 *     from a late message about the first pair.
 *
 * Written by hand in the shape `medusa db:generate lms` writes for these
 * models, and checked against the module snapshot.
 *
 * Additive: four nullable columns, four with a constant default, no
 * backfill. Existing jobs have nothing to send until their next stage.
 */
export class Migration20261125000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "lab_job" add column if not exists "warranty_remakes" integer not null default 0, add column if not exists "projection_state" text null, add column if not exists "projection_seq" integer not null default 0, add column if not exists "projection_at" timestamptz null, add column if not exists "projection_recorded_at" timestamptz null, add column if not exists "projection_sent_seq" integer not null default 0, add column if not exists "projection_attempted_at" timestamptz null, add column if not exists "projection_not_ready_count" integer not null default 0, add column if not exists "projection_gave_up_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "lab_job" drop column if exists "warranty_remakes", drop column if exists "projection_state", drop column if exists "projection_seq", drop column if exists "projection_at", drop column if exists "projection_recorded_at", drop column if exists "projection_sent_seq", drop column if exists "projection_attempted_at", drop column if exists "projection_not_ready_count", drop column if exists "projection_gave_up_at";`);
  }
}
