// A real Postgres for the lab module's tests, built by running the module's
// own migration files in order. That is the schema production gets on deploy
// (migrations run when the container starts), so the tests exercise it and
// not a schema derived from the models.
//
// Connection: DB_HOST / DB_PORT / DB_USERNAME / DB_PASSWORD, the same
// variables @medusajs/test-utils reads. CI provides a Postgres service; for a
// local run see the "Database tests" section of the module README.

import fs from "fs";
import path from "path";
import { Client } from "pg";

// One database per run. Two runs at once (two people, or CI shards) need
// different names, or each drops the other's schema: set LMS_TEST_DB.
//
// This harness DROPS SCHEMA public in the database it is pointed at. The
// name must therefore start with "lms_" or end with "_test"; anything else
// is refused, not quietly replaced.
function testDbName(): string {
  const name = process.env.LMS_TEST_DB;
  if (name === undefined || name === "") return "medusa_lms_test";
  if (!/^[a-z0-9_]{1,40}$/.test(name) || !(name.startsWith("lms_") || name.endsWith("_test"))) {
    throw new Error(
      `LMS_TEST_DB="${name}" refused: use lower-case letters, digits and _, starting with "lms_" or ending with "_test"`,
    );
  }
  return name;
}
if (process.env.NODE_ENV === "production") {
  throw new Error("the lab module's database tests must never run with NODE_ENV=production");
}
export const TEST_DB_NAME = testDbName();

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function connection(database: string) {
  return {
    host: process.env.DB_HOST ?? "localhost",
    port: parseInt(process.env.DB_PORT ?? "5432", 10),
    user: process.env.DB_USERNAME ?? "postgres",
    password: process.env.DB_PASSWORD ?? "",
    database,
  };
}

/** Every migration file name, oldest first. */
export function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^Migration\d+\.ts$/.test(f))
    .sort()
    .map((f) => f.replace(/\.ts$/, ""));
}

/** The SQL statements a migration's `up()` (or `down()`) would run. */
async function statements(name: string, direction: "up" | "down"): Promise<string[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join(MIGRATIONS_DIR, name));
  const Cls = mod[name];
  if (!Cls) throw new Error(`${name} does not export a class of that name`);
  // The base class only stores driver and config; the lab module's
  // migrations use `addSql` alone, so neither is needed.
  const migration = new Cls(undefined, undefined);
  await migration[direction]();
  return migration.getQueries();
}

export async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client(connection(TEST_DB_NAME));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function ensureDatabase(): Promise<void> {
  const admin = new Client(connection("postgres"));
  await admin.connect();
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [
      TEST_DB_NAME,
    ]);
    if (found.rowCount === 0) await admin.query(`create database "${TEST_DB_NAME}"`);
  } finally {
    await admin.end();
  }
}

/** Run the named migrations, in the order given, each in its own transaction. */
export async function runMigrations(
  names: string[],
  direction: "up" | "down" = "up",
): Promise<void> {
  await withClient(async (client) => {
    for (const name of names) {
      const sql = await statements(name, direction);
      await client.query("begin");
      try {
        for (const statement of sql) await client.query(statement);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`${name} ${direction} failed: ${(err as Error).message}`);
      }
    }
  });
}

/** An empty schema with every migration applied (or only those named). */
export async function resetDatabase(names: string[] = migrationNames()): Promise<void> {
  await ensureDatabase();
  await withClient(async (client) => {
    await client.query(`drop schema if exists public cascade`);
    await client.query(`create schema public`);
  });
  await runMigrations(names);
}

export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withClient(async (client) => (await client.query(text, params)).rows as T[]);
}
