import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useWorkItems, useSprints, useValidateDependencyGraph } from "@/hooks/use-tracker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  IconSearch,
  IconPlus,
  IconAffiliate,
  IconAlertTriangle,
  IconCircleCheck,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
  statusPresentation,
  typeChip,
} from "@/components/tracker-format";
import type { TrackerWorkItem, Sprint, GraphValidationIssue } from "@shared/types";

// ── Stage constants ──────────────────────────────────────────────────────────

const STAGE_ORDER = [
  "待办", "分析", "设计", "实施", "测试", "验收", "交付",
] as const;
type StageName = (typeof STAGE_ORDER)[number];

const STAGE_DOT_COLORS: Record<StageName, string> = {
  "待办": "bg-zinc-400",
  "分析": "bg-blue-500",
  "设计": "bg-violet-500",
  "实施": "bg-indigo-500",
  "测试": "bg-amber-500",
  "验收": "bg-emerald-500",
  "交付": "bg-cyan-500",
};

// ── Priority helpers ─────────────────────────────────────────────────────────

const PRIORITY_LABELS: Record<number, string> = {
  1: "P0",
  2: "P1",
  3: "P2",
  4: "P3",
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
  2: "bg-orange-500/10 text-orange-600 border-orange-500/30 dark:text-orange-400",
  3: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400",
  4: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30 dark:text-zinc-400",
};

function PriorityChip({ priority }: { priority: number }) {
  const label = PRIORITY_LABELS[priority] ?? `P${priority}`;
  const color =
    PRIORITY_COLORS[priority] ?? PRIORITY_COLORS[4];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold",
        color,
      )}
    >
      {label}
    </span>
  );
}

// ── Risk helpers ─────────────────────────────────────────────────────────────

const RISK_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const RISK_COLORS: Record<string, string> = {
  low: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  medium: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
  high: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
};

function RiskChip({ risk }: { risk: string }) {
  const label = RISK_LABELS[risk] ?? risk;
  const color = RISK_COLORS[risk] ?? RISK_COLORS.low;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium",
        color,
      )}
    >
      {label}
    </span>
  );
}

// ── Status chip (card footer) ────────────────────────────────────────────────

function StatusChip({ status }: { status: string }) {
  const pres = statusPresentation(status);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
        pres.chip,
      )}
    >
      <span
        className={cn(
          "size-1 rounded-full",
          pres.dot,
          pres.live && "animate-pulse",
        )}
      />
      {pres.label}
    </span>
  );
}

// ── Execution indicator ──────────────────────────────────────────────────────

function ExecutionBadge({ status }: { status: string }) {
  if (status === "running" || status === "dispatched") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600 dark:text-blue-400">
        <span className="size-1.5 animate-pulse rounded-full bg-blue-500" />
        执行中
      </span>
    );
  }
  if (status === "queued") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" />
        排队中
      </span>
    );
  }
  return null;
}

// ── Work item card ───────────────────────────────────────────────────────────

function WorkItemCard({ item }: { item: TrackerWorkItem }) {
  const isFailed = item.status === "failed";
  const isRunning = item.status === "running" || item.status === "dispatched";

  return (
    <Link to={`/items/${item.id}`} className="block">
      <div
        className={cn(
          "group rounded-lg border bg-card p-3 shadow-sm transition-all hover:border-foreground/20 hover:shadow",
          isFailed
            ? "border-red-300 dark:border-red-700"
            : isRunning
              ? "border-blue-300/60 dark:border-blue-700/60"
              : "border-border",
        )}
        data-testid={`work-item-${item.id}`}
        data-status={item.status}
      >
        {/* Top row: type badge + priority chip + itemKey (right) */}
        <div className="mb-1.5 flex items-center gap-1.5">
          <Badge
            variant="outline"
            className={cn(
              "h-4 px-1 text-[10px] capitalize",
              typeChip(item.type),
            )}
          >
            {item.type}
          </Badge>
          <PriorityChip priority={item.priority} />
          {item.risk ? <RiskChip risk={item.risk} /> : null}
          <span className="ml-auto font-mono text-[10px] font-medium text-muted-foreground">
            {item.itemKey}
          </span>
        </div>

        {/* Title (bold) */}
        <p className="mb-1.5 line-clamp-2 text-sm font-bold leading-snug text-foreground group-hover:text-foreground">
          {item.title}
        </p>

        {/* Middle: tags */}
        {item.tags && item.tags.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {item.tags.map((tag) => (
              <span
                key={tag}
                className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        {/* Bottom: current stage + execution badge + status chip */}
        <div className="flex items-center gap-1.5 border-t border-border/60 pt-2">
          <span className="text-[10px] text-muted-foreground">
            当前: {item.currentStageName}
          </span>
          <ExecutionBadge status={item.status} />
          <span className="ml-auto">
            <StatusChip status={item.status} />
          </span>
        </div>

        {/* Failed: red bottom strip with error text */}
        {isFailed && item.description ? (
          <div className="mt-2 rounded bg-red-500/10 px-2 py-1 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
            {item.description}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

// ── Dependency-graph validation dialog (M1-5) ───────────────────────────────

const ISSUE_LABELS: Record<GraphValidationIssue["code"], string> = {
  "self-dependency": "自依赖",
  cycle: "依赖环",
  "chain-too-deep": "链过深",
  "no-parallelism": "无并行度",
  orphan: "孤儿节点",
};

function IssueRow({
  issue,
  tone,
}: {
  issue: GraphValidationIssue;
  tone: "error" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "error"
          ? "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
      )}
    >
      <span className="mr-1.5 font-semibold">
        [{ISSUE_LABELS[issue.code] ?? issue.code}]
      </span>
      {issue.message}
    </div>
  );
}

function GraphValidationDialog({
  open,
  onOpenChange,
  scope,
  scopeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: "epic" | "sprint" | undefined;
  scopeId: string | undefined;
}) {
  const { data, isLoading } = useValidateDependencyGraph(scope, scopeId, open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>图校验结果</DialogTitle>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh] pr-3">
          {isLoading ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              校验中…
            </p>
          ) : !data ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              暂无数据
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {data.errors.length === 0 && data.warnings.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                  <IconCircleCheck className="size-4 shrink-0" />
                  未发现问题
                </div>
              ) : null}

              {data.errors.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground">
                    错误 ({data.errors.length})
                  </h4>
                  {data.errors.map((issue, i) => (
                    <IssueRow key={`err-${i}`} issue={issue} tone="error" />
                  ))}
                </div>
              ) : null}

              {data.warnings.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  <h4 className="text-xs font-semibold text-muted-foreground">
                    警告 ({data.warnings.length})
                  </h4>
                  {data.warnings.map((issue, i) => (
                    <IssueRow key={`warn-${i}`} issue={issue} tone="warning" />
                  ))}
                </div>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <h4 className="text-xs font-semibold text-muted-foreground">
                  拓扑排序{data.topoOrder.length === 0 ? "(存在环,无法排序)" : ""}
                </h4>
                {data.topoOrder.length > 0 ? (
                  <ol className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
                    {data.topoOrder.map((key, i) => (
                      <li key={key} className="flex items-center gap-2">
                        <span className="font-mono text-muted-foreground">
                          {i + 1}.
                        </span>
                        {key}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </div>
            </div>
          )}
        </ScrollArea>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Board page ───────────────────────────────────────────────────────────────

export function BoardPage() {
  const [params] = useSearchParams();
  const projectId = params.get("project") ?? undefined;

  const { data: itemsRaw, isLoading } = useWorkItems(projectId);
  const items = (itemsRaw ?? []) as TrackerWorkItem[];

  const { data: sprintsRaw } = useSprints();
  const sprints = (sprintsRaw ?? []) as Sprint[];

  // Current (in-progress) sprint — shown as badge in header
  const currentSprint = sprints.find((s) => s.status === "进行中");

  // Filter state
  const [selectedSprintId, setSelectedSprintId] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [search, setSearch] = useState("");

  // 图校验 dialog (M1-5): scope is sprint when one is selected, else falls
  // back to the epic (project) from the URL. Disabled when neither resolves.
  const [graphDialogOpen, setGraphDialogOpen] = useState(false);
  const graphScope: "epic" | "sprint" | undefined =
    selectedSprintId !== "all" ? "sprint" : projectId ? "epic" : undefined;
  const graphScopeId =
    selectedSprintId !== "all" ? selectedSprintId : projectId;

  // Derive unique filter values from items
  const uniqueTypes = useMemo(() => {
    const set = new Set(items.map((it) => it.type));
    return Array.from(set).sort();
  }, [items]);

  const uniquePriorities = useMemo(() => {
    const set = new Set(items.map((it) => it.priority));
    return Array.from(set).sort((a, b) => a - b);
  }, [items]);

  const uniqueRisks = useMemo(() => {
    const set = new Set(items.map((it) => it.risk));
    return Array.from(set).sort();
  }, [items]);

  // Apply all filters
  const filteredItems = useMemo(() => {
    return items.filter((it) => {
      if (selectedSprintId !== "all" && it.sprintId !== selectedSprintId) return false;
      if (typeFilter !== "all" && it.type !== typeFilter) return false;
      if (priorityFilter !== "all" && it.priority !== Number(priorityFilter))
        return false;
      if (riskFilter !== "all" && it.risk !== riskFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !it.title.toLowerCase().includes(q) &&
          !(it.itemKey ?? "").toLowerCase().includes(q) &&
          !(it.description ?? "").toLowerCase().includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [items, selectedSprintId, typeFilter, priorityFilter, riskFilter, search]);

  // Group by currentStageName
  const grouped = useMemo(() => {
    const map: Record<string, TrackerWorkItem[]> = {};
    for (const stage of STAGE_ORDER) {
      map[stage] = [];
    }
    for (const it of filteredItems) {
      const stage = it.currentStageName as StageName;
      if (STAGE_ORDER.includes(stage)) {
        map[stage].push(it);
      } else {
        // Unknown stage falls into 待办
        map["待办"].push(it);
      }
    }
    return map;
  }, [filteredItems]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* ── Header ── */}
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold tracking-tight">看板</h1>
          {currentSprint ? (
            <Badge
              variant="secondary"
              className="h-6 cursor-default px-2.5 text-xs font-medium"
            >
              {currentSprint.name}
            </Badge>
          ) : (
            <Badge
              variant="secondary"
              className="h-6 px-2.5 text-xs font-medium text-muted-foreground"
            >
              全部 Sprint
            </Badge>
          )}
        </div>
        <Button asChild size="sm" className="gap-1.5">
          <Link to="/items/new">
            <IconPlus className="size-4" />
            新建工作项
          </Link>
        </Button>
      </header>

      {/* ── Filter bar ── */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-6 py-2">
        <Select value={selectedSprintId} onValueChange={setSelectedSprintId}>
          <SelectTrigger className="h-8 w-[160px] text-xs">
            <SelectValue placeholder="全部 Sprint" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部 Sprint</SelectItem>
            {sprints.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部类型" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部类型</SelectItem>
            {uniqueTypes.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={priorityFilter} onValueChange={setPriorityFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部优先级" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部优先级</SelectItem>
            {uniquePriorities.map((p) => (
              <SelectItem key={p} value={String(p)}>
                {PRIORITY_LABELS[p] ?? `P${p}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={riskFilter} onValueChange={setRiskFilter}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue placeholder="全部风险" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部风险</SelectItem>
            <SelectItem value="low">低</SelectItem>
            <SelectItem value="medium">中</SelectItem>
            <SelectItem value="high">高</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          disabled={!graphScopeId}
          onClick={() => setGraphDialogOpen(true)}
        >
          <IconAffiliate className="size-3.5" />
          图校验
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          <IconSearch className="size-3.5 text-muted-foreground" />
          <Input
            placeholder="搜索标题/编号…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 w-[200px] text-xs"
          />
        </div>
      </div>

      <GraphValidationDialog
        open={graphDialogOpen}
        onOpenChange={setGraphDialogOpen}
        scope={graphScope}
        scopeId={graphScopeId}
      />

      {/* ── Board columns ── */}
      <div className="flex flex-1 gap-4 overflow-hidden p-4">
        {STAGE_ORDER.map((stage) => {
          const colItems = grouped[stage] ?? [];
          return (
            <div
              key={stage}
              className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-muted/20"
            >
              {/* Column header: colored dot + stage name + count */}
              <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    STAGE_DOT_COLORS[stage],
                  )}
                />
                <h3 className="text-sm font-semibold">{stage}</h3>
                <Badge
                  variant="secondary"
                  className="h-5 min-w-5 justify-center px-1.5 font-mono text-[11px]"
                >
                  {colItems.length}
                </Badge>
              </div>

              {/* Cards — internally scrollable */}
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <div
                      key={i}
                      className="h-24 animate-pulse rounded-lg bg-muted/40"
                    />
                  ))
                ) : colItems.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground/60">
                    暂无内容
                  </p>
                ) : (
                  colItems.map((it) => (
                    <WorkItemCard key={it.id} item={it} />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
