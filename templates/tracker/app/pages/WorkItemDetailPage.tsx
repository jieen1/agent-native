import { useState } from "react";
import { useParams, Link } from "react-router";
import { useActivity, useDispatch, useWorkItem } from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconArrowLeft,
  IconBrandGithub,
  IconClock,
  IconExternalLink,
  IconGitBranch,
  IconLayoutKanban,
  IconLoader2,
  IconMessageCircle,
  IconRocket,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { ActivityFeed } from "@/components/ActivityFeed";
import {
  fmtDateTime,
  orchestratorBrainHref,
  repoHref,
  repoLabel,
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";

// ── Small status chip (header) ───────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const pres = statusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        pres.chip,
      )}
    >
      <span
        className={cn(
          "size-1.5 rounded-full",
          pres.dot,
          pres.live && "animate-pulse",
        )}
      />
      {pres.label}
    </span>
  );
}

// ── Metadata row (definition list) ───────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconBrandGithub;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="w-20 shrink-0 pt-px text-xs text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

export function WorkItemDetailPage() {
  const { id = "" } = useParams();
  const { data: item, isLoading } = useWorkItem(id);
  const dispatch = useDispatch();
  const dispatched = !!item?.orchestratorThreadId;
  const activity = useActivity(id, dispatched);

  // Monitor interval (sec) for the orchestrator brain's periodic drift-check
  // wake. Blank → server default (120); 0 → event-only (no timer wakes).
  const [monitorInterval, setMonitorInterval] = useState("");

  function onDispatch() {
    const trimmed = monitorInterval.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    const monitorIntervalSec =
      parsed !== undefined && Number.isFinite(parsed) && parsed >= 0
        ? Math.floor(parsed)
        : undefined;
    dispatch.mutate(
      monitorIntervalSec !== undefined
        ? { workItemId: id, monitorIntervalSec }
        : { workItemId: id },
      {
        onSuccess: (res: { threadId: string }) => {
          toast.success(
            `Dispatched — brain thread ${res.threadId.slice(0, 12)}…`,
          );
        },
      },
    );
  }

  if (isLoading && !item) {
    return (
      <div className="mx-auto max-w-5xl space-y-5 p-6">
        <Skeleton className="h-7 w-24" />
        <Skeleton className="h-9 w-2/3" />
        <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">Work item not found.</p>
        <Button asChild variant="ghost" className="mt-3 gap-1.5">
          <Link to="/board">
            <IconArrowLeft className="size-4" /> Back to board
          </Link>
        </Button>
      </div>
    );
  }

  const slot = activity.data?.slot;
  const queue = activity.data?.queue;
  const status = activity.data?.itemStatus ?? item.status;
  const remote = item.project?.gitRemote;
  const branch = item.project?.defaultBranch ?? "main";
  const ghHref = repoHref(remote);
  const ghLabel = repoLabel(remote);

  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 gap-1.5">
        <Link to={`/board?project=${encodeURIComponent(item.projectId)}`}>
          <IconArrowLeft className="size-4" /> Board
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {item.project?.key ? (
            <span className="font-mono text-xs font-medium text-muted-foreground">
              {item.project.key}
            </span>
          ) : null}
          <Badge
            variant="outline"
            className={cn("h-5 px-1.5 text-[11px] capitalize", typeChip(item.type))}
          >
            {item.type}
          </Badge>
          <StatusChip status={status} />
          {slot?.status === "queued" && queue ? (
            <span className="text-xs text-muted-foreground">
              queued · {queue.running}/{queue.brainConcurrency} slots busy
            </span>
          ) : null}
          {slot?.status === "running" ? (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 dark:text-blue-400">
              <IconLoader2 className="size-3.5 animate-spin" />
              running
            </span>
          ) : null}
        </div>

        <h1 className="text-2xl font-semibold leading-tight tracking-tight">
          {item.title}
        </h1>

        {/* Controls row */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={onDispatch}
            disabled={dispatch.isPending}
            className="gap-1.5"
            variant={dispatched ? "outline" : "default"}
          >
            {dispatch.isPending ? (
              <IconLoader2 className="size-4 animate-spin" />
            ) : (
              <IconRocket className="size-4" />
            )}
            {dispatch.isPending
              ? "Dispatching…"
              : dispatched
                ? "Re-dispatch"
                : "Dispatch to orchestrator"}
          </Button>

          <div className="flex items-center gap-2">
            <Label
              htmlFor="monitor-interval"
              className="whitespace-nowrap text-xs text-muted-foreground"
            >
              Monitor interval
            </Label>
            <div className="relative">
              <Input
                id="monitor-interval"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="120"
                value={monitorInterval}
                onChange={(e) => setMonitorInterval(e.target.value)}
                className="h-8 w-24 pr-9 text-sm"
                title="Periodic drift-check cadence. Blank = default 120s. 0 = event-only (no timer wakes)."
              />
              <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[11px] text-muted-foreground">
                sec
              </span>
            </div>
          </div>

          {dispatched && item.orchestratorThreadId ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="ml-auto h-8 gap-1.5 text-muted-foreground"
            >
              <a href={orchestratorBrainHref(item.orchestratorThreadId)}>
                <IconMessageCircle className="size-3.5" />
                Open brain thread
                <IconExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── Body: requirement + activity (left) · context (right) ── */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        {/* Left column */}
        <div className="order-2 min-w-0 space-y-6 lg:order-1">
          {/* Requirement */}
          <section>
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Requirement
            </h2>
            <div className="rounded-xl border border-border bg-card/40 p-4">
              {item.description ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                  {item.description}
                </p>
              ) : (
                <p className="text-sm italic text-muted-foreground">
                  No requirement text.
                </p>
              )}
            </div>
          </section>

          {/* Activity — the centerpiece */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Activity
              </h2>
              {dispatched ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      activity.isLoading
                        ? "bg-amber-500 animate-pulse"
                        : "bg-emerald-500",
                    )}
                  />
                  {activity.data?.thread?.status
                    ? `brain ${activity.data.thread.status}`
                    : "live"}
                </span>
              ) : null}
            </div>
            <ActivityFeed
              dispatched={dispatched}
              activity={activity.data}
              isLoading={activity.isLoading}
            />
          </section>
        </div>

        {/* Right column: context */}
        <aside className="order-1 lg:order-2">
          <div className="divide-y divide-border rounded-xl border border-border bg-card lg:sticky lg:top-4">
            <MetaRow icon={IconLayoutKanban} label="Project">
              <Link
                to={`/board?project=${encodeURIComponent(item.projectId)}`}
                className="truncate font-medium text-foreground hover:underline"
              >
                {item.project?.name ?? item.projectId}
              </Link>
            </MetaRow>

            <MetaRow icon={IconBrandGithub} label="Repo">
              {ghHref ? (
                <a
                  href={ghHref}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 break-all font-mono text-xs hover:text-foreground hover:underline"
                  title={remote ?? undefined}
                >
                  {ghLabel}
                  <IconExternalLink className="size-3 shrink-0 opacity-60" />
                </a>
              ) : (
                <span className="break-all font-mono text-xs text-muted-foreground">
                  {ghLabel ?? "no repo configured"}
                </span>
              )}
            </MetaRow>

            <MetaRow icon={IconGitBranch} label="Branch">
              <span className="font-mono text-xs text-foreground/80">
                {branch}
              </span>
            </MetaRow>

            {item.orchestratorThreadId ? (
              <MetaRow icon={IconMessageCircle} label="Brain">
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <a
                        href={orchestratorBrainHref(item.orchestratorThreadId)}
                        className="flex items-center gap-1 font-mono text-xs text-foreground/80 hover:text-foreground hover:underline"
                      >
                        {item.orchestratorThreadId.slice(0, 16)}…
                        <IconExternalLink className="size-3 shrink-0 opacity-60" />
                      </a>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      <span className="font-mono text-xs">
                        {item.orchestratorThreadId}
                      </span>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </MetaRow>
            ) : null}

            <MetaRow icon={IconClock} label="Created">
              <span className="text-xs text-muted-foreground">
                {fmtDateTime(item.createdAt)}
              </span>
            </MetaRow>
          </div>
        </aside>
      </div>
    </div>
  );
}
