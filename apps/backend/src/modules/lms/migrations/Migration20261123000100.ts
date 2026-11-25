import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * `lens_stock_snapshot`: lens on-hand per SKU as Klear Operations last sent
 * it (contract 5, part 2). One row per SKU; each snapshot replaces the
 * table (`LmsModuleService.replaceLensSnapshot`).
 *
 * Written by hand in the shape `medusa db:generate lms` writes for these
 * models (compare `lab_usage_release` in Migration20261121000100), and
 * checked against the module snapshot. Not insert-only: unlike the release
 * tables it is a copy that is replaced, not a record.
 *
 * Additive: one new table, nothing existing is touched.
 */
export class Migration20261123000100 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table if not exists "lens_stock_snapshot" ("id" text not null, "sku" text not null, "on_hand" integer not null, "as_of" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lens_stock_snapshot_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lens_stock_snapshot_deleted_at" ON "lens_stock_snapshot" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lens_stock_snapshot_sku" ON "lens_stock_snapshot" ("sku") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "lens_stock_snapshot" cascade;`);
  }
}
