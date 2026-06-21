import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  IconBolt,
  IconClock,
  IconDotsVertical,
  IconHistory,
  IconKey,
  IconLayoutGrid,
  IconPlus,
  IconRefresh,
  IconTrash,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { RoutineStatusBadge } from "@/components/routines/RoutineStatusBadge";
import {
  useRoutines,
  useSetRoutineEnabled,
  useDeleteRoutine,
  type RoutineSummary,
} from "@/hooks/use-routines";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format-time";

export function meta() {
  return [{ title: "Routines" }];
}

export default function RoutinesListPage() {
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">Routines</h1>,
  );
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useRoutines();
  const setEnabled = useSetRoutineEnabled();
  const deleteRoutine = useDeleteRoutine();
  const [pendingDelete, setPendingDelete] = useState<RoutineSummary | null>(
    null,
  );

  const routines = data?.routines ?? [];

  async function handleConfirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null);
    await deleteRoutine.mutateAsync({ name: target.name });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Routines</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Automations that run your instructions on a schedule or when an
            event fires.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button asChild variant="outline">
            <Link to="/routines/templates">
              <IconLayoutGrid className="size-4" />
              Templates
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/routines/keys">
              <IconKey className="size-4" />
              Keys
            </Link>
          </Button>
          <Button asChild>
            <Link to="/routines/new">
              <IconPlus className="size-4" />
              New routine
            </Link>
          </Button>
        </div>
      </header>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorState
          message={
            error instanceof Error ? error.message : "Could not load routines."
          }
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : routines.length === 0 ? (
        <EmptyState onCreate={() => navigate("/routines/new")} />
      ) : (
        <ul className="space-y-2.5">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.name}
              routine={routine}
              onToggle={(enabled) =>
                setEnabled.mutate({ name: routine.name, enabled })
              }
              onDelete={() => setPendingDelete(routine)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete routine?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete
                ? `"${pendingDelete.name}" will be permanently removed. This cannot be undone.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => void handleConfirmDelete()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface RoutineRowProps {
  routine: RoutineSummary;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}

function RoutineRow({ routine, onToggle, onDelete }: RoutineRowProps) {
  const isEvent = routine.kind === "event";
  const KindIcon = isEvent ? IconBolt : IconClock;
  const triggerSummary = isEvent
    ? (routine.event ?? "No event")
    : routine.describeCron || routine.schedule;

  return (
    <li className="group flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-border/80">
      <Link
        to={`/routines/${routine.name}`}
        className="flex min-w-0 flex-1 flex-col gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{routine.name}</span>
          <Badge variant="secondary" className="gap-1 font-normal">
            <KindIcon className="size-3" />
            {isEvent ? "Event" : "Schedule"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className={isEvent ? "truncate font-mono" : "truncate"}>
            {triggerSummary}
          </span>
          <RoutineStatusBadge
            status={routine.lastStatus}
            enabled={routine.enabled}
          />
          <span title={formatAbsoluteTime(routine.lastRun)}>
            Last run {formatRelativeTime(routine.lastRun)}
          </span>
        </div>
      </Link>

      <div className="flex shrink-0 items-center gap-2">
        <Switch
          checked={routine.enabled}
          onCheckedChange={onToggle}
          aria-label={`${routine.enabled ? "Disable" : "Enable"} ${routine.name}`}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Options for ${routine.name}`}
            >
              <IconDotsVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={`/routines/${routine.name}`}>Edit</Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to={`/routines/${routine.name}/runs`}>
                <IconHistory className="size-4" />
                Run history
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
              onSelect={onDelete}
            >
              <IconTrash className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
          <IconClock className="size-5 text-muted-foreground" />
        </div>
        <CardTitle className="text-base">No routines yet</CardTitle>
        <CardDescription>
          Start from a template, or create a scheduled or event routine to run
          instructions automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-2 pb-6 sm:flex-row sm:justify-center">
        <Button onClick={onCreate}>
          <IconPlus className="size-4" />
          Create your first routine
        </Button>
        <Button asChild variant="outline">
          <Link to="/routines/templates">
            <IconLayoutGrid className="size-4" />
            Browse templates
          </Link>
        </Button>
      </CardContent>
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
        <CardTitle className="text-base">Could not load routines</CardTitle>
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

function ListSkeleton() {
  return (
    <ul className="space-y-2.5">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-5 w-9 rounded-full" />
        </li>
      ))}
    </ul>
  );
}
