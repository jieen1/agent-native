import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import {
  IconExternalLink,
  IconFileText,
  IconGitPullRequest,
  IconPlayerPlay,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useRuns, type RunListItem } from "@/hooks/use-runs";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { DataTable } from "@/components/board/DataTable";
import { EmptyState } from "@/components/board/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function meta() {
  return [{ title: `${APP_TITLE} — Runs` }];
}

const RUN_STATUSES = [
  "pending",
  "running",
  "paused",
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

function fmtDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// Runs — global activity page (FRONTEND §8). The cross-item run history as a
// DataTable (run id / template / work item / status / started / duration /
// tokens / deliverable) with a filter bar (status + template). Row click → the
// run console (page 4). Reads `list-runs`; control verbs live on the item page.
export default function RunsRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: runs = [], isLoading, error } = useRuns();
  const navAction = useActionMutation("navigate", {});

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [templateFilter, setTemplateFilter] = useState<string>("all");

  useEffect(() => {
    navAction.mutate({ view: "runs" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Distinct templates present in the run set drive the template filter.
  const templates = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runs) {
      if (!map.has(r.templateId)) {
        map.set(r.templateId, r.templateName ?? r.templateId);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [runs]);

  const filtered = useMemo(() => {
    return runs.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (templateFilter !== "all" && r.templateId !== templateFilter)
        return false;
      return true;
    });
  }, [runs, statusFilter, templateFilter]);

  const hasAnyRuns = !isLoading && !error && runs.length > 0;
  const isFiltered = statusFilter !== "all" || templateFilter !== "all";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {t("runs.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("runs.subtitle")}
          </p>
        </div>
        {hasAnyRuns ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[150px]">
                <SelectValue placeholder={t("runs.filterAllStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("runs.filterAllStatuses")}
                </SelectItem>
                {RUN_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`status.${s}`, { defaultValue: s })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={templateFilter} onValueChange={setTemplateFilter}>
              <SelectTrigger className="h-8 w-[180px]">
                <SelectValue placeholder={t("runs.filterAllTemplates")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("runs.filterAllTemplates")}
                </SelectItem>
                {templates.map(([id, name]) => (
                  <SelectItem key={id} value={id}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {t("runs.loadError")}
        </div>
      ) : (
        <DataTable<RunListItem>
          isLoading={isLoading}
          rows={filtered}
          rowKey={(r) => r.id}
          onRowClick={(r) => navigate(`/runs/${r.id}`)}
          columns={[
            {
              id: "id",
              header: t("runs.columnRunId"),
              cell: (r) => (
                <span className="font-mono text-xs font-medium">
                  {r.id.slice(0, 12)}
                </span>
              ),
            },
            {
              id: "template",
              header: t("runs.columnTemplate"),
              className: "hidden sm:table-cell",
              headClassName: "hidden sm:table-cell",
              cell: (r) => (
                <span className="truncate text-sm">
                  {r.templateName ?? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {r.templateId.slice(0, 8)}
                    </span>
                  )}
                </span>
              ),
            },
            {
              id: "workItem",
              header: t("runs.columnWorkItem"),
              className: "hidden md:table-cell",
              headClassName: "hidden md:table-cell",
              cell: (r) => (
                <span className="truncate text-sm">
                  {r.workItemTitle ?? (
                    <span className="text-muted-foreground">
                      {t("runs.deliverableNone")}
                    </span>
                  )}
                </span>
              ),
            },
            {
              id: "status",
              header: t("runs.columnStatus"),
              cell: (r) => <RunStatusBadge status={r.status} />,
            },
            {
              id: "started",
              header: t("runs.columnStarted"),
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {fmtDate(r.startedAt)}
                </span>
              ),
            },
            {
              id: "duration",
              header: t("runs.columnDuration"),
              className: "hidden lg:table-cell",
              headClassName: "hidden lg:table-cell",
              cell: (r) => (
                <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {fmtDuration(r.startedAt, r.completedAt)}
                </span>
              ),
            },
            {
              id: "tokens",
              header: t("runs.columnTokens"),
              className: "text-right",
              headClassName: "text-right",
              cell: (r) => (
                <span className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                  {r.tokensSpent.toLocaleString()}
                </span>
              ),
            },
            {
              id: "deliverable",
              header: t("runs.columnDeliverable"),
              cell: (r) => <DeliverableCell run={r} />,
            },
          ]}
          empty={
            <EmptyState
              icon={IconPlayerPlay}
              title={
                isFiltered
                  ? t("runs.emptyFilteredTitle")
                  : t("runs.title")
              }
              description={
                isFiltered ? t("runs.filterEmpty") : t("runs.empty")
              }
              className="border-0"
              action={
                isFiltered ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setStatusFilter("all");
                      setTemplateFilter("all");
                    }}
                  >
                    {t("common.all")}
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

// The deliverable cell renders the well-known PR / file-list shapes; stops row
// click when the user follows a PR link.
function DeliverableCell({ run }: { run: RunListItem }) {
  const { t } = useTranslation();
  const d = run.deliverable;
  if (!d) {
    return <span className="text-xs text-muted-foreground">{t("runs.deliverableNone")}</span>;
  }
  const url = typeof d.url === "string" ? d.url : undefined;
  const isPr = d.kind === "pr" || d.kind === "pull-request" || !!url;
  if (isPr && url) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 hover:underline dark:text-emerald-400"
      >
        <IconGitPullRequest className="size-3.5" />
        {t("runs.deliverablePr")}
        <IconExternalLink className="size-3" />
      </a>
    );
  }
  const fileCount = Array.isArray(d.files) ? d.files.length : 0;
  if (fileCount > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <IconFileText className="size-3.5" />
        {t("runs.deliverableFiles", { count: fileCount })}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <IconFileText className="size-3.5" />
      {d.kind}
    </span>
  );
}
