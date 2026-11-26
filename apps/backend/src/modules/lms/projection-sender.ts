// Posting a job's production state to the Website (contract 6) and sending
// again what it has not taken. No queue, no outbox: the job row holds the
// latest state to show (`projection_*`, written by the production writer)
// and the sequence the Website last took (`projection_sent_seq`). A send
// that fails is simply sent again by the half-hourly sweep
// (`jobs/heal-pending-rx.ts`), always with the latest state.
//
//   KLEAR_STOREFRONT_URL      the Website (shared with the carrier updates).
//                             https, or http to this machine only.
//   KLEAR_PROJECTION_SECRET   bearer secret for this one route, at least 32
//                             characters, different from every other Klear
//                             secret; unset → nothing is sent
//
// Redirects are never followed, so the secret only goes to the configured
// host. Never throws: a lab action has already been recorded when this runs.

import { PROJECTION_PATH, isAcknowledged, projectionMessage, type ProjectionColumns } from "./projection";
import { captureMessage } from "../../lib/observability/sentry";

export type ProjectionStore = {
  getProjection(jobId: string): Promise<(ProjectionColumns & { id: string; projection_sent_seq: number }) | null>;
  markProjectionDelivered(jobId: string, sequence: number): Promise<void>;
  markProjectionAttempt(jobId: string, notReady: boolean): Promise<void>;
  listUnsentProjections(): Promise<Array<{ id: string }>>;
  giveUpProjections(): Promise<Array<{ id: string; order_id: string }>>;
};

type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
    redirect: "error";
  },
) => Promise<{ status: number; json(): Promise<unknown> }>;

export type SenderDeps = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  fetch?: FetchLike;
  log?: { warn(line: string): void; error(line: string): void };
  /** Milliseconds clock, for the sweep's time budget. */
  now?: () => number;
  /** How long one sweep may spend sending (default 60 seconds). */
  budgetMs?: number;
};

/** Every other Klear secret this server may hold. The projection secret must
 *  differ from all of them, or a leak of one would open two doors. */
const OTHER_SECRETS = [
  "KLEAR_CARRIER_WEBHOOK_SECRET",
  "KLEAR_ORDER_CANCEL_SECRET",
  "KLEAR_OPS_FEED_SECRET",
  "KLEAR_STOCK_SYNC_SECRET",
  "KLEAR_LENS_SNAPSHOT_SECRET",
  "KLEAR_RX_METADATA_SECRET",
] as const;

const TIMEOUT_MS = 8_000;
const SWEEP_BUDGET_MS = 60_000;

let warnedUnconfigured = false;

/** https anywhere, or http to this machine (local development and tests). */
function allowedBase(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function config(env: Record<string, string | undefined>): { url: string; secret: string } | { problem: string } {
  const base = (env.KLEAR_STOREFRONT_URL ?? "").trim().replace(/\/+$/, "");
  const secret = (env.KLEAR_PROJECTION_SECRET ?? "").trim();
  if (!base || secret.length < 32) {
    return { problem: "KLEAR_STOREFRONT_URL or KLEAR_PROJECTION_SECRET (32+ characters) is not set" };
  }
  if (!allowedBase(base)) return { problem: "KLEAR_STOREFRONT_URL must be https" };
  for (const other of OTHER_SECRETS) {
    if ((env[other] ?? "").trim() === secret) {
      return { problem: `KLEAR_PROJECTION_SECRET holds the same value as ${other}` };
    }
  }
  return { url: `${base}${PROJECTION_PATH}`, secret };
}

export type DeliveryOutcome = "acknowledged" | "not_acknowledged" | "nothing_to_send" | "not_configured" | "failed";

/** Send one job's latest state, if the Website has not taken it. */
export async function deliverProjection(
  store: ProjectionStore,
  jobId: string,
  deps: SenderDeps = {},
): Promise<DeliveryOutcome> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? console;
  const cfg = config(env);
  if ("problem" in cfg) {
    if (!warnedUnconfigured && env.KLEAR_PROJECTION_SECRET) {
      warnedUnconfigured = true;
      log.error(`[lms-projection] not sending: ${cfg.problem}`);
      captureMessage("[lms-projection] order status projection is not configured", {
        level: "error",
        tags: { module: "lms", reason: "projection_not_configured" },
      });
    }
    return "not_configured";
  }
  try {
    const job = await store.getProjection(jobId);
    if (!job) return "nothing_to_send";
    const message = projectionMessage(job);
    if (!message || message.sequence <= Number(job.projection_sent_seq ?? 0)) return "nothing_to_send";

    const doFetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    let status = 0;
    let body: unknown = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await doFetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
          body: JSON.stringify(message),
          signal: controller.signal,
          redirect: "error",
        });
        status = res.status;
        body = await res.json().catch(() => null);
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Website unreachable (or it redirected): sent again by the sweep.
      status = 0;
    }
    if (!isAcknowledged(status, body)) {
      const notReady = status === 409 && (body as { outcome?: unknown } | null)?.outcome === "not_ready";
      await store.markProjectionAttempt(jobId, notReady);
      return "not_acknowledged";
    }
    await store.markProjectionDelivered(jobId, message.sequence);
    return "acknowledged";
  } catch (err) {
    log.warn(`[lms-projection] job ${jobId}: could not send (${(err as Error)?.name ?? "error"})`);
    return "failed";
  }
}

/**
 * The sweep: send again every job whose latest state was not taken, the
 * ones tried longest ago first, within a time budget; then report, once
 * each, the states it has given up sending (older than 30 days, or "not
 * ready" too often), for a person to look at.
 */
export async function resendUnacknowledgedProjections(
  store: ProjectionStore,
  deps: SenderDeps = {},
): Promise<{ tried: number; acknowledged: number; not_acknowledged: number; gave_up: number }> {
  const result = { tried: 0, acknowledged: 0, not_acknowledged: 0, gave_up: 0 };
  if ("problem" in config(deps.env ?? process.env)) return result;
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.budgetMs ?? SWEEP_BUDGET_MS);
  const jobs = await store.listUnsentProjections();
  for (const job of jobs) {
    if (now() >= deadline) break;
    result.tried++;
    const outcome = await deliverProjection(store, job.id, deps);
    if (outcome === "acknowledged" || outcome === "nothing_to_send") result.acknowledged++;
    else result.not_acknowledged++;
  }
  const given = await store.giveUpProjections();
  for (const job of given) {
    result.gave_up++;
    captureMessage("[lms-projection] stopped sending an order's production state to the Website", {
      level: "warning",
      tags: { module: "lms", reason: "projection_given_up" },
      extra: { lab_job_id: job.id, order_id: job.order_id },
    });
  }
  return result;
}
