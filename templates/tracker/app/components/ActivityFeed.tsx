import type {
  ActivityResponse,
  BrainEvent,
  OrchestratorRun,
  OrchestratorRunNode,
} from "@shared/types";
import {
  IconAlertTriangle,
  IconChevronRight,
  IconCircleCheck,
  IconCircleX,
  IconExternalLink,
  IconGitPullRequest,
  IconHierarchy3,
  IconLoader2,
  IconMessageCircle,
  IconRobot,
  IconTool,
  IconUser,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import {
  classifyEvent,
  fmtTime,
  nodeStatusPresentation,
  type EventKind,
} from "@/components/tracker-format";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// ── Run / DAG node chips ─────────────────────────────────────────────────────

function nodeIcon(status: string) {
  switch (status) {
    case "done":
      return <IconCircleCheck className="size-3.5 text-emerald-500" />;
    case "running":
      return <IconLoader2 className="size-3.5 animate-spin text-blue-500" />;
    case "failed":
    case "cancelled":
      return <IconCircleX className="size-3.5 text-red-500" />;
    default:
      return null;
  }
}

function RunCard({ run }: { run: OrchestratorRun }) {
  const nodes = run.nodes ?? [];
  const runStatus = nodeStatusPresentation(run.status);
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2.5 flex items-center gap-2">
        <IconHierarchy3 className="size-3.5 text-muted-foreground" />
        <span className="truncate font-mono text-xs text-muted-foreground">
          {run.id}
        </span>
        <Badge
          variant="outline"
          className={cn("ml-auto h-5 gap-1 px-1.5 text-[10px]", runStatus.chip)}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              runStatus.dot,
              runStatus.live && "animate-pulse",
            )}
          />
          {run.status}
        </Badge>
      </div>
      {nodes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {nodes.map((node: OrchestratorRunNode, i) => {
            const pres = nodeStatusPresentation(node.status);
            return (
              <div key={node.nodeIdInDag} className="flex items-center gap-1.5">
                {i > 0 ? (
                  <IconChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
                ) : null}
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
                    pres.chip,
                  )}
                  title={node.error ?? node.status}
                >
                  {nodeIcon(node.status) ?? (
                    <span className={cn("size-1.5 rounded-full", pres.dot)} />
                  )}
                  {node.nodeIdInDag}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          DAG authored — waiting for node status.
        </p>
      )}
    </div>
  );
}

// ── Transcript timeline ──────────────────────────────────────────────────────

interface EventStyle {
  icon: typeof IconRobot;
  dot: string;
  label: string;
}

function eventStyle(kind: EventKind, ev: BrainEvent): EventStyle {
  switch (kind) {
    case "assistant":
      return { icon: IconRobot, dot: "bg-blue-500", label: "Assistant" };
    case "tool":
      return {
        icon: IconTool,
        dot: "bg-violet-500",
        label: ev.toolName ?? "Tool call",
      };
    case "result":
      return {
        icon: IconCircleCheck,
        dot: "bg-emerald-500",
        label: "Tool result",
      };
    case "user":
      return { icon: IconUser, dot: "bg-sky-500", label: "User" };
    default:
      return { icon: IconMessageCircle, dot: "bg-zinc-500", label: ev.type };
  }
}

function clamp(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function TranscriptEvent({ ev, isLast }: { ev: BrainEvent; isLast: boolean }) {
  const kind = classifyEvent(ev.type, ev.toolName);
  const style = eventStyle(kind, ev);
  const Icon = style.icon;
  const isToolCard = kind === "tool" || kind === "result";
  const timeLabel = fmtTime(ev.createdAt);

  // Drop body text that just repeats the label / tool name / event type — the
  // brain transcript sometimes sets `text` to the tool name itself, which would
  // render redundantly under the header.
  const rawText = ev.text?.trim() ?? "";
  const redundant = new Set(
    [style.label, ev.toolName, ev.type]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase()),
  );
  const text = redundant.has(rawText.toLowerCase()) ? "" : rawText;

  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {/* Rail + dot */}
      <div className="flex flex-col items-center">
        <span
          className={cn(
            "z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-background",
            style.dot,
          )}
        >
          <Icon className="size-3.5 text-white" />
        </span>
        {!isLast ? <span className="w-px flex-1 bg-border" /> : null}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {style.label}
          </span>
          {ev.toolName && kind === "tool" ? (
            <Badge
              variant="secondary"
              className="h-4 px-1 font-mono text-[10px]"
            >
              MCP
            </Badge>
          ) : null}
          {timeLabel ? (
            <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {timeLabel}
            </span>
          ) : null}
        </div>

        {text ? (
          isToolCard ? (
            // Collapsible card for tool calls / results — keeps the timeline
            // scannable while the full payload is one click away.
            <Collapsible className="mt-1.5">
              <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted">
                <IconChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
                <span className="truncate font-mono">
                  {ev.toolName ?? ev.type}
                </span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                  {text.length > 80 ? `${text.length} chars` : "view"}
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/80">
                  {clamp(text)}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
              {clamp(text, 1500)}
            </p>
          )
        ) : null}
      </div>
    </li>
  );
}

// ── ActivityFeed ─────────────────────────────────────────────────────────────

export interface ActivityFeedProps {
  dispatched: boolean;
  activity: ActivityResponse | undefined;
  isLoading: boolean;
}

export function ActivityFeed({
  dispatched,
  activity,
  isLoading,
}: ActivityFeedProps) {
  const events = activity?.events ?? [];
  const runs = activity?.runs ?? [];
  const delivery = activity?.delivery;
  const errors = activity?.errors;

  // Most recent transcript events first-to-last; cap to keep the DOM light.
  const visibleEvents = useMemo(() => events.slice(-60), [events]);

  if (!dispatched) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-12 text-center">
        <div className="rounded-full bg-muted/60 p-3">
          <IconRobot className="size-6 text-muted-foreground" />
        </div>
        <p className="text-sm font-medium text-foreground">
          Not dispatched yet
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          Dispatch this requirement to the orchestrator's Claude Code brain. It
          provisions a workspace, authors a run, works the task, and opens a PR.
          Live progress streams here.
        </p>
      </div>
    );
  }

  const hasContent =
    runs.length > 0 || visibleEvents.length > 0 || !!delivery?.prUrl;

  return (
    <div className="space-y-4">
      {/* Source errors (soft) */}
      {errors ? (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-700 dark:text-amber-400">
          <IconAlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            {Object.entries(errors).map(([k, v]) => (
              <div key={k} className="break-words">
                <span className="font-medium capitalize">{k}:</span> {v}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Delivery banner — the PR / branch the brain shipped */}
      {delivery?.prUrl ? (
        <a
          href={delivery.prUrl}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 transition-colors hover:bg-emerald-500/20"
        >
          <div className="rounded-lg bg-emerald-500/20 p-2">
            <IconGitPullRequest className="size-5 text-emerald-600 dark:text-emerald-400" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300">
              {delivery.prNumber
                ? `Pull request #${delivery.prNumber} opened`
                : "Pull request opened"}
            </p>
            {delivery.branch ? (
              <p className="truncate font-mono text-xs text-emerald-700/80 dark:text-emerald-400/80">
                {delivery.branch}
              </p>
            ) : null}
          </div>
          <IconExternalLink className="size-4 shrink-0 text-emerald-600/70 dark:text-emerald-400/70" />
        </a>
      ) : null}

      {/* Runs / DAG node progress */}
      {runs.length > 0 ? (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <IconHierarchy3 className="size-3.5" />
            Run{runs.length > 1 ? "s" : ""}
          </h3>
          <div className="space-y-2">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Brain transcript */}
      <section className="space-y-2.5">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <IconMessageCircle className="size-3.5" />
          Brain transcript
        </h3>

        {visibleEvents.length === 0 && isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <div className="flex-1 space-y-1.5 pt-0.5">
                  <Skeleton className="h-3.5 w-32" />
                  <Skeleton className="h-3 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleEvents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {hasContent
              ? "No transcript events yet."
              : "Brain thread started. Waiting for the first transcript events…"}
          </div>
        ) : (
          <ol className="relative">
            {visibleEvents.map((ev, i) => (
              <TranscriptEvent
                key={ev.id ?? ev.seq ?? i}
                ev={ev}
                isLast={i === visibleEvents.length - 1}
              />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
