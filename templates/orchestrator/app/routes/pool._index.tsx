import type { ReactNode } from "react";
import { useActionQuery } from "@agent-native/core/client";
import {
  IconServer,
  IconCircleDotted,
  IconPlayerPlay,
  IconStack,
  IconClock,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";

export function meta() {
  return [{ title: `${APP_TITLE} — 资源池` }];
}

// ── Stat card ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number | string;
  max?: number;
  icon: ReactNode;
  className?: string;
}

function StatCard({ label, value, max, icon, className }: StatCardProps) {
  return (
    <div
      className={`rounded-lg border bg-card p-4 flex flex-col gap-1 ${className ?? ""}`}
    >
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-4">{icon}</span>
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {max != null && (
          <span className="text-xs text-muted-foreground">/ {max}</span>
        )}
      </div>
    </div>
  );
}

// ── Waiting-for badge ─────────────────────────────────────────────────────────

const WAITING_COLORS: Record<string, string> = {
  vm: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  acp: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  deps: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  approval:
    "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-400",
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

// ── Pool status shape (DESIGN §8.7) ─────────────────────────────────────────

interface PoolStatusData {
  vms: {
    warm_idle: number;
    busy: number;
    capacity: number;
    queue_waiting: number;
  };
  replenishing?: boolean;
}

// ── Dispatch queue item shape (DESIGN §8.7) ──────────────────────────────────

interface DispatchQueueItem {
  runId: string | null;
  nodeId: string | null;
  queuedAt: string | null;
  waiting_for: string;
}

// ── Main component ───────────────────────────────────────────────────────────

export default function V3PoolRoute() {
  // Poll pool.status every 5 seconds while the page is mounted.
  const {
    data: poolData,
    isLoading: poolLoading,
    error: poolError,
  } = useActionQuery(
    "poolStatus" as any,
    {},
    { refetchInterval: 5_000 },
  ) as {
    data?: PoolStatusData;
    isLoading: boolean;
    error?: unknown;
  };

  // Poll dispatch.queue every 5 seconds.
  const {
    data: queueData,
    isLoading: queueLoading,
    error: queueError,
  } = useActionQuery(
    "dispatchQueue" as any,
    {},
    { refetchInterval: 5_000 },
  ) as {
    data?: { queue?: DispatchQueueItem[] } | DispatchQueueItem[];
    isLoading: boolean;
    error?: unknown;
  };

  // dispatchQueue returns { queue, total }; tolerate a bare array defensively.
  const queue: DispatchQueueItem[] = Array.isArray(queueData)
    ? queueData
    : (queueData?.queue ?? []);

  const vms = poolData?.vms;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          资源池
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          microVM 热池状态与派发队列。每 5 秒刷新一次。
        </p>
      </header>

      {/* ── Pool stats ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          VM 资源池
        </h2>
        {poolError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            加载资源池状态失败。poolStatus action 可能尚不可用。
          </div>
        ) : poolLoading && !vms ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : vms ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard
              label="热机空闲"
              value={vms.warm_idle}
              max={vms.capacity}
              icon={<IconCircleDotted className="size-4 text-emerald-500" />}
              className="border-emerald-200 dark:border-emerald-900/50"
            />
            <StatCard
              label="忙碌"
              value={vms.busy}
              max={vms.capacity}
              icon={<IconPlayerPlay className="size-4 text-blue-500" />}
              className="border-blue-200 dark:border-blue-900/50"
            />
            <StatCard
              label="容量"
              value={vms.capacity}
              icon={<IconStack className="size-4 text-muted-foreground" />}
            />
            <StatCard
              label="队列等待"
              value={vms.queue_waiting}
              icon={<IconClock className="size-4 text-amber-500" />}
              className={
                vms.queue_waiting > 0
                  ? "border-amber-200 dark:border-amber-900/50"
                  : ""
              }
            />
          </div>
        ) : (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm text-muted-foreground">
            资源池状态不可用。
          </div>
        )}

        {poolData?.replenishing && (
          <p className="mt-2 text-xs text-muted-foreground">
            资源池正在补充热机 VM…
          </p>
        )}
      </section>

      {/* ── Dispatch queue ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          派发队列
        </h2>

        {queueError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            加载派发队列失败。dispatchQueue action 可能尚不可用。
          </div>
        ) : (
          <DataTable<DispatchQueueItem>
            isLoading={queueLoading && queue.length === 0}
            rows={queue}
            rowKey={(r) =>
              `${r.runId ?? "adhoc"}-${r.nodeId ?? "none"}-${r.queuedAt ?? ""}`
            }
            columns={[
              {
                id: "run",
                header: "运行 ID",
                cell: (r) =>
                  r.runId ? (
                    <span className="font-mono text-xs font-medium">
                      {r.runId.slice(0, 14)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                id: "node",
                header: "节点 ID",
                className: "hidden md:table-cell",
                headClassName: "hidden md:table-cell",
                cell: (r) =>
                  r.nodeId ? (
                    <span className="font-mono text-xs">
                      {r.nodeId.slice(0, 14)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  ),
              },
              {
                id: "waitingFor",
                header: "等待项",
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
                className: "hidden lg:table-cell",
                headClassName: "hidden lg:table-cell",
                cell: (r) => (
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {fmtDate(r.queuedAt)}
                  </span>
                ),
              },
            ]}
            empty={
              <EmptyState
                icon={IconServer}
                title="派发队列为空"
                description="当前没有任务在等待 VM、ACP、依赖或审批。"
                className="border-0"
              />
            }
          />
        )}
      </section>
    </div>
  );
}
