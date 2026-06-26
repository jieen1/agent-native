import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconBolt,
  IconChevronDown,
  IconChevronRight,
  IconTerminal2,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `${APP_TITLE} — 一次性任务` }];
}

const SPAWN_STATUSES = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtLatency(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(input: number, output: number): string {
  const total = input + output;
  if (total === 0) return "—";
  return `${total.toLocaleString()} (${input.toLocaleString()}/${output.toLocaleString()})`;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-muted text-muted-foreground",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-destructive/10 text-destructive",
  cancelled:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

interface SpawnItem {
  id: string;
  runId: string | null;
  nodeId: string | null;
  agentName: string | null;
  status: string;
  outputKind: string | null;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number | null;
  startedAt: string | null;
  renderedPrompt: string;
  error: string | null;
}

interface SpawnDetail extends SpawnItem {
  modelRef: string | null;
  engineRef: string | null;
  runtime: string | null;
  workspaceId: string | null;
  output?: string | null;
  log?: string | null;
}

export default function V3SpawnsRoute() {
  const { t } = useTranslation();

  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const {
    data: spawns = [],
    isLoading,
    error,
  } = useActionQuery(
    "spawnList" as any,
    {
      scope: scopeFilter === "all" ? undefined : scopeFilter,
      status: statusFilter === "all" ? undefined : statusFilter,
      agentName: agentFilter === "all" ? undefined : agentFilter,
    },
    undefined,
  );

  const spawnGetAction = useActionMutation("spawnGet" as any, {});
  const [detailCache, setDetailCache] = useState<Record<string, SpawnDetail>>(
    {},
  );

  // Distinct agent names for the filter dropdown
  const agentNames = useMemo(() => {
    const set = new Set<string>();
    for (const s of spawns) {
      if (s.agentName) set.add(s.agentName);
    }
    return Array.from(set).sort();
  }, [spawns]);

  const fetchDetail = useCallback(
    (spawnId: string) => {
      if (detailCache[spawnId]) return;
      spawnGetAction.mutate(
        { spawnId },
        {
          onSuccess: (data) => {
            setDetailCache((prev) => ({ ...prev, [spawnId]: data }));
          },
        },
      );
    },
    [detailCache, spawnGetAction],
  );

  const toggleExpand = useCallback(
    (spawnId: string) => {
      if (expandedId === spawnId) {
        setExpandedId(null);
      } else {
        fetchDetail(spawnId);
        setExpandedId(spawnId);
      }
    },
    [expandedId, fetchDetail],
  );

  const isFiltered =
    scopeFilter !== "all" || statusFilter !== "all" || agentFilter !== "all";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            一次性任务
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            各次运行中的单个 Agent 调用。
          </p>
        </div>
        {spawns.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="h-8 w-[140px]">
                <SelectValue placeholder="范围" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部一次性任务</SelectItem>
                <SelectItem value="run-scoped">运行内</SelectItem>
                <SelectItem value="ad-hoc">临时</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[130px]">
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有状态</SelectItem>
                {SPAWN_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`v3.spawn.status.${s}`, { defaultValue: s })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="h-8 w-[160px]">
                <SelectValue placeholder="Agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">所有 Agent</SelectItem>
                {agentNames.map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          加载一次性任务失败。
        </div>
      ) : (
        <div className="space-y-1">
          {isLoading ? (
            Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow key={`sk-${i}`} />
            ))
          ) : spawns.length === 0 ? (
            <EmptyState
              icon={IconBolt}
              title={
                isFiltered ? "没有符合筛选条件的一次性任务" : "暂无一次性任务"
              }
              description={
                isFiltered
                  ? "请尝试调整范围、状态或 Agent 筛选条件。"
                  : "当节点派发 Agent 工作时会创建一次性任务。"
              }
              className="border-0"
              action={
                isFiltered ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setScopeFilter("all");
                      setStatusFilter("all");
                      setAgentFilter("all");
                    }}
                  >
                    清除筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            spawns.map((spawn: SpawnItem) => (
              <SpawnRow
                key={spawn.id}
                spawn={spawn}
                isExpanded={expandedId === spawn.id}
                detail={detailCache[spawn.id]}
                onToggle={() => toggleExpand(spawn.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border p-3">
      <div className="h-4 w-24 rounded bg-muted" />
      <div className="h-4 w-20 rounded bg-muted" />
      <div className="h-4 w-28 rounded bg-muted" />
      <div className="h-5 w-16 rounded bg-muted" />
      <div className="ml-auto h-4 w-20 rounded bg-muted" />
    </div>
  );
}

function SpawnRow({
  spawn,
  isExpanded,
  detail,
  onToggle,
}: {
  spawn: SpawnItem;
  isExpanded: boolean;
  detail: SpawnDetail | undefined;
  onToggle: () => void;
}) {
  return (
    <Collapsible open={isExpanded} onOpenChange={() => onToggle()}>
      <div
        className={cn(
          "rounded-lg border border-border transition-colors",
          isExpanded && "border-primary/30 bg-muted/30",
        )}
      >
        {/* Summary row */}
        <div
          className="flex cursor-pointer items-center gap-4 px-4 py-3"
          onClick={onToggle}
        >
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground"
            >
              {isExpanded ? (
                <IconChevronDown className="size-4" />
              ) : (
                <IconChevronRight className="size-4" />
              )}
            </button>
          </CollapsibleTrigger>

          <span className="font-mono text-xs font-medium shrink-0">
            {spawn.id.slice(0, 14)}
          </span>

          <Badge
            variant="secondary"
            className={cn("shrink-0", STATUS_COLORS[spawn.status] ?? "")}
          >
            {spawn.status}
          </Badge>

          {spawn.agentName ? (
            <span className="truncate text-xs font-medium">
              {spawn.agentName}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}

          {spawn.runId ? (
            <span className="hidden font-mono text-xs text-muted-foreground md:inline">
              {spawn.runId.slice(0, 12)}
            </span>
          ) : (
            <span className="hidden text-xs text-muted-foreground md:inline">
              临时
            </span>
          )}

          {spawn.outputKind ? (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {spawn.outputKind}
            </span>
          ) : null}

          <span className="ml-auto whitespace-nowrap font-mono text-xs text-muted-foreground">
            {fmtLatency(spawn.latencyMs)}
          </span>

          <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
            {fmtTokens(spawn.tokensInput, spawn.tokensOutput)}
          </span>

          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {fmtDate(spawn.startedAt)}
          </span>
        </div>

        {/* Expanded detail */}
        <CollapsibleContent>
          <div className="border-t border-border px-4 py-4">
            <SpawnDetailPanel spawn={spawn} detail={detail} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function SpawnDetailPanel({
  spawn,
  detail,
}: {
  spawn: SpawnItem;
  detail: SpawnDetail | undefined;
}) {
  const sections: Array<{ label: string; content: string | null }> = [];

  // Rendered prompt
  sections.push({
    label: "渲染后的提示词",
    content: spawn.renderedPrompt ?? null,
  });

  // Output (from detail)
  if (detail?.output != null) {
    sections.push({
      label: "输出",
      content: detail.output,
    });
  }

  // Log (from detail)
  if (detail?.log != null) {
    sections.push({
      label: "日志",
      content: detail.log,
    });
  }

  // Error
  if (spawn.error) {
    sections.push({
      label: "错误",
      content: spawn.error,
    });
  }

  // Metadata
  const metaItems: Array<{ label: string; value: string }> = [];
  if (detail?.modelRef)
    metaItems.push({ label: "模型", value: detail.modelRef });
  if (detail?.engineRef)
    metaItems.push({ label: "引擎", value: detail.engineRef });
  if (detail?.runtime)
    metaItems.push({ label: "运行时", value: detail.runtime });
  if (detail?.workspaceId)
    metaItems.push({ label: "工作区", value: detail.workspaceId.slice(0, 14) });
  if (spawn.nodeId)
    metaItems.push({ label: "节点", value: spawn.nodeId.slice(0, 14) });
  if (spawn.runId)
    metaItems.push({ label: "运行", value: spawn.runId.slice(0, 14) });

  return (
    <div className="space-y-4">
      {/* Metadata row */}
      {metaItems.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {metaItems.map((item) => (
            <div key={item.label} className="text-xs">
              <span className="text-muted-foreground">{item.label}: </span>
              <span className="font-mono">{item.value}</span>
            </div>
          ))}
        </div>
      )}

      {/* Content sections */}
      {sections.map(({ label, content }) => (
        <div key={label}>
          <h4 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
            <IconTerminal2 className="size-3.5" />
            {label}
          </h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 font-mono text-xs leading-relaxed">
            {content}
          </pre>
        </div>
      ))}
    </div>
  );
}
