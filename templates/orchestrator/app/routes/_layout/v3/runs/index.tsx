import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useActionQuery } from "@agent-native/core/client";
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
import { IconList } from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — V3 Runs` }];
}

const RUN_STATUSES = [
  "all",
  "pending",
  "running",
  "paused",
  "done",
  "failed",
  "cancelled",
];

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  paused: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  cancelled: "bg-muted text-muted-foreground",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

function fmtDuration(start: string | null, end: string | null): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - s;
  if (ms < 0) return "—";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function V3RunsRoute() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: runs = [], isLoading, error } = useActionQuery(
    "runsList" as any,
    { status: statusFilter === "all" ? undefined : statusFilter },
    undefined,
  ) as { data?: any[]; isLoading: boolean; error?: unknown };

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            V3 Runs
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Workflow execution history and status.
          </p>
        </div>
        {runs.length > 0 ? (
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              {RUN_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s === "all" ? "All statuses" : s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Failed to load runs.
        </div>
      ) : (
        <DataTable
          isLoading={isLoading}
          rows={runs}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/v3/runs/${r.id}`)}
          columns={[
            {
              id: "id",
              header: "Run ID",
              cell: (r) => (
                <span className="font-mono text-xs font-medium">
                  {r.id.slice(0, 14)}
                </span>
              ),
            },
            {
              id: "status",
              header: "Status",
              cell: (r) => (
                <Badge
                  variant="secondary"
                  className={STATUS_COLORS[r.status] ?? ""}
                >
                  {r.status}
                </Badge>
              ),
            },
            {
              id: "template",
              header: "Template",
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="text-xs text-muted-foreground">
                  {r.templateId ?? "—"}
                </span>
              ),
            },
            {
              id: "started",
              header: "Started",
              cell: (r) => (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtDate(r.startedAt)}
                </span>
              ),
            },
            {
              id: "duration",
              header: "Duration",
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="font-mono text-xs text-muted-foreground">
                  {fmtDuration(r.startedAt, r.completedAt)}
                </span>
              ),
            },
            {
              id: "priority",
              header: "Priority",
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="font-mono text-xs">{r.priority}</span>
              ),
            },
          ]}
          empty={
            <EmptyState
              icon={IconList}
              title={statusFilter !== "all" ? "No runs match filter" : "No runs yet"}
              description="Runs are created when workflows are started."
              className="border-0"
              action={
                statusFilter !== "all" ? (
                  <Button size="sm" variant="outline" onClick={() => setStatusFilter("all")}>
                    Clear filter
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}
    </div>
  );
}
