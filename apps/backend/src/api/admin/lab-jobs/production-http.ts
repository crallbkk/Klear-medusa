// Shared by the lab's production routes: who may call what, how a request
// body is checked, and how a refusal is answered.

import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
  ProductionError,
  SYSTEM_ONLY_ACTIONS,
  type ProductionAction,
} from "../../../modules/lms/production";
import {
  LabJobNotRebuildableError,
  ProductionWriteError,
} from "../../../modules/lms/service";
import { captureException } from "../../../lib/observability/sentry";

/**
 * Permissions, in the words of Medusa's role module. They are declared on
 * the routes in `api/middlewares.ts`. Medusa enforces them only when its
 * role module is switched on (MEDUSA_FF_RBAC); until then any signed-in
 * admin user may call these routes, exactly as for the older lab-job routes.
 *
 *   lab_job:read     see the queue, a job's history, and (logged) its packet
 *   lab_job:update   record the lab's own steps
 *   lab_job_ops:update  hold and release, a changed prescription, retry
 */
export const LAB_READ = { resource: "lab_job", operation: "read" };
export const LAB_ACT = { resource: "lab_job", operation: "update" };
export const LAB_OPS = { resource: "lab_job_ops", operation: "update" };

/** What a person in the lab may record through `/actions`. */
export const LAB_ACTIONS: ReadonlySet<ProductionAction> = new Set<ProductionAction>([
  "PRINTED",
  "LENS_ISSUED",
  "SENT_TO_LAB",
  "RECEIVED_FROM_LAB",
  "EDGED",
  "MOUNTED",
  "QC_PASSED",
  "QC_FAILED",
  "REMAKE_STARTED",
  "REWORK",
  "LENS_SPOILED",
  "PACKED",
  "FRAME_DAMAGED",
  "LENS_RETURNED_UNUSED",
  "LENS_CUT_CONFIRMED",
  "LAB_INVOICED",
  "NOTE",
]);

/** What needs the ops permission, through `/ops-actions`. */
export const OPS_ACTIONS: ReadonlySet<ProductionAction> = new Set<ProductionAction>([
  "HOLD",
  "RELEASE",
]);

for (const a of [...LAB_ACTIONS, ...OPS_ACTIONS]) {
  // A system action offered to a person would be a bug in this file.
  if (SYSTEM_ONLY_ACTIONS.has(a)) throw new Error(`${a} is system-only`);
}

export type ActionBody = {
  action: ProductionAction;
  idempotency_key: string;
  expected_version?: number;
  happened_at?: Date | null;
  detail?: Record<string, unknown>;
};

/**
 * Read and check an action request. Returns the body, or null after
 * answering 400. Only the fields named here are taken from the request.
 */
export function readActionBody(
  req: MedusaRequest,
  res: MedusaResponse,
  allowed: ReadonlySet<ProductionAction>,
): ActionBody | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const bad = (message: string): null => {
    res.status(400).json({ type: "invalid_data", message });
    return null;
  };
  const action = body.action;
  if (typeof action !== "string" || !allowed.has(action as ProductionAction)) {
    return bad("that action cannot be recorded here");
  }
  if (typeof body.idempotency_key !== "string") return bad("idempotency_key is required");
  let expected_version: number | undefined;
  if (body.expected_version !== undefined && body.expected_version !== null) {
    if (typeof body.expected_version !== "number" || !Number.isInteger(body.expected_version)) {
      return bad("expected_version must be a whole number");
    }
    expected_version = body.expected_version;
  }
  let happened_at: Date | null = null;
  if (body.happened_at !== undefined && body.happened_at !== null) {
    const at = typeof body.happened_at === "string" ? new Date(body.happened_at) : null;
    if (!at || Number.isNaN(at.getTime())) return bad("happened_at must be a time");
    happened_at = at;
  }
  let detail: Record<string, unknown> | undefined;
  if (body.detail !== undefined && body.detail !== null) {
    if (typeof body.detail !== "object" || Array.isArray(body.detail)) {
      return bad("detail must be an object");
    }
    detail = body.detail as Record<string, unknown>;
  }
  return {
    action: action as ProductionAction,
    idempotency_key: body.idempotency_key,
    expected_version,
    happened_at,
    detail,
  };
}

/**
 * The signed-in admin user, or null after answering 401 or 403.
 *
 * A secret API key also authenticates on /admin, with the key's id as the
 * actor. A key is not a person: what the lab does, and above all who looked
 * at a prescription, is recorded against people only.
 */
export function actorOf(req: MedusaRequest, res: MedusaResponse): string | null {
  const auth = (req as { auth_context?: { actor_id?: string; actor_type?: string } }).auth_context;
  if (!auth?.actor_id) {
    res.status(401).json({ type: "unauthorized", message: "sign in to use the lab queue" });
    return null;
  }
  if (auth.actor_type !== "user") {
    res.status(403).json({ type: "forbidden", message: "the lab queue is for signed-in people, not API keys" });
    return null;
  }
  return auth.actor_id;
}

const STATUS: Record<string, number> = {
  not_found: 404,
  conflict: 409,
  not_allowed: 409,
  key_reused: 409,
  invalid_detail: 400,
};

/**
 * Answer a failed production request. A rule refusal carries its own plain
 * sentence, which holds no data. Anything else is answered with a fixed
 * sentence: a database error's own text can carry values (see
 * `ProductionWriteError`), so it is reported with ids only and never echoed.
 */
export function sendProductionError(
  res: MedusaResponse,
  err: unknown,
  where: string,
  jobId: string,
): void {
  if (err instanceof ProductionError) {
    res.status(STATUS[err.code] ?? 400).json({ type: err.code, message: err.message });
    return;
  }
  if (err instanceof LabJobNotRebuildableError) {
    res.status(409).json({ type: "not_allowed", message: "this job's packet cannot be rebuilt now" });
    return;
  }
  // Medusa's not-found for a job id that does not exist (and only that:
  // something else going missing is a fault, not a 404 for the job).
  const e = err as { type?: string; message?: string; name?: string; code?: unknown };
  if (e?.type === "not_found" && typeof e.message === "string" && /^LabJob with id/.test(e.message)) {
    res.status(404).json({ type: "not_found", message: "lab job not found" });
    return;
  }
  // The error's class and code say what kind of failure it was and hold no
  // values; its message can, so it is left out unless it is one of ours.
  const kind =
    err instanceof ProductionWriteError
      ? err.message
      : errorKind(err);
  console.error(`[${where}] failed for ${jobId}: ${kind}`);
  captureException(err instanceof ProductionWriteError ? err : new Error(`${where} failed: ${kind}`), {
    tags: { route: where },
    extra: { lab_job_id: jobId },
  });
  res.status(500).json({ type: "unexpected_state", message: "the action could not be recorded; try again" });
}

/**
 * What kind of error this is, for a log line: its class name, its error
 * code and Medusa's error type, each only if it has the shape of one. Never
 * its message. The shapes are narrow on purpose: a class name is letters, a
 * code is a short run of capitals and digits (SQLSTATE, ECONNREFUSED), a
 * type is lower-case words. A lens SKU, a phone number or a field name with
 * a value fits none of them.
 */
export function errorKind(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; type?: unknown };
  const parts = [
    typeof e?.name === "string" && /^[A-Z][A-Za-z]{1,39}$/.test(e.name) ? e.name : null,
    typeof e?.code === "string" && /^[A-Z0-9_]{1,12}$/.test(e.code) ? e.code : null,
    typeof e?.type === "string" && /^[a-z_]{1,30}$/.test(e.type) ? e.type : null,
  ].filter(Boolean);
  return parts.join("/") || "unexpected error";
}

/** An event as the job screen sees it. Not its idempotency key: knowing
 *  another person's key must not be worth anything, and showing it invites
 *  the attempt. */
export function publicEvent<T extends Record<string, unknown>>(
  event: T,
): Omit<T, "idempotency_key" | "request_hash"> {
  const { idempotency_key: _key, request_hash: _hash, ...rest } = event;
  return rest;
}

/** Why a packet could not be built, in fixed words. The builder's own
 *  reason is free text that can be made from an error, so it stays in the
 *  job's `last_error` for ops and is not passed on by the routes. */
export const NOT_BUILT: Record<string, string> = {
  pending_rx: "the prescription has not arrived yet",
  failed: "the packet could not be built; see the job's last error",
  skip: "this order has no lenses to make",
};

/** A job as the queue and the job screen see it: never the packet. */
export function withoutPacket<T extends Record<string, unknown>>(job: T): Omit<T, "packet_snapshot"> {
  const { packet_snapshot: _packet, ...rest } = job;
  return rest;
}
