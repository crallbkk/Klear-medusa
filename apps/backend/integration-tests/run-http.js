#!/usr/bin/env node
// Runs the real-server tests (integration-tests/http/*.spec.ts), each spec
// file in its own jest process, one after another.
//
// Why: Medusa's test runner boots the whole backend inside the jest process.
// A second spec file booted in the same process fails before any test runs
// ("Loaders for module ... failed: Method Map.prototype.set called on
// incompatible receiver"). Jest's own workers are reused between files, so no
// jest flag reliably gives each file a fresh process; this script does, for
// any number of files.
//
// Usage (from apps/backend):  npm run test:integration:http
// Extra arguments are passed to every jest run (for example -t "name").
// Needs the same database env as before: DB_HOST (the literal "localhost"
// locally), DB_PORT, DB_USERNAME, DB_PASSWORD.
//
// Exits non-zero if any file fails, or if there are no spec files at all (a
// run that tested nothing must not look green).

"use strict";

const { spawnSync } = require("child_process");
const { readdirSync } = require("fs");
const path = require("path");

const backendDir = path.resolve(__dirname, "..");
const httpDir = path.join(__dirname, "http");
const jestBin = require.resolve("jest/bin/jest", { paths: [backendDir] });

const specs = readdirSync(httpDir)
  .filter((name) => name.endsWith(".spec.ts"))
  .sort()
  .map((name) => path.join(httpDir, name));

if (specs.length === 0) {
  console.error(`run-http: no spec files found in ${httpDir}`);
  process.exit(1);
}

// The same settings the other test scripts pass on their command line.
const given = process.env.NODE_OPTIONS ?? "";
const nodeOptions = given.includes("--experimental-vm-modules")
  ? given
  : [given, "--experimental-vm-modules"].filter(Boolean).join(" ");
const env = { ...process.env, TEST_TYPE: "integration:http", NODE_OPTIONS: nodeOptions };
const extraArgs = process.argv.slice(2);

const results = [];
for (const spec of specs) {
  console.log(`\nrun-http: ${spec}`);
  const run = spawnSync(
    process.execPath,
    // --runTestsByPath: the file is taken as a path, not a pattern, so a
    // Windows path (backslashes) means the same as a Linux one.
    [jestBin, "--silent=false", "--runInBand", "--forceExit", ...extraArgs, "--runTestsByPath", spec],
    { cwd: backendDir, env, stdio: "inherit" },
  );
  const ok = run.status === 0;
  const why = run.error ? ` (${run.error.message})` : run.signal ? ` (signal ${run.signal})` : "";
  const name = path.relative(backendDir, spec);
  results.push({ spec: name, ok, pid: run.pid, status: run.status });
  console.log(`run-http: ${ok ? "PASS" : "FAIL"} ${name} (process ${run.pid}, exit ${run.status})${why}`);
}

console.log("\nrun-http: summary");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.spec} (process ${r.pid}, exit ${r.status})`);
const failed = results.filter((r) => !r.ok).length;
console.log(`run-http: ${results.length - failed} of ${results.length} spec files passed`);
process.exit(failed ? 1 : 0);
