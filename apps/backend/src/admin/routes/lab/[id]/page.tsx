import {
  Badge,
  Button,
  Container,
  Drawer,
  Heading,
  Hint,
  Input,
  Label,
  Table,
  Text,
  Textarea,
  toast,
  usePrompt,
} from "@medusajs/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { sdk } from "../../../lib/client";
import {
  actionLabel,
  bahtToSatang,
  buildDetail,
  eventSummary,
  failureMessage,
  fieldsFor,
  formatBaht,
  keyFor,
  newKey,
  packetIsCurrent,
  requestIdentity,
  stageLabel,
  waited,
  type ActionField,
  type LabCost,
  type LabEvent,
  type LabJob,
} from "../../../lib/lab";

type JobResponse = {
  job: LabJob & { rx_redacted_at?: string | null; next_issue_reason?: string };
  events: LabEvent[];
  costs: LabCost[];
  actions: {
    lab: string[];
    ops: string[];
    packet: boolean;
    retry: boolean;
    rx_changed: boolean;
    warranty_remake: boolean;
  };
  vendors: string[];
};

type Eye = "right" | "left";
type Packet = {
  job_ref: string;
  klear_order_id: string;
  frame_sku: string;
  lens_type: string;
  lens_index: number | null;
  coating_addons: string[];
  prescription: Record<string, number | null> | null;
  customer: {
    name: string;
    phone: string;
    delivery_address: {
      line1: string;
      line2?: string;
      city: string;
      province: string;
      postal_code: string;
      country_code: string;
    };
  };
};

// The browser's own print (Ctrl+P) leaves the packet out: paper must not
// exist with only a "viewed" on record.
const PACKET_NOT_ON_PAPER = `
@media print {
  .lab-packet { display: none !important; }
}`;
// Through the Print button, which records the print first: only the packet.
const PRINT_ONLY_PACKET = `
@media print {
  body * { visibility: hidden !important; }
  .lab-packet, .lab-packet * { visibility: visible !important; }
  .lab-packet { position: absolute; left: 0; top: 0; width: 100%; }
}`;

const signed = (v: number | null | undefined, digits = 2): string => {
  if (v === null || v === undefined) return "";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}`;
};

/** The packet as the lab reads it at the bench and on paper. */
const PacketSheet = ({ packet }: { packet: Packet }) => {
  const rx = packet.prescription;
  const row = (eye: Eye) => ({
    sph: signed(rx?.[`sph_${eye}`]),
    cyl: signed(rx?.[`cyl_${eye}`]),
    axis: rx?.[`axis_${eye}`] ?? "",
    add: signed(rx?.[`add_${eye}`]),
    pd: rx?.[`pd_${eye}`] ?? "",
  });
  const a = packet.customer.delivery_address;
  return (
    <div className="lab-packet flex flex-col gap-4 px-6 py-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-2">
        {(
          [
            ["Job", packet.job_ref],
            ["Frame", packet.frame_sku],
            ["Lens", packet.lens_type.replace(/_/g, " ")],
            ["Index", packet.lens_index === null ? "" : String(packet.lens_index)],
            ["Coatings", packet.coating_addons.length > 0 ? packet.coating_addons.map((c) => c.replace(/_/g, " ")).join(", ") : "none"],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {label}
            </Text>
            <Text size="small" leading="compact" weight="plus">
              {value}
            </Text>
          </div>
        ))}
      </div>

      {rx ? (
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Eye</Table.HeaderCell>
              <Table.HeaderCell className="text-right">SPH</Table.HeaderCell>
              <Table.HeaderCell className="text-right">CYL</Table.HeaderCell>
              <Table.HeaderCell className="text-right">AXIS</Table.HeaderCell>
              <Table.HeaderCell className="text-right">ADD</Table.HeaderCell>
              <Table.HeaderCell className="text-right">PD</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {(["right", "left"] as const).map((eye) => {
              const r = row(eye);
              return (
                <Table.Row key={eye}>
                  <Table.Cell>{eye === "right" ? "Right (OD)" : "Left (OS)"}</Table.Cell>
                  <Table.Cell className="text-right">{r.sph}</Table.Cell>
                  <Table.Cell className="text-right">{r.cyl}</Table.Cell>
                  <Table.Cell className="text-right">{r.axis}</Table.Cell>
                  <Table.Cell className="text-right">{r.add}</Table.Cell>
                  <Table.Cell className="text-right">{r.pd}</Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table>
      ) : (
        <Text size="small" leading="compact" weight="plus">
          No prescription: plano lenses.
        </Text>
      )}

      <div className="flex flex-col">
        <Text size="small" leading="compact" className="text-ui-fg-subtle">
          Deliver to
        </Text>
        <Text size="small" leading="compact" weight="plus">
          {packet.customer.name} · {packet.customer.phone}
        </Text>
        <Text size="small" leading="compact">
          {[a.line1, a.line2, a.city, a.province, a.postal_code].filter(Boolean).join(", ")}
        </Text>
      </div>
    </div>
  );
};

/** One field of a step's form. */
const FieldInput = ({
  field,
  value,
  onChange,
  vendors,
}: {
  field: ActionField;
  value: string;
  onChange: (v: string) => void;
  vendors: string[];
}) => {
  const id = `lab-field-${field.name}`;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} size="small" weight="plus">
        {field.label}
        {field.required ? "" : " (optional)"}
      </Label>
      {field.kind === "text" ? (
        <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <Input
          id={id}
          size="small"
          type={field.kind === "date" ? "date" : "text"}
          inputMode={field.kind === "baht" ? "decimal" : undefined}
          autoComplete="off"
          list={field.kind === "vendor" ? `${id}-known` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === "vendor" ? (
        <datalist id={`${id}-known`}>
          {vendors.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      ) : null}
      {field.kind === "baht" && value.trim() !== "" ? (
        // What will be recorded, read back before it is: an amount cannot
        // be corrected on these screens afterwards.
        <Hint>
          {bahtToSatang(value) === null
            ? "Not an amount. Type it like 450 or 1,250.50."
            : `Will be recorded as ${formatBaht(bahtToSatang(value))} baht.`}
        </Hint>
      ) : null}
      {field.help ? <Hint>{field.help}</Hint> : null}
    </div>
  );
};

/** The route. The screen is remounted for another job, so nothing of one
 *  job (its packet above all) can be drawn under another. */
const LabJobPage = () => {
  const { id } = useParams<{ id: string }>();
  return id ? <JobScreen key={id} id={id} /> : null;
};

type OpenForm = {
  action: string;
  door: "actions" | "ops-actions" | "warranty-remake";
  // The job as it was when the form was opened: what the person decided on.
  stage_version: number;
  event_seq: number | undefined;
  values: Record<string, string>;
  problem?: string;
};
type Step = Omit<OpenForm, "problem"> & { detail?: Record<string, unknown> };

const JobScreen = ({ id }: { id: string }) => {
  const queryClient = useQueryClient();
  const prompt = usePrompt();

  const { data, isLoading, isError, error, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["lab-job", id],
    queryFn: () => sdk.client.fetch<JobResponse>(`/admin/lab-jobs/${id}/production`),
    refetchInterval: 60_000,
    // The admin switches this off by default. Here a tab that comes back to
    // the front may be showing a packet that was replaced meanwhile.
    refetchOnWindowFocus: "always",
  });

  // One key per request (see `requestIdentity`): the same press again, or a
  // retry after a lost connection, sends the same key and records nothing
  // twice; anything else is a new request.
  const kept = useRef(new Map<string, string>());

  const reload = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["lab-job", id] }),
      queryClient.invalidateQueries({ queryKey: ["lab-queue"] }),
    ]);

  // The step whose form is open, with what has been typed.
  const [form, setForm] = useState<OpenForm | null>(null);

  const record = useMutation({
    mutationFn: (step: Step) =>
      sdk.client.fetch<{ replayed?: boolean }>(`/admin/lab-jobs/${id}/${step.door}`, {
        method: "POST",
        body: {
          action: step.action,
          idempotency_key: keyFor(kept.current, requestIdentity(step.action, { id, ...step }, step.values)),
          expected_version: step.stage_version,
          detail: step.detail,
        },
      }),
    onSuccess: (result, step) => {
      setForm(null);
      if (result?.replayed) toast.info(`${actionLabel(step.action)}: this was already recorded.`);
      else toast.success(`${actionLabel(step.action)}: recorded`);
      // Awaited: the buttons stay disabled until the job is shown as it now is.
      return reload();
    },
    onError: (err) => {
      // Whether refused or unanswered, show the job as it now stands. A
      // step that did get recorded then shows in the history, and its
      // button is gone.
      toast.error(failureMessage(err));
      // The job is not as the form was opened on (it moved, or the step is
      // no longer possible): the form would be refused again every time.
      if ((err as { status?: number })?.status === 409) setForm(null);
      return reload();
    },
  });

  const press = async (action: string, door?: Step["door"]) => {
    if (!data) return;
    const step: Step = {
      action,
      door: door ?? (data.actions.ops.includes(action) ? "ops-actions" : "actions"),
      stage_version: data.job.stage_version,
      event_seq: data.job.event_seq,
      values: {},
    };
    if (fieldsFor(action).length > 0) {
      setForm(step);
      return;
    }
    if (action === "LENS_CUT_CONFIRMED") {
      const sure = await prompt({
        title: "The lens was cut?",
        description:
          "This records the issued lens as used. It cannot be undone. If the lens is uncut and goes back on the shelf, choose that instead.",
        confirmText: "Yes, it was cut",
        cancelText: "Cancel",
      });
      if (!sure) return;
    }
    record.mutate(step);
  };

  const submitForm = () => {
    if (!form) return;
    const built = buildDetail(form.action, form.values);
    if (!built.ok) {
      setForm({ ...form, problem: built.message });
      return;
    }
    record.mutate({ ...form, detail: built.detail });
  };

  // The packet is held in this screen's memory only, never in the query
  // cache, and is dropped when the screen closes or the packet stops being
  // the one to work from (rebuilt after a changed prescription, blanked,
  // cancelled), whoever did that and wherever.
  const [shown, setShown] = useState<{ packet: Packet; asOf: string; lookedAt: number } | null>(null);
  const [looking, setLooking] = useState(false);
  const [printing, setPrinting] = useState(false);
  const lookAllowed = data?.actions.packet ?? false;
  // Judged against a copy of the job read after the look, not an older one.
  const packetStale =
    shown !== null &&
    data !== undefined &&
    (dataUpdatedAt > shown.lookedAt ? !packetIsCurrent(shown.asOf, data.job, lookAllowed) : !lookAllowed);
  useEffect(() => {
    if (packetStale) {
      setShown(null);
      toast.info("The packet changed or can no longer be shown. Show it again to see the current one.");
    }
  }, [packetStale]);
  useEffect(() => {
    if (!(printing && shown)) return;
    // The packet-only print style stays until printing is over. Some
    // browsers return from print() before the page is drawn for paper.
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done, { once: true });
    window.print();
    return () => window.removeEventListener("afterprint", done);
  }, [printing, shown]);

  const look = async (printed: boolean) => {
    setLooking(true);
    try {
      // Every look is its own record, so every look has its own key.
      const seen = await sdk.client.fetch<{ packet: Packet; as_of: string }>(`/admin/lab-jobs/${id}/packet`, {
        method: "POST",
        body: { idempotency_key: newKey(), printed },
      });
      setShown({ packet: seen.packet, asOf: seen.as_of, lookedAt: Date.now() });
      if (printed) setPrinting(true);
    } catch (err) {
      toast.error(failureMessage(err));
    } finally {
      setLooking(false);
      void reload();
    }
  };

  const rxChanged = useMutation({
    mutationFn: (job: Pick<JobResponse["job"], "stage_version" | "event_seq">) =>
      sdk.client.fetch(`/admin/lab-jobs/${id}/rx-changed`, {
        method: "POST",
        body: { idempotency_key: keyFor(kept.current, requestIdentity("RX_CHANGED", { id, ...job })) },
      }),
    onSuccess: () => {
      setShown(null);
      toast.success("The packet was rebuilt from the new prescription. The job is back at Ready.");
      return reload();
    },
    onError: (err) => {
      toast.error(failureMessage(err));
      return reload();
    },
  });

  const retry = useMutation({
    mutationFn: () =>
      sdk.client.fetch<{ outcome?: string; reason?: string }>(`/admin/lab-jobs/${id}/retry`, { method: "POST" }),
    onSuccess: (result) => {
      if (result.reason) toast.info(`Not built: ${result.reason}`);
      else if (result.outcome === "failed") toast.error("The packet was built but could not be handed on. See the job.");
      else toast.success("The packet was rebuilt.");
      return reload();
    },
    onError: (err) => {
      toast.error(failureMessage(err));
      return reload();
    },
  });

  if (isLoading) {
    return (
      <Container>
        <Text size="small" className="text-ui-fg-subtle">
          Loading…
        </Text>
      </Container>
    );
  }
  // Only when there is nothing to show. A failed refresh of a job already
  // on the screen must not take the screen, an open form or the packet away.
  if (!data) {
    return (
      <Container>
        <Text size="small" className="text-ui-fg-error">
          The job could not be loaded: {failureMessage(error)}
        </Text>
        <div className="mt-3 flex gap-2">
          <Button size="small" variant="secondary" onClick={() => refetch()}>
            Try again
          </Button>
          <Button asChild size="small" variant="secondary">
            <Link to="/lab">Back to the queue</Link>
          </Button>
        </div>
      </Container>
    );
  }

  const { job, events, costs, actions, vendors } = data;
  const busy = record.isPending || rxChanged.isPending || retry.isPending || looking;
  const steps = [...actions.lab, ...actions.ops];
  const packet = shown && !packetStale ? shown.packet : null;

  return (
    <div className="flex flex-col gap-3">
      <style>{printing ? PRINT_ONLY_PACKET : PACKET_NOT_ON_PAPER}</style>

      {isError ? (
        <Container>
          <Text size="small" className="text-ui-fg-error">
            This screen could not be refreshed and may be out of date.{" "}
            <button type="button" className="underline" onClick={() => refetch()}>
              Refresh
            </button>
          </Text>
        </Container>
      ) : null}

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading>Order …{job.order_id.slice(-8)}</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {job.order_id}
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Badge size="small" color="blue">
              {stageLabel(job.stage)}
              {job.stage_since ? ` · ${waited(job.stage_since)}` : ""}
            </Badge>
            {job.remake_count > 0 ? (
              <Badge size="small" color={job.remake_count >= 2 ? "red" : "orange"}>
                Remake {job.remake_count}
              </Badge>
            ) : null}
            <Button asChild size="small" variant="secondary">
              <Link to="/lab">Queue</Link>
            </Button>
          </div>
        </div>

        {job.cut_question_pending ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" weight="plus" className="text-ui-fg-error">
              A lens was issued on this job. Was it cut? Answer below before anything else is done.
            </Text>
          </div>
        ) : null}
        {job.on_hold ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" weight="plus">
              On hold{job.hold_reason ? `: ${job.hold_reason}` : ""}
            </Text>
          </div>
        ) : null}
        {job.remake_count >= 2 ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact">
              Two remakes or more: customer service offers a refund at this point.
            </Text>
          </div>
        ) : null}
        {(job.status === "failed" || job.status === "pending_rx") && job.last_error ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Packet: {job.last_error}
            </Text>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2 px-6 py-4">
          {steps.map((action) => (
            <Button
              key={action}
              size="small"
              variant={actions.ops.includes(action) || action === "NOTE" ? "secondary" : "primary"}
              disabled={busy}
              onClick={() => press(action)}
            >
              {actionLabel(action)}
            </Button>
          ))}
          {actions.rx_changed ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              isLoading={rxChanged.isPending}
              onClick={async () => {
                const sure = await prompt({
                  title: "Prescription changed?",
                  description:
                    "The packet is rebuilt from the order's current prescription and the job goes back to Ready. If a lens was already issued, the lab is asked whether it was cut.",
                  confirmText: "Rebuild the packet",
                  cancelText: "Cancel",
                });
                if (sure) rxChanged.mutate({ stage_version: job.stage_version, event_seq: job.event_seq });
              }}
            >
              Prescription changed
            </Button>
          ) : null}
          {actions.warranty_remake ? (
            // The prescription was removed from this packet after delivery.
            // This fetches it back from the customer's stored prescription,
            // then starts the remake.
            <Button
              size="small"
              variant="primary"
              disabled={busy}
              onClick={() => press("REMAKE_STARTED", "warranty-remake")}
            >
              Start warranty remake
            </Button>
          ) : null}
          {actions.retry ? (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              isLoading={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Rebuild packet
            </Button>
          ) : null}
        </div>
      </Container>

      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading level="h2">Packet</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              The packet holds the prescription. Every time it is shown or printed, that is recorded against
              your account. Print packet records a print as soon as it is pressed, even if you then cancel.
              The browser's own print leaves the packet out.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            {packet ? (
              <Button size="small" variant="secondary" disabled={looking} onClick={() => setShown(null)}>
                Hide
              </Button>
            ) : null}
            <Button size="small" variant="secondary" disabled={!actions.packet || busy} onClick={() => look(false)}>
              Show packet
            </Button>
            <Button size="small" variant="secondary" disabled={!actions.packet || busy} onClick={() => look(true)}>
              Print packet
            </Button>
          </div>
        </div>
        {!actions.packet ? (
          <div className="px-6 py-4">
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              This job has no packet to work from right now.
            </Text>
          </div>
        ) : null}
        {packet ? <PacketSheet packet={packet} /> : null}
      </Container>

      {costs.length > 0 ? (
        <Container className="divide-y p-0">
          <div className="px-6 py-4">
            <Heading level="h2">Outside lab</Heading>
          </div>
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Lab</Table.HeaderCell>
                <Table.HeaderCell>Expected</Table.HeaderCell>
                <Table.HeaderCell>Back</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Quoted</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Invoiced</Table.HeaderCell>
                <Table.HeaderCell className="text-right">Difference</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {costs.map((c) => {
                const diff = c.invoiced_satang === null ? null : c.invoiced_satang - c.quoted_satang;
                return (
                  <Table.Row key={c.id}>
                    <Table.Cell>{c.vendor}</Table.Cell>
                    <Table.Cell>{c.expected_on ?? ""}</Table.Cell>
                    <Table.Cell>{c.received_at ? new Date(c.received_at).toLocaleDateString() : "not yet"}</Table.Cell>
                    <Table.Cell className="text-right">{formatBaht(c.quoted_satang)}</Table.Cell>
                    <Table.Cell className="text-right">
                      {c.invoiced_satang === null ? "not yet" : formatBaht(c.invoiced_satang)}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {diff === null ? (
                        ""
                      ) : diff > 0 ? (
                        <Badge size="2xsmall" color="red">
                          +{formatBaht(diff)}
                        </Badge>
                      ) : (
                        formatBaht(diff)
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </Container>
      ) : null}

      <Container className="divide-y p-0">
        <div className="px-6 py-4">
          <Heading level="h2">History</Heading>
        </div>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>#</Table.HeaderCell>
              <Table.HeaderCell>When</Table.HeaderCell>
              <Table.HeaderCell>What</Table.HeaderCell>
              <Table.HeaderCell>Stage</Table.HeaderCell>
              <Table.HeaderCell>Who</Table.HeaderCell>
              <Table.HeaderCell>Details</Table.HeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {[...events].reverse().map((e) => (
              <Table.Row key={e.id}>
                <Table.Cell>{e.seq}</Table.Cell>
                <Table.Cell>{new Date(e.happened_at ?? e.created_at).toLocaleString()}</Table.Cell>
                <Table.Cell>{actionLabel(e.action)}</Table.Cell>
                <Table.Cell>{e.to_stage ? stageLabel(e.to_stage) : ""}</Table.Cell>
                <Table.Cell>{e.actor_type === "system" ? "system" : e.actor_id}</Table.Cell>
                <Table.Cell>{eventSummary(e)}</Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </Container>

      <Drawer open={form !== null} onOpenChange={(open) => (open ? null : setForm(null))}>
        <Drawer.Content>
          <Drawer.Header>
            <Drawer.Title>{form ? actionLabel(form.action) : ""}</Drawer.Title>
            <Drawer.Description>Recorded in the job's history against your account.</Drawer.Description>
          </Drawer.Header>
          <Drawer.Body className="flex flex-col gap-4">
            {form
              ? fieldsFor(form.action).map((field) => (
                  <FieldInput
                    key={field.name}
                    field={field}
                    vendors={vendors}
                    value={form.values[field.name] ?? ""}
                    onChange={(v) =>
                      setForm({ ...form, problem: undefined, values: { ...form.values, [field.name]: v } })
                    }
                  />
                ))
              : null}
            {form?.problem ? (
              <Text size="small" leading="compact" className="text-ui-fg-error">
                {form.problem}
              </Text>
            ) : null}
          </Drawer.Body>
          <Drawer.Footer>
            <Button size="small" variant="secondary" disabled={record.isPending} onClick={() => setForm(null)}>
              Cancel
            </Button>
            <Button size="small" isLoading={record.isPending} disabled={record.isPending} onClick={submitForm}>
              Record
            </Button>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </div>
  );
};

export default LabJobPage;
