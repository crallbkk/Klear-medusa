import type { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { LMS_MODULE } from "../../../../../modules/lms/service";
import type LmsModuleService from "../../../../../modules/lms/service";
import {
  offeredActions,
  wouldAccept,
  writeOffRefusal,
  type JobState,
  type PacketState,
  type QuoteState,
} from "../../../../../modules/lms/production";
import { alsoOffered } from "../../../../../modules/lms/board";
import { isLabAccount } from "../../../lab-gate";
import {
  LAB_ACTIONS,
  OPS_ACTIONS,
  jobFor,
  publicEvent,
  sendProductionError,
} from "../../production-http";

/**
 * GET /admin/lab-jobs/[id]/production: a job for the job screen. Its
 * production state, its history, its outside-lab quotes, the steps that can
 * be recorded on it now (`actions.lab` through `/actions`, `actions.ops`
 * through `/ops-actions`), whether its packet can be shown, whether Retry
 * or a changed prescription would be accepted, the quotes that can be
 * written off (`actions.write_off`, quote ids, through `/ops-actions`), and
 * the outside labs used.
 *
 * The offered steps come from the production rules themselves, so the
 * screen shows a button exactly when the step would be accepted. Never the
 * packet: that is `POST /admin/lab-jobs/[id]/packet`, which records who
 * looked.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const id = req.params.id;
  try {
    const lms = req.scope.resolve(LMS_MODULE) as LmsModuleService;
    const job = await lms.retrieveLabJob(id);
    const [events, costs, vendors] = await Promise.all([
      lms.listProductionEventsForJob(id),
      lms.listLabCosts({ lab_job_id: id }, { order: { created_at: "ASC" }, take: 100 }),
      lms.listLabVendors(),
    ]);
    // An invoice is entered against a quote that has none yet; with no such
    // quote the writer refuses it, so the screen does not offer it. It is an
    // ops step (`OPS_ACTIONS`): only a full admin records the lab's bill,
    // so a lab account, given no ops steps below, is never offered it.
    const quoteOpen = (costs as Array<{ invoiced_satang: number | null }>).some(
      (c) => c.invoiced_satang === null || c.invoiced_satang === undefined,
    );
    const state = job as unknown as JobState & PacketState;
    // A write-off is offered on a quote, not on the job: the quote's row
    // carries the button. It is never one of the job's buttons.
    const offered = offeredActions(state).filter(
      (a) => (a !== "LAB_INVOICED" || quoteOpen) && a !== "LAB_QUOTE_WRITTEN_OFF",
    );
    const also = alsoOffered(job as unknown as Parameters<typeof alsoOffered>[0]);
    const lab = isLabAccount(req);
    // The same two checks the writer makes: the rules for the job, and the
    // quote's own state.
    const writeOff =
      !lab && wouldAccept(state, "LAB_QUOTE_WRITTEN_OFF")
        ? (costs as unknown as Array<QuoteState & { id: string }>)
            .filter((c) => writeOffRefusal(c) === null)
            .map((c) => c.id)
        : [];
    res.json({
      job: jobFor(req, job as unknown as Record<string, unknown>),
      events: events.map((e) => publicEvent(e as unknown as Record<string, unknown>)),
      // A write-off's reason is free text that may name a customer; it is
      // for ops. A lab account sees that a quote was written off, and when.
      costs: lab
        ? (costs as unknown as Array<Record<string, unknown>>).map(
            ({ written_off_reason: _reason, ...cost }) => cost,
          )
        : costs,
      actions: {
        lab: offered.filter((a) => LAB_ACTIONS.has(a)),
        // A lab account cannot reach the ops routes (`lab-gate.ts`), so it
        // is not shown their buttons. Looking at the packet stays.
        ...(lab
          ? { ops: [], packet: also.packet, retry: false, rx_changed: false, warranty_remake: false }
          : { ops: offered.filter((a) => OPS_ACTIONS.has(a)), ...also }),
        write_off: writeOff,
      },
      vendors,
    });
  } catch (err) {
    sendProductionError(res, err, "admin/lab-jobs/production", id);
  }
}
