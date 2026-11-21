import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * The release of lens and frame usage to Klear Operations:
 * `lab_release_window` (one marker per window, also when empty),
 * `lab_usage_release` (totals per window, SKU and reason) and
 * `lab_total_day` (totals per outside lab as of a window's last day).
 *
 * Table statements generated (`medusa db:generate lms`) from the models.
 * Added by hand: the same insert-only triggers the production tables have
 * (the function comes from Migration20261120000100). A released window is
 * written once and never changed.
 *
 * Additive: three new tables, nothing existing is touched.
 */

export class Migration20261121000100 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "lab_release_window" ("id" text not null, "window_start" text not null, "window_end" text not null, "released_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_release_window_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_release_window_deleted_at" ON "lab_release_window" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lab_release_window_end" ON "lab_release_window" ("window_end") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "lab_total_day" ("id" text not null, "vendor" text not null, "as_of" text not null, "quoted_uninvoiced_satang" integer not null, "invoiced_to_date_satang" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_total_day_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_total_day_deleted_at" ON "lab_total_day" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lab_total_day_vendor_as_of" ON "lab_total_day" ("vendor", "as_of") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "lab_usage_release" ("id" text not null, "window_end" text not null, "sku" text not null, "reason" text not null, "net_qty" integer not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "lab_usage_release_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_lab_usage_release_deleted_at" ON "lab_usage_release" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_lab_usage_release_window_sku_reason" ON "lab_usage_release" ("window_end", "sku", "reason") WHERE deleted_at IS NULL;`);

    for (const table of ["lab_release_window", "lab_usage_release", "lab_total_day"]) {
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
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "lab_release_window" cascade;`);

    this.addSql(`drop table if exists "lab_total_day" cascade;`);

    this.addSql(`drop table if exists "lab_usage_release" cascade;`);
  }

}
