import { Badge, Button, Container, Heading, Select, Table, Text } from "@medusajs/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { sdk } from "../../../lib/client";
import { failureMessage, percent, shortId, stageLabel } from "../../../lib/lab";

type Report = {
  from: string;
  weeks: Array<{
    week_start: string;
    issued_for_orders: number;
    spoilage_replacements: number;
    remake_lenses: number;
    frames_spoiled: number;
    returned_unused: number;
    qc_failed: number;
    remakes_started: number;
    spoilage_rate: number | null;
    remake_rate: number | null;
  }>;
  jobs_truncated: boolean;
  jobs: Array<{
    lab_job_id: string;
    order_id: string;
    stage: string | null;
    remake_count: number;
    lenses_issued: number;
    lenses_returned: number;
    unexplained: number;
  }>;
};

const PERIODS = ["4", "12", "26", "52"];

const LabReportsPage = () => {
  const [weeks, setWeeks] = useState("12");
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["lab-reports", weeks],
    queryFn: () => sdk.client.fetch<Report>("/admin/lab-reports", { query: { weeks } }),
  });

  return (
    <div className="flex flex-col gap-3">
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading>Lab reports</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {data ? `From ${data.from}. ` : ""}Counts of lenses only; no lens power is shown here.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-40">
              <Select size="small" value={weeks} onValueChange={setWeeks}>
                <Select.Trigger aria-label="Period">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {PERIODS.map((p) => (
                    <Select.Item key={p} value={p}>
                      Last {p} weeks
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
            <Button asChild size="small" variant="secondary">
              <Link to="/lab">Queue</Link>
            </Button>
          </div>
        </div>
        {isLoading ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-subtle">
              Loading…
            </Text>
          </div>
        ) : null}
        {isError ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-error">
              The report could not be loaded: {failureMessage(error)}
            </Text>
          </div>
        ) : null}
      </Container>

      {data ? (
        <Container className="divide-y p-0">
          <div className="px-6 py-4">
            <Heading level="h2">Spoilage and remakes by week</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              A rate is replacement lenses per lens issued for an order in the same week. A replacement that
              later went back on the shelf uncut still counts. Weeks start on Monday.
            </Text>
          </div>
          {data.weeks.length === 0 ? (
            <div className="px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                No lens was used in this period.
              </Text>
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Week of</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">For orders</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Spoilage replacements</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Spoilage rate</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Remake lenses</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Remake rate</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Returned uncut</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Frames broken</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">QC failed</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Remakes started</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.weeks.map((w) => (
                  <Table.Row key={w.week_start}>
                    <Table.Cell>{w.week_start}</Table.Cell>
                    <Table.Cell className="text-right">{w.issued_for_orders}</Table.Cell>
                    <Table.Cell className="text-right">{w.spoilage_replacements}</Table.Cell>
                    <Table.Cell className="text-right">{percent(w.spoilage_rate)}</Table.Cell>
                    <Table.Cell className="text-right">{w.remake_lenses}</Table.Cell>
                    <Table.Cell className="text-right">{percent(w.remake_rate)}</Table.Cell>
                    <Table.Cell className="text-right">{w.returned_unused}</Table.Cell>
                    <Table.Cell className="text-right">{w.frames_spoiled}</Table.Cell>
                    <Table.Cell className="text-right">{w.qc_failed}</Table.Cell>
                    <Table.Cell className="text-right">{w.remakes_started}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </Container>
      ) : null}

      {data ? (
        <Container className="divide-y p-0">
          <div className="px-6 py-4">
            <Heading level="h2">Lenses per job against remakes</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              A job is expected to use one pair, and one more pair per counted remake. "More than explained" is
              a reason to look, not proof of a problem: a lens reissued after a spoil or a changed prescription
              is not a counted remake. Jobs with the most lenses beyond what is explained come first.
              {data.jobs_truncated ? " Only the first 200 jobs are listed." : ""}
            </Text>
          </div>
          {data.jobs.length === 0 ? (
            <div className="px-6 py-4">
              <Text size="small" className="text-ui-fg-subtle">
                No job used a lens in this period.
              </Text>
            </div>
          ) : (
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Order</Table.HeaderCell>
                  <Table.HeaderCell>Stage</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Lenses issued</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Returned uncut</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">Remakes</Table.HeaderCell>
                  <Table.HeaderCell className="text-right">More than explained</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {data.jobs.map((j) => (
                  <Table.Row key={j.lab_job_id}>
                    <Table.Cell>
                      <Link to={`/lab/${j.lab_job_id}`} title={j.order_id} className="text-ui-fg-interactive">
                        …{shortId(j.order_id)}
                      </Link>
                    </Table.Cell>
                    <Table.Cell>{stageLabel(j.stage)}</Table.Cell>
                    <Table.Cell className="text-right">{j.lenses_issued}</Table.Cell>
                    <Table.Cell className="text-right">{j.lenses_returned}</Table.Cell>
                    <Table.Cell className="text-right">{j.remake_count}</Table.Cell>
                    <Table.Cell className="text-right">
                      {j.unexplained > 0 ? (
                        <Badge size="2xsmall" color="orange">
                          {j.unexplained}
                        </Badge>
                      ) : (
                        0
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          )}
        </Container>
      ) : null}
    </div>
  );
};

export default LabReportsPage;
