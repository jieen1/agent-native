import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import {
  IconAdjustments,
  IconAlertTriangle,
  IconCheck,
  IconChartDots,
  IconCpu,
  IconExternalLink,
  IconHeartRateMonitor,
  IconRefresh,
  IconServer,
  IconSettingsAutomation,
  IconShieldSearch,
  IconStack2,
  IconTerminal2,
  IconTimelineEvent,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import {
  DataSourceNote,
  HealthDot,
  fmtDateTime,
  fmtRelative,
} from "@/components/health/health-shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { APP_TITLE } from "@/lib/app-config";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: `${APP_TITLE} — 健康` }];
}

const REFRESH_MS = 30_000;

// ── Shapes (04 §10 — mirrors the actions' real return types) ────────────────

interface RuntimeConfigRow {
  id: string;
  name: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
  models: string[];
  active: boolean;
}

interface RuntimeStatus {
  chatEngine: string | null;
  chatModel: string | null;
  chatBaseUrl: string | null;
  executionRuntime: string;
  claudeCodeInstalled: boolean;
  claudeCodeLoggedIn: boolean;
  claudeCodeExpired: boolean;
  claudeCodeExpiresAt: string | null;
  claudeCodeSubscription: string | null;
  claudeCodeCredentialsFound: boolean;
}

interface BrainModelTier {
  tier: "sonnet" | "all";
}

interface BrainQueueStatus {
  brainConcurrency: number;
  running: number;
  queued: number;
  driverAlive: boolean;
  lastTickAt: string | null;
  reapsFired: number;
  tasksPromoted: number;
  threadsReconciled: number;
  spawnsReconciled: number;
  lastError: string | null;
}

interface HealthTelemetry {
  suspectSpawns: number;
  aliasDriftEvents: number;
  degradedEvents: number;
  conductionFixes: number;
  conductionFixesPending: boolean;
  configInconsistencyEvents: number;
  configInconsistencyEventsPending: boolean;
  writebackFailed: number;
  writebackStageMismatch: number;
  writebackOther: number;
  windowHours: number;
}

interface PoolStatusData {
  vms: {
    available: number;
    busy: number;
    capacity: number;
    queue_waiting: number;
  };
  replenishing?: boolean;
}

interface DispatchQueueItem {
  runId: string | null;
  nodeId: string | null;
  queuedAt: string | null;
  waiting_for: string;
}

interface TestRuntimeResult {
  ok: boolean;
  output: string | null;
  error: string | null;
  model: string | null;
  baseUrl: string | null;
}

const WAITING_COLORS: Record<string, string> = {
  vm: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  acp: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  deps: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  approval: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400",
};

// ── Card shell ───────────────────────────────────────────────────────────────

function HealthCard({
  icon: Icon,
  title,
  dot,
  dotTitle,
  children,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  dot?: "ok" | "warn" | "off" | "pending";
  dotTitle?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("gap-2 py-3", className)}>
      <CardHeader className="gap-0 px-4 py-0">
        <CardTitle className="flex items-center gap-2 text-[12.5px] font-semibold">
          <Icon className="size-4 text-muted-foreground" />
          {title}
          {dot ? (
            <span className="ml-auto">
              <HealthDot tone={dot} title={dotTitle} />
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1.5 px-4 py-0 text-[11.5px] text-muted-foreground">
        {children}
      </CardContent>
    </Card>
  );
}

// ── vLLM card ────────────────────────────────────────────────────────────────

function VllmCard() {
  const { data: configs, isLoading } = useActionQuery(
    "list-runtime-configs" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: RuntimeConfigRow[]; isLoading: boolean };
  // Fallback source: a vLLM/OpenAI-compatible engine can be the active chat
  // engine via the "agent-engine" setting (e.g. env-provisioned deployments)
  // without ever being saved as a runtime_configs row — verified live on 101,
  // where list-runtime-configs returned [] while get-runtime-status reported
  // a real active ai-sdk:openai engine. Without this fallback the card would
  // wrongly claim "not configured" while vLLM is actually serving.
  const { data: runtimeStatus } = useActionQuery(
    "get-runtime-status" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: RuntimeStatus };

  const active = useMemo(
    () => configs?.find((c) => c.kind !== "claude-code" && c.active),
    [configs],
  );
  const envActive =
    !active && runtimeStatus?.chatEngine === "ai-sdk:openai"
      ? runtimeStatus
      : undefined;

  const [probeAt, setProbeAt] = useState<number | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const probe = useActionMutation("test-runtime-config" as any) as {
    mutate: (
      vars: { id: string },
      opts?: {
        onSuccess?: (d: TestRuntimeResult) => void;
      },
    ) => void;
    data?: TestRuntimeResult;
    isPending: boolean;
  };

  function runProbe() {
    if (!active) return;
    const startedAt = Date.now();
    probe.mutate(
      { id: active.id },
      {
        onSuccess: () => setLatencyMs(Date.now() - startedAt),
      },
    );
    setProbeAt(startedAt);
  }

  const configured = !!active || !!envActive;

  return (
    <HealthCard
      icon={IconCpu}
      title="vLLM"
      dot={
        !configured
          ? "off"
          : active
            ? probe.data
              ? probe.data.ok
                ? "ok"
                : "warn"
              : "pending"
            : "ok"
      }
      dotTitle={
        !configured
          ? "未配置"
          : active
            ? probe.data
              ? probe.data.ok
                ? "上次探测成功"
                : "上次探测失败"
              : "尚未探测"
            : "对话引擎当前指向此端点"
      }
    >
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : !configured ? (
        <>
          <p>未配置激活的 vLLM / OpenAI 兼容端点。</p>
          <Link
            to="/settings"
            className="inline-flex w-fit items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            去设置配置 <IconExternalLink className="size-3" />
          </Link>
        </>
      ) : active ? (
        <>
          <p>
            端点{" "}
            <b className="font-mono text-foreground">{active.baseUrl ?? "—"}</b>{" "}
            · <b className="font-mono text-foreground">{active.model ?? "—"}</b>
          </p>
          <p>
            探测延迟{" "}
            {latencyMs != null ? (
              <b className="font-mono text-foreground">{latencyMs}ms</b>
            ) : (
              <span>尚未探测</span>
            )}
          </p>
          <p>
            {probe.data
              ? probe.data.ok
                ? "最近探测：成功"
                : `最近失败：${probe.data.error ?? "未知错误"}`
              : "最近失败：—"}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 w-fit gap-1 px-2 text-[11px]"
            disabled={probe.isPending}
            onClick={runProbe}
          >
            <IconRefresh
              className={cn("size-3", probe.isPending && "animate-spin")}
            />
            健康检查
          </Button>
          {probeAt && !probe.isPending && !probe.data ? (
            <DataSourceNote>探测中未收到结果，端点可能不可达。</DataSourceNote>
          ) : null}
        </>
      ) : (
        <>
          <p>
            对话引擎{" "}
            <b className="font-mono text-foreground">{envActive?.chatEngine}</b>
          </p>
          <p>
            模型{" "}
            <b className="font-mono text-foreground">
              {envActive?.chatModel ?? "—"}
            </b>
            {envActive?.chatBaseUrl ? (
              <>
                {" "}
                ·{" "}
                <b className="font-mono text-foreground">
                  {envActive.chatBaseUrl}
                </b>
              </>
            ) : null}
          </p>
          <DataSourceNote>
            未在「设置」中登记为 runtime_config
            行（很可能是环境变量直接配置的）， 因此没有可用于一键探测的
            id——这里展示的是真实生效的对话引擎，不提供 健康检查按钮。
          </DataSourceNote>
        </>
      )}
    </HealthCard>
  );
}

// ── Claude Code card ─────────────────────────────────────────────────────────

function ClaudeCodeCard() {
  const { data, isLoading } = useActionQuery(
    "get-runtime-status" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: RuntimeStatus; isLoading: boolean };
  const { data: tierData } = useActionQuery(
    "get-brain-model-tier" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: BrainModelTier };

  const loggedIn = !!data?.claudeCodeLoggedIn && !data?.claudeCodeExpired;

  return (
    <HealthCard
      icon={IconTerminal2}
      title="Claude Code"
      dot={!data ? "pending" : loggedIn ? "ok" : "warn"}
      dotTitle={loggedIn ? "已登录" : "未登录 / 已过期"}
    >
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <>
          <p>
            {data?.claudeCodeLoggedIn
              ? data?.claudeCodeExpired
                ? "登录已过期"
                : "已登录"
              : "未登录"}{" "}
            {tierData?.tier ? (
              <>
                · tier <b className="text-foreground">{tierData.tier}</b>
              </>
            ) : null}
          </p>
          <p>
            会话可恢复{" "}
            {data?.claudeCodeCredentialsFound ? (
              <IconCheck className="inline size-3.5 text-emerald-500" />
            ) : (
              <span>—</span>
            )}
            {data?.claudeCodeSubscription ? (
              <> · 订阅 {data.claudeCodeSubscription}</>
            ) : null}
          </p>
          <p className="text-[10.5px]">仅用于 brain，禁高频轮询</p>
        </>
      )}
    </HealthCard>
  );
}

// ── Brain 槽 card ─────────────────────────────────────────────────────────────

function BrainSlotCard() {
  const { data, isLoading } = useActionQuery(
    "brain-queue-status" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: BrainQueueStatus; isLoading: boolean };

  const degree = data?.brainConcurrency ?? 0;
  const running = data?.running ?? 0;

  return (
    <HealthCard
      icon={IconStack2}
      title="Brain 槽"
      dot={!data ? "pending" : data.driverAlive ? "ok" : "warn"}
      dotTitle={data?.driverAlive ? "driver 运行中" : "driver 无心跳"}
    >
      {isLoading ? (
        <Skeleton className="h-12 w-full" />
      ) : (
        <>
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="font-mono font-semibold text-foreground">
              {running}
            </span>
            /<span className="font-mono">{degree}</span>
          </div>
          <div className="mt-0.5 flex gap-1">
            {Array.from({ length: Math.max(degree, 1) }).map((_, i) => (
              <span
                key={i}
                className={cn(
                  "h-1.5 flex-1 rounded-sm",
                  i < running ? "bg-primary" : "bg-muted",
                )}
              />
            ))}
          </div>
          <p>
            排队线程{" "}
            <b className="font-mono text-foreground">{data?.queued ?? 0}</b>
          </p>
          <p>
            driver 心跳{" "}
            <b className="font-mono text-foreground">
              {fmtRelative(data?.lastTickAt)}
            </b>{" "}
            · 复原{" "}
            <b className="font-mono text-foreground">{data?.reapsFired ?? 0}</b>
          </p>
          {data?.lastError ? (
            <p className="text-amber-600 dark:text-amber-400">
              driver 错误：{data.lastError}
            </p>
          ) : null}
        </>
      )}
    </HealthCard>
  );
}

// ── 调度器 card ───────────────────────────────────────────────────────────────

function SchedulerCard({ telemetry }: { telemetry?: HealthTelemetry }) {
  const ok = telemetry ? telemetry.writebackFailed === 0 : undefined;

  return (
    <HealthCard
      icon={IconSettingsAutomation}
      title="调度器"
      dot={ok === undefined ? "pending" : ok ? "ok" : "warn"}
      dotTitle={ok ? "回写正常" : "存在回写失败"}
    >
      <p>
        reconciler 心跳 <span className="italic">待接入</span>
      </p>
      <p>
        上次恢复 <span className="italic">待接入</span>
      </p>
      <p>
        回写：成功{" "}
        <b className="font-mono text-foreground">
          {telemetry?.writebackOther ?? 0}
        </b>{" "}
        · 失败{" "}
        <b
          className={cn(
            "font-mono",
            (telemetry?.writebackFailed ?? 0) > 0
              ? "text-destructive"
              : "text-foreground",
          )}
        >
          {telemetry?.writebackFailed ?? 0}
        </b>{" "}
        · 阶段不匹配{" "}
        <b className="font-mono text-foreground">
          {telemetry?.writebackStageMismatch ?? 0}
        </b>
        <span className="text-[10.5px]">
          {" "}
          (近 {telemetry?.windowHours ?? 24}h)
        </span>
      </p>
      <DataSourceNote>
        reconciler tick 心跳 / 上次恢复计数暂无对外 action（仅 brain
        驱动器自身的 心跳可见，见「Brain 槽」卡）；回写行为读自 health-telemetry
        真实数据。
      </DataSourceNote>
    </HealthCard>
  );
}

// ── 遥测可信卡 ───────────────────────────────────────────────────────────────

function TelemetryTrustCard({ telemetry }: { telemetry?: HealthTelemetry }) {
  const confirmedNonZero = telemetry
    ? telemetry.suspectSpawns > 0 ||
      telemetry.aliasDriftEvents > 0 ||
      telemetry.degradedEvents > 0
    : undefined;

  return (
    <HealthCard
      icon={IconShieldSearch}
      title="遥测可信"
      dot={
        confirmedNonZero === undefined
          ? "pending"
          : confirmedNonZero
            ? "warn"
            : "ok"
      }
      dotTitle={confirmedNonZero ? "存在可疑用量/漂移/降级事件" : "全零"}
    >
      <p>
        suspect spawn{" "}
        <b
          className={cn(
            "font-mono",
            (telemetry?.suspectSpawns ?? 0) > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {telemetry?.suspectSpawns ?? 0}
        </b>
      </p>
      <p>
        别名漂移事件{" "}
        <b
          className={cn(
            "font-mono",
            (telemetry?.aliasDriftEvents ?? 0) > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {telemetry?.aliasDriftEvents ?? 0}
        </b>
      </p>
      <p>
        降级{" "}
        <b
          className={cn(
            "font-mono",
            (telemetry?.degradedEvents ?? 0) > 0
              ? "text-amber-600 dark:text-amber-400"
              : "text-foreground",
          )}
        >
          {telemetry?.degradedEvents ?? 0}
        </b>
      </p>
      <p>
        R9 传导修正{" "}
        <b className="font-mono text-foreground">
          {telemetry?.conductionFixes ?? 0}
        </b>
        {telemetry?.conductionFixesPending ? (
          <span className="text-[10.5px]"> (生产者未接入)</span>
        ) : null}
      </p>
      <p>
        配置未生效{" "}
        <b className="font-mono text-foreground">
          {telemetry?.configInconsistencyEvents ?? 0}
        </b>
        {telemetry?.configInconsistencyEventsPending ? (
          <span className="text-[10.5px]"> (生产者未接入)</span>
        ) : null}
      </p>
      <DataSourceNote>
        suspect 数据不入度量聚合；R9 传导修正 /
        配置未生效两项计数的事件生产者尚未接入， 当前恒为 0（非"确认为零"）。
      </DataSourceNote>
    </HealthCard>
  );
}

// ── Gate event timeline (no backing action yet) ─────────────────────────────

function GateEventTimeline() {
  return (
    <Card className="py-3">
      <CardHeader className="gap-0 px-4 py-0">
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
          <IconTimelineEvent className="size-4 text-muted-foreground" />
          门事件时间线
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 py-0 pt-2">
        <EmptyState
          icon={IconAlertTriangle}
          title="数据源建设中"
          description="派发拒绝 / 探测失败 / 启动恢复的历史时间线暂无对外 action（v3_events 目前只按具体 kind 单独查询，没有通用的时间序列读取面）。下方「容量」区展示的是当前排队快照，是实时数据，不是历史时间线。"
          className="border-dashed py-6"
        />
      </CardContent>
    </Card>
  );
}

// ── Capacity section ─────────────────────────────────────────────────────────

function CapacitySection() {
  const { data: poolData, isLoading: poolLoading } = useActionQuery(
    "poolStatus" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: PoolStatusData; isLoading: boolean };
  const { data: queueData, isLoading: queueLoading } = useActionQuery(
    "dispatchQueue" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as {
    data?: { queue?: DispatchQueueItem[] } | DispatchQueueItem[];
    isLoading: boolean;
  };

  const queue: DispatchQueueItem[] = Array.isArray(queueData)
    ? queueData
    : (queueData?.queue ?? []);
  const vms = poolData?.vms;

  return (
    <Card className="py-3">
      <CardHeader className="gap-0 px-4 py-0">
        <CardTitle className="flex items-center gap-2 text-[13px] font-semibold">
          <IconAdjustments className="size-4 text-muted-foreground" />
          容量
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 py-0 pt-2">
        {poolLoading && !vms ? (
          <Skeleton className="h-10 w-full" />
        ) : vms ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px]">
            <span>
              spawn 并发上限{" "}
              <b className="font-mono text-foreground">{vms.capacity}</b>
            </span>
            <span>
              忙碌 <b className="font-mono text-foreground">{vms.busy}</b>
            </span>
            <span>
              可用 <b className="font-mono text-foreground">{vms.available}</b>
            </span>
            <span>
              队列等待{" "}
              <b className="font-mono text-foreground">{vms.queue_waiting}</b>
            </span>
          </div>
        ) : null}
        <DataSourceNote>
          spawn 并发上限（G18）目前是固定容量，从 server/engine/v3-reconciler.ts
          的 `DEFAULT_POOL_CAPACITY = 8` 常量读取（单一出处）；调整并发的
          `set-concurrency` 尚未接入（server/runtime/backpressure.ts 标注为 "a
          future set-concurrency
          wire-up"）——因此这里不提供可交互滑杆。上方数值均从 当前排队/spawn
          快照实时推导。
        </DataSourceNote>
        <DataTable<DispatchQueueItem>
          isLoading={queueLoading && queue.length === 0}
          rows={queue}
          rowKey={(r) =>
            `${r.runId ?? "adhoc"}-${r.nodeId ?? "none"}-${r.queuedAt ?? ""}`
          }
          columns={[
            {
              id: "run",
              header: "排队 spawn",
              cell: (r) => (
                <span className="font-mono text-xs">
                  {r.runId ? r.runId.slice(0, 12) : "—"}
                </span>
              ),
            },
            {
              id: "waitingFor",
              header: "等待",
              cell: (r) => (
                <Badge
                  variant="secondary"
                  className={WAITING_COLORS[r.waiting_for] ?? ""}
                >
                  {r.waiting_for}
                </Badge>
              ),
            },
            {
              id: "queuedAt",
              header: "入队时间",
              cell: (r) => (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtDateTime(r.queuedAt)}
                </span>
              ),
            },
          ]}
          empty={
            <EmptyState
              icon={IconServer}
              title="当前没有排队的 spawn"
              className="border-0 py-6"
            />
          }
        />
      </CardContent>
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function HealthRoute() {
  const { data: telemetry } = useActionQuery(
    "health-telemetry" as any,
    {},
    { refetchInterval: REFRESH_MS },
  ) as { data?: HealthTelemetry };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <IconHeartRateMonitor className="size-4" />
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              健康
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              运行时、派发门与执行质量的单一真相页。
            </p>
          </div>
        </div>
        <Badge variant="outline" className="gap-1.5 font-normal">
          <IconRefresh className="size-3" />
          30s 自动刷新
        </Badge>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <VllmCard />
        <ClaudeCodeCard />
        <BrainSlotCard />
        <SchedulerCard telemetry={telemetry} />
        <TelemetryTrustCard telemetry={telemetry} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.4fr_1fr]">
        <GateEventTimeline />
        <CapacitySection />
      </div>

      <div className="mt-6 flex items-center gap-1.5 text-sm text-muted-foreground">
        <IconChartDots className="size-4" />
        执行质量与归因分析见{" "}
        <Link to="/insights" className="underline-offset-2 hover:underline">
          洞察
        </Link>
        。
      </div>
    </div>
  );
}
