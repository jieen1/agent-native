import { useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  IconArrowLeft,
  IconBolt,
  IconClock,
  IconLoader2,
  IconPlus,
  IconRefresh,
  IconSettingsBolt,
  IconAlertTriangle,
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
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import {
  useForkRoutine,
  useRoutineTemplates,
  type RoutineTemplate,
} from "@/hooks/use-routines";
import { describeCron, looksLikeCron } from "@/lib/cron";

export function meta() {
  return [{ title: "Routine templates" }];
}

export default function RoutineTemplatesPage() {
  useSetPageTitle(
    <h1 className="truncate text-lg font-semibold tracking-tight">
      Routine templates
    </h1>,
  );
  const navigate = useNavigate();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useRoutineTemplates();
  const fork = useForkRoutine();
  // Track which template is being forked so only that card shows a spinner.
  const [forkingId, setForkingId] = useState<string | null>(null);

  const templates = data?.templates ?? [];

  async function handleFork(template: RoutineTemplate) {
    if (fork.isPending) return;
    setForkingId(template.id);
    try {
      const result = await fork.mutateAsync({ presetId: template.id });
      const name = result?.routine?.name;
      // Land on the new routine's edit page so the user can tweak it before it
      // runs (the fork is enabled by default).
      navigate(name ? `/routines/${name}` : "/routines");
    } catch {
      // useForkRoutine surfaces the server error via toast; stay on the page.
    } finally {
      setForkingId(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <Button asChild variant="ghost" size="sm" className="mb-4 -ml-2">
        <Link to="/routines">
          <IconArrowLeft className="size-4" />
          Routines
        </Link>
      </Button>

      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">
          Routine templates
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Start from a ready-made routine. Forking copies it into your routines,
          where you can edit, enable, or delete it independently.
        </p>
      </header>

      {isLoading ? (
        <ListSkeleton />
      ) : isError ? (
        <ErrorState
          message={
            error instanceof Error ? error.message : "Could not load templates."
          }
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : templates.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              forking={forkingId === template.id}
              disabled={fork.isPending}
              onFork={() => void handleFork(template)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

interface TemplateCardProps {
  template: RoutineTemplate;
  forking: boolean;
  disabled: boolean;
  onFork: () => void;
}

function TemplateCard({
  template,
  forking,
  disabled,
  onFork,
}: TemplateCardProps) {
  return (
    <li>
      <Card className="flex h-full flex-col">
        <CardHeader className="flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <CategoryBadge template={template} />
            {template.mode === "deterministic" ? (
              <Badge variant="outline" className="gap-1 font-normal">
                <IconSettingsBolt className="size-3" />
                No AI
              </Badge>
            ) : null}
          </div>
          <CardTitle className="text-base">{template.displayName}</CardTitle>
          <CardDescription>{template.description}</CardDescription>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            <TriggerSummary template={template} />
          </p>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            onClick={onFork}
            disabled={disabled}
            aria-label={`Use the ${template.displayName} template`}
          >
            {forking ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconPlus className="size-4" />
            )}
            Use this template
          </Button>
        </CardContent>
      </Card>
    </li>
  );
}

function CategoryBadge({ template }: { template: RoutineTemplate }) {
  if (template.triggerType === "event") {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <IconBolt className="size-3" />
        {template.sourceApp ? `Event · ${template.sourceApp}` : "Event"}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1 font-normal">
      <IconClock className="size-3" />
      Schedule
    </Badge>
  );
}

/** One-line trigger description: human cron for schedule, event name otherwise. */
function TriggerSummary({ template }: { template: RoutineTemplate }) {
  if (template.triggerType === "event") {
    return <span className="font-mono">{template.event ?? "event"}</span>;
  }
  const human =
    template.schedule && looksLikeCron(template.schedule)
      ? describeCron(template.schedule)
      : template.schedule;
  return <>{human || "Scheduled"}</>;
}

function EmptyState() {
  return (
    <Card className="border-dashed">
      <CardHeader className="items-center text-center">
        <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted">
          <IconClock className="size-5 text-muted-foreground" />
        </div>
        <CardTitle className="text-base">No templates available</CardTitle>
        <CardDescription>
          There are no built-in routine templates right now. Create a routine
          from scratch instead.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center pb-6">
        <Button asChild variant="outline">
          <Link to="/routines/new">
            <IconPlus className="size-4" />
            New routine
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
        <CardTitle className="text-base">Could not load templates</CardTitle>
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
    <ul className="grid gap-3 sm:grid-cols-2">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
        >
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-9 w-full" />
        </li>
      ))}
    </ul>
  );
}
