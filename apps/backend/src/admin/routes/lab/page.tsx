import { defineRouteConfig } from "@medusajs/admin-sdk";
import { Beaker } from "@medusajs/icons";
import { Badge, Button, Container, Heading, Text } from "@medusajs/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { sdk } from "../../lib/client";
import { BOARD_COLUMNS, failureMessage, shortId, stageLabel, waited, type QueueJob } from "../../lib/lab";

type QueueResponse = {
  jobs: QueueJob[];
  counts: Record<string, number>;
  overdue: number;
  truncated: boolean;
};

/** One job on the board: a link to its screen. */
const JobRow = ({ job }: { job: QueueJob }) => (
  <Link
    to={`/lab/${job.id}`}
    className="outline-none focus-visible:shadow-borders-interactive-with-focus rounded-md [&:hover>div]:bg-ui-bg-component-hover"
  >
    <div className="shadow-elevation-card-rest bg-ui-bg-component rounded-md px-4 py-3 transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <Text size="small" leading="compact" weight="plus" title={job.order_id}>
            Order …{shortId(job.order_id)}
          </Text>
          <Text size="small" leading="compact" className="text-ui-fg-subtle">
            {stageLabel(job.stage)}
            {job.stage_since ? ` · ${waited(job.stage_since)}` : ""}
          </Text>
          {(job.column === "packet_failed" || job.column === "waiting_rx") && job.last_error ? (
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              {job.last_error}
            </Text>
          ) : null}
          {job.on_hold && job.hold_reason ? (
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Held: {job.hold_reason}
            </Text>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {job.overdue ? (
            <Badge size="2xsmall" color="red">
              Overdue
            </Badge>
          ) : null}
          {job.remake_count > 0 ? (
            <Badge size="2xsmall" color={job.remake_count >= 2 ? "red" : "orange"}>
              Remake {job.remake_count}
            </Badge>
          ) : null}
        </div>
      </div>
    </div>
  </Link>
);

const LabQueuePage = () => {
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["lab-queue"],
    queryFn: () => sdk.client.fetch<QueueResponse>("/admin/lab-queue"),
    // The board hangs on a wall or stays open on the bench.
    refetchInterval: 60_000,
  });

  const jobs = data?.jobs ?? [];
  const overdue = jobs.filter((j) => j.overdue);

  return (
    <div className="flex flex-col gap-3">
      <Container className="divide-y p-0">
        <div className="flex items-center justify-between px-6 py-4">
          <div>
            <Heading>Lab queue</Heading>
            <Text size="small" leading="compact" className="text-ui-fg-subtle">
              Every job the lab still has work on, the longest-waiting first.
            </Text>
          </div>
          <div className="flex items-center gap-2">
            <Button size="small" variant="secondary" onClick={() => refetch()} isLoading={isFetching}>
              Refresh
            </Button>
            <Button asChild size="small" variant="secondary">
              <Link to="/lab/reports">Reports</Link>
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-subtle">
              Loading…
            </Text>
          </div>
        ) : isError ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-error">
              The queue could not be loaded: {failureMessage(error)}
            </Text>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2 px-6 py-4">
            {BOARD_COLUMNS.map((column) => (
              <Badge key={column} size="small" color={(data?.counts[column] ?? 0) > 0 ? "blue" : "grey"}>
                {stageLabel(column)}: {data?.counts[column] ?? 0}
              </Badge>
            ))}
            <Badge size="small" color={(data?.overdue ?? 0) > 0 ? "red" : "grey"}>
              Overdue: {data?.overdue ?? 0}
            </Badge>
          </div>
        )}

        {data?.truncated ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-error">
              There are more jobs than this board shows.
            </Text>
          </div>
        ) : null}
      </Container>

      {overdue.length > 0 ? (
        <Container className="divide-y p-0">
          <div className="px-6 py-4">
            <Heading level="h2">Overdue ({overdue.length})</Heading>
          </div>
          <div className="flex flex-col gap-2 px-6 py-4">
            {overdue.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </div>
        </Container>
      ) : null}

      {data && jobs.length === 0 ? (
        <Container>
          <Text size="small" className="text-ui-fg-subtle">
            Nothing is waiting on the lab.
          </Text>
        </Container>
      ) : null}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {BOARD_COLUMNS.map((column) => {
          const inColumn = jobs.filter((j) => j.column === column);
          if (inColumn.length === 0) return null;
          return (
            <Container key={column} className="divide-y p-0">
              <div className="flex items-center justify-between px-6 py-4">
                <Heading level="h2">{stageLabel(column)}</Heading>
                <Badge size="2xsmall">{inColumn.length}</Badge>
              </div>
              <div className="flex flex-col gap-2 px-6 py-4">
                {inColumn.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </div>
            </Container>
          );
        })}
      </div>
    </div>
  );
};

export const config = defineRouteConfig({
  label: "Lab",
  icon: Beaker,
});

export default LabQueuePage;
