import {
  IconAlertTriangle,
  IconBolt,
  IconClock,
  IconHistory,
  IconMessage,
  IconRefresh,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RunStatusBadge } from "@/components/routines/RunStatusBadge";
import {
  useOpenChatThread,
  useRoutineRuns,
  type RoutineRunView,
} from "@/hooks/use-routines";
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from "@/lib/format-time";

interface RoutineRunsListProps {
  /** Narrow to one routine's runs; omit for all of the user's runs. */
  name?: string;
}

/**
 * Run history list. Reads `list-routine-runs` (owner-scoped, polled) and renders
 * each run's status, duration, trigger, error, and a deep-link to the chat
 * thread the run created so the user can see exactly what the agent did.
 */
export function RoutineRunsList({ name }: RoutineRunsListProps) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useRoutineRuns(name);
  const runs = data?.runs ?? [];

  if (isLoading) return <RunsSkeleton />;

  if (isError) {
    return (
      <ErrorState
        message={
          error instanceof Error ? error.message : "Could not load run history."
        }
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }

  if (runs.length === 0) {
    return <EmptyState scoped={!!name} />;
  }

  return (
    <ul className="space-y-2.5">
      {runs.map((run) => (
        <RunRow key={run.id} run={run} showName={!name} />
      ))}
    </ul>
  );
}

interface RunRowProps {
  run: RoutineRunView;
  showName: boolean;
}

function RunRow({ run, showName }: RunRowProps) {
  const openThread = useOpenChatThread();
  const KindIcon = run.kind === "event" ? IconBolt : IconClock;

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {showName ? (
            <span className="truncate text-sm font-medium">
              {run.routineName}
            </span>
          ) : null}
          <RunStatusBadge status={run.status} />
          <Badge variant="secondary" className="gap-1 font-normal">
            <KindIcon className="size-3" />
            {run.trigger === "manual"
              ? "Manual"
              : run.kind === "event"
                ? "Event"
                : "Schedule"}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span title={formatAbsoluteTime(run.startedAt)}>
            Started {formatRelativeTime(run.startedAt)}
          </span>
          <span>Took {formatDuration(run.durationMs)}</span>
          {run.trigger && run.trigger !== "manual" ? (
            <span className="truncate font-mono">{run.trigger}</span>
          ) : null}
        </div>

        {run.status === "error" && run.error ? (
          <p className="flex items-start gap-1.5 break-words text-xs text-destructive">
            <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0">{run.error}</span>
          </p>
        ) : null}
      </div>

      <div className="shrink-0">
        {run.threadId ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openThread(run.threadId as string)}
                aria-label="Open the chat thread for this run"
              >
                <IconMessage className="size-4" />
                Thread
              </Button>
            </TooltipTrigger>
            <TooltipContent>See what the agent did in this run</TooltipContent>
          </Tooltip>
        ) : (
          <span className="text-xs text-muted-foreground">No thread</span>
        )}
      </div>
    </li>
  );
}

function EmptyState({ scoped }: { scoped: boolean }) {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
          <IconHistory className="size-5 text-muted-foreground" />
        </div>
        <CardTitle className="text-base">No runs yet</CardTitle>
        <CardDescription>
          {scoped
            ? "This routine has not run yet. Use “Try it once” on the editor, or wait for its next trigger."
            : "Once a routine runs — on schedule, on an event, or via “Try it once” — it appears here."}
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function ErrorState({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <Card className="border-destructive/40">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-destructive/10">
          <IconAlertTriangle className="size-5 text-destructive" />
        </div>
        <CardTitle className="text-base">Could not load run history</CardTitle>
        <CardDescription className="break-words">{message}</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center pb-6">
        <Button variant="outline" onClick={onRetry} disabled={retrying}>
          <IconRefresh className="size-4" />
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}

function RunsSkeleton() {
  return (
    <ul className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-44" />
            <Skeleton className="h-3 w-60" />
          </div>
          <Skeleton className="h-8 w-20" />
        </li>
      ))}
    </ul>
  );
}
