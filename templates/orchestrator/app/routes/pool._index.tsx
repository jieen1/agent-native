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
  return [{ title: `${APP_TITLE} — Pool` }];
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
          Pool
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          microVM warm pool status and dispatch queue. Refreshes every 5 seconds.
        </p>
      </header>

      {/* ── Pool stats ─────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          VM Pool
        </h2>
        {poolError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Failed to load pool status. The poolStatus action may not yet be
            available.
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
              label="Warm Idle"
              value={vms.warm_idle}
              max={vms.capacity}
              icon={<IconCircleDotted className="size-4 text-emerald-500" />}
              className="border-emerald-200 dark:border-emerald-900/50"
            />
            <StatCard
              label="Busy"
              value={vms.busy}
              max={vms.capacity}
              icon={<IconPlayerPlay className="size-4 text-blue-500" />}
              className="border-blue-200 dark:border-blue-900/50"
            />
            <StatCard
              label="Capacity"
              value={vms.capacity}
              icon={<IconStack className="size-4 text-muted-foreground" />}
            />
            <StatCard
              label="Queue Waiting"
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
            Pool status unavailable.
          </div>
        )}

        {poolData?.replenishing && (
          <p className="mt-2 text-xs text-muted-foreground">
            Pool is replenishing warm VMs…
          </p>
        )}
      </section>

      {/* ── Dispatch queue ─────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Dispatch Queue
        </h2>

        {queueError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Failed to load dispatch queue. The dispatchQueue action may not yet
            be available.
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
                header: "Run ID",
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
                header: "Node ID",
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
                header: "Waiting For",
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
                header: "Queued At",
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
                title="Dispatch queue is empty"
                description="No spawns are waiting for VM, ACP, dependencies, or approval."
                className="border-0"
              />
            }
          />
        )}
      </section>
    </div>
  );
}
