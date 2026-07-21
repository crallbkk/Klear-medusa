// OTEL instrumentation template (kept for a future pass — Sentry is the M5
// deliverable below). Uncomment to enable instrumentation and observability
// using OpenTelemetry. Refer to the docs for installation instructions:
// https://docs.medusajs.com/learn/debugging-and-testing/instrumentation

// import { registerOtel } from "@medusajs/medusa"
// // If using an exporter other than Zipkin, require it here.
// import { ZipkinExporter } from "@opentelemetry/exporter-zipkin"

// // If using an exporter other than Zipkin, initialize it here.
// const exporter = new ZipkinExporter({
//   serviceName: 'my-medusa-project',
// })

import { initSentry } from "./src/lib/observability/sentry";

/**
 * Medusa v2 auto-loads this file at boot and calls the exported `register()`.
 *
 * Sentry (BACKLOG M5 — backend error visibility): the H1 carrier subscriber,
 * H5 heal job, and lab packet-build failures were previously console.*-only
 * and invisible in prod. `initSentry()` wires `@sentry/node` with a PDPA
 * scrubber (see `src/lib/observability/sentry.ts`) and is DORMANT UNTIL
 * `SENTRY_DSN` IS SET — local dev and any un-provisioned Railway environment
 * stay silent no-ops, matching the Website repo's dormant-until-env
 * convention.
 */
export function register() {
  initSentry();

  // registerOtel({
  //   serviceName: 'medusajs',
  //   // pass exporter
  //   exporter,
  //   instrument: {
  //     http: true,
  //     workflows: true,
  //     query: true
  //   },
  // })
}