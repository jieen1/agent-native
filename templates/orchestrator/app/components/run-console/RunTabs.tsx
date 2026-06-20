import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconDownload,
  IconExternalLink,
  IconFile,
  IconGitPullRequest,
} from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { XtermPanel } from "./XtermPanel";
import type {
  NodeRunDetail,
  RunDeliverable,
  RunEvent,
  RunGraph,
  RunGraphNode,
  RunSummary,
} from "@/hooks/use-runs";
import { nodeStatusDot } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

// Bottom tabs (FRONTEND §4(c)). Five tabs, each wired to the right action:
//   Overview    → run-get (status counts + remaining budget + elapsed)
//   Steps       → run-graph (the NodeRun timeline; click a row selects the node)
//   Terminal    → node-get logs in an xterm panel (the focused node)
//   Deliverable → run-get.deliverable (PR card / file list, downloadable)
//   Events      → run-events (raw ordered log, filterable by node)

export interface RunTabsProps {
  summary?: RunSummary;
  graph?: RunGraph;
  events: RunEvent[];
  selectedNode?: NodeRunDetail;
  selectedNodeRunId: string | null;
  onSelectNodeRun: (nodeRunId: string) => void;
}

const STATUS_ORDER = [
  "running",
  "ready",
  "pending",
  "awaiting-approval",
  "done",
  "failed",
  "skipped",
];

export function RunTabs({
  summary,
  graph,
  events,
  selectedNode,
  selectedNodeRunId,
  onSelectNodeRun,
}: RunTabsProps) {
  const { t } = useTranslation();

  return (
    <Tabs defaultValue="overview" className="flex h-full min-h-0 flex-col">
      <TabsList className="w-fit">
        <TabsTrigger value="overview">{t("runs.overview")}</TabsTrigger>
        <TabsTrigger value="steps">{t("runs.steps")}</TabsTrigger>
        <TabsTrigger value="terminal">{t("runs.terminal")}</TabsTrigger>
        <TabsTrigger value="deliverable">{t("runs.deliverable")}</TabsTrigger>
        <TabsTrigger value="events">{t("runs.events")}</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="min-h-0 flex-1">
        <OverviewTab summary={summary} />
      </TabsContent>
      <TabsContent value="steps" className="min-h-0 flex-1">
        <StepsTab
          nodeRuns={graph?.nodeRuns ?? []}
          selectedNodeRunId={selectedNodeRunId}
          onSelect={onSelectNodeRun}
        />
      </TabsContent>
      <TabsContent value="terminal" className="min-h-0 flex-1">
        <XtermPanel
          nodeRunId={selectedNodeRunId}
          logs={selectedNode?.logs ?? []}
        />
      </TabsContent>
      <TabsContent value="deliverable" className="min-h-0 flex-1">
        <DeliverableTab deliverable={summary?.deliverable ?? null} />
      </TabsContent>
      <TabsContent value="events" className="min-h-0 flex-1">
        <EventsTab
          events={events}
          nodeRuns={graph?.nodeRuns ?? []}
          onSelect={onSelectNodeRun}
        />
      </TabsContent>
    </Tabs>
  );
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ summary }: { summary?: RunSummary }) {
  const { t } = useTranslation();
  if (!summary) {
    return (
      <p className="p-4 text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }
  const total = summary.nodeRunCount || 0;
  const done = summary.counts.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const budgetPct =
    summary.tokenBudget && summary.tokenBudget > 0
      ? Math.min(
          100,
          Math.round((summary.tokensSpent / summary.tokenBudget) * 100),
        )
      : null;

  return (
    <ScrollArea className="h-full">
      <div className="grid gap-4 p-4">
        {/* status counts */}
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter((s) => (summary.counts[s] ?? 0) > 0).map((s) => (
            <span
              key={s}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs"
            >
              <span className={cn("size-2 rounded-full", nodeStatusDot(s))} />
              <span className="font-medium">{summary.counts[s]}</span>
              <RunStatusBadge
                status={s as RunGraphNode["status"]}
                className="!bg-transparent !px-0 !ring-0"
              />
            </span>
          ))}
        </div>

        {/* node progress */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("runs.nodeProgress")}</span>
            <span className="font-mono">
              {done}/{total}
            </span>
          </div>
          <Progress value={pct} />
        </div>

        {/* budget */}
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("runs.budget")}</span>
            <span className="font-mono">
              {summary.tokensSpent}
              {summary.tokenBudget != null ? ` / ${summary.tokenBudget}` : ""}
            </span>
          </div>
          {budgetPct != null ? (
            <Progress value={budgetPct} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("runs.noBudget")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("runs.budgetRemaining")}:{" "}
            <span className="font-mono">
              {summary.budgetRemaining == null ? "∞" : summary.budgetRemaining}
            </span>
          </p>
        </div>
      </div>
    </ScrollArea>
  );
}

// ── Steps timeline ──────────────────────────────────────────────────────────

const ROW_TINT: Record<string, string> = {
  pending: "border-border",
  ready: "border-amber-500/40",
  running: "border-blue-500/50 bg-blue-500/5",
  done: "border-emerald-500/40",
  failed: "border-red-500/50 bg-red-500/5",
  skipped: "border-dashed border-border opacity-60",
  "awaiting-approval": "border-orange-500/50 bg-orange-500/5",
};

function StepsTab({
  nodeRuns,
  selectedNodeRunId,
  onSelect,
}: {
  nodeRuns: RunGraphNode[];
  selectedNodeRunId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  // Order by start time (started first), then by node key for determinism.
  const ordered = useMemo(() => {
    return [...nodeRuns].sort((a, b) => {
      const at = a.startedAt ?? "";
      const bt = b.startedAt ?? "";
      if (at !== bt) return at < bt ? -1 : 1;
      return a.nodeId < b.nodeId ? -1 : 1;
    });
  }, [nodeRuns]);

  if (ordered.length === 0) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
        {t("runs.notStarted")}
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <ul className="grid gap-1.5 p-1">
        {ordered.map((nr) => (
          <li key={nr.id}>
            <button
              type="button"
              onClick={() => onSelect(nr.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:bg-accent/40",
                ROW_TINT[nr.status] ?? "border-border",
                nr.id === selectedNodeRunId && "ring-2 ring-ring",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {nr.title || nr.nodeId}
                  </span>
                  {nr.dynamic ? (
                    <span className="rounded bg-blue-500/15 px-1 text-[10px] text-blue-600 dark:text-blue-400">
                      {t("runs.dynamic")}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
                  <span>{nr.nodeId}</span>
                  <span>· {nr.type}</span>
                  {nr.iteration > 0 ? (
                    <span>
                      · {t("runs.iteration")} {nr.iteration}
                    </span>
                  ) : null}
                  {nr.fanoutIndex > 0 ? (
                    <span>
                      · {t("runs.fanoutIndex")} {nr.fanoutIndex}
                    </span>
                  ) : null}
                </span>
              </span>
              <RunStatusBadge status={nr.status} />
            </button>
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

// ── Deliverable ─────────────────────────────────────────────────────────────

function DeliverableTab({
  deliverable,
}: {
  deliverable: RunDeliverable | null;
}) {
  const { t } = useTranslation();
  if (!deliverable) {
    return (
      <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        {t("runs.noDeliverable")}
      </div>
    );
  }

  const url =
    typeof deliverable.url === "string"
      ? deliverable.url
      : typeof (deliverable.ref as { url?: unknown })?.url === "string"
        ? (deliverable.ref as { url: string }).url
        : null;
  const title =
    deliverable.title ??
    (typeof (deliverable.ref as { title?: unknown })?.title === "string"
      ? (deliverable.ref as { title: string }).title
      : deliverable.kind);
  const files = Array.isArray(deliverable.files) ? deliverable.files : [];

  const isPr = deliverable.kind === "pr" || deliverable.kind === "pull-request";

  return (
    <ScrollArea className="h-full">
      <div className="grid gap-3 p-4">
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4">
          <div className="flex items-center gap-2">
            {isPr ? (
              <IconGitPullRequest className="size-4 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <IconFile className="size-4 text-emerald-600 dark:text-emerald-400" />
            )}
            <span className="truncate font-medium text-emerald-700 dark:text-emerald-300">
              {title}
            </span>
          </div>
          {deliverable.branch ? (
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              {deliverable.branch}
            </p>
          ) : null}
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300"
            >
              <IconExternalLink className="size-3.5" />
              {t("runs.openDeliverable")}
            </a>
          ) : null}
        </div>

        {files.length > 0 ? (
          <ul className="grid gap-1">
            {files.map((f, i) => (
              <li
                key={`${f.path}-${i}`}
                className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs"
              >
                <IconFile className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono">
                  {f.path}
                </span>
                {f.url ? (
                  <a
                    href={f.url}
                    download
                    className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                  >
                    <IconDownload className="size-3.5" />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </ScrollArea>
  );
}

// ── Events ──────────────────────────────────────────────────────────────────

function EventsTab({
  events,
  nodeRuns,
  onSelect,
}: {
  events: RunEvent[];
  nodeRuns: RunGraphNode[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<string>("all");

  const nodeIds = useMemo(() => {
    const set = new Set<string>();
    for (const nr of nodeRuns) set.add(nr.nodeId);
    return [...set].sort();
  }, [nodeRuns]);

  const filtered = useMemo(
    () =>
      filter === "all" ? events : events.filter((e) => e.nodeId === filter),
    [events, filter],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {t("runs.filterByNode")}
        </span>
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("common.all")}</SelectItem>
            {nodeIds.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {filtered.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground">
          {t("runs.noEvents")}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {filtered.map((e) => (
              <li key={e.seq}>
                <button
                  type="button"
                  onClick={() => onSelect(e.nodeRunId)}
                  className="flex w-full items-center gap-3 px-3 py-1.5 text-left font-mono text-[11px] hover:bg-accent/40"
                >
                  <span className="w-10 shrink-0 text-muted-foreground">
                    #{e.seq}
                  </span>
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      nodeStatusDot(e.status),
                    )}
                  />
                  <span className="w-24 shrink-0 truncate">{e.type}</span>
                  <span className="min-w-0 flex-1 truncate">{e.nodeId}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {new Date(e.at).toLocaleTimeString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
