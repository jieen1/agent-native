import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { IconPlayerPlay } from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useRuns } from "@/hooks/use-runs";
import { RunStatusBadge } from "@/components/RunStatusBadge";

export function meta() {
  return [{ title: `${APP_TITLE} — Runs` }];
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function RunsRoute() {
  const { t } = useTranslation();
  const { data: runs = [], isLoading, error } = useRuns();

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {t("runs.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("runs.subtitle")}
        </p>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {t("runs.loadError")}
        </div>
      ) : runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <IconPlayerPlay className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t("runs.empty")}</p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {runs.map((run) => (
            <li key={run.id}>
              <Link
                to={`/runs/${run.id}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-accent/40"
              >
                <IconPlayerPlay className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm font-medium">
                    {run.id}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {fmtDate(run.startedAt)}
                  </p>
                </div>
                <span className="hidden text-xs text-muted-foreground sm:block">
                  {run.tokensSpent} tok
                </span>
                <RunStatusBadge status={run.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
