import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Writing off an outside lab's quote whose work came back and that the lab
 * will never invoice (owner's decision of 2026-11-21).
 *
 *   lab_cost.written_off_at / written_off_by / written_off_reason
 *     who wrote the quote off, when, and why. Set by the production writer
 *     (LAB_QUOTE_WRITTEN_OFF) and by nothing else. The reason is free text
 *     and stays on this row only.
 *   lab_total_day.written_off_satang
 *     per lab, the quoted value written off and not invoiced as of the
 *     window's last day, served to Klear Operations beside the other totals.
 *
 * Written by hand in the shape `medusa db:generate lms` writes for these
 * models (compare Migration20261120000100's added columns), and checked
 * against the module snapshot.
 *
 * Additive: three nullable columns and one with a constant default. No
 * backfill. Every existing quote reads as never written off, and every
 * released window's total reads 0, which is true: write-offs did not exist.
 * A constant default does not rewrite the rows, so the insert-only trigger
 * on `lab_total_day` is not touched.
 */
export class Migration20261123000200 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "lab_cost" add column if not exists "written_off_at" timestamptz null, add column if not exists "written_off_by" text null, add column if not exists "written_off_reason" text null;`);
    this.addSql(`alter table if exists "lab_total_day" add column if not exists "written_off_satang" integer not null default 0;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "lab_cost" drop column if exists "written_off_at", drop column if exists "written_off_by", drop column if exists "written_off_reason";`);
    this.addSql(`alter table if exists "lab_total_day" drop column if exists "written_off_satang";`);
  }
}
