import { Link, useNavigate } from "react-router";
import {
  IconArrowLeft,
  IconChevronRight,
  IconClipboardText,
  IconRefresh,
} from "@tabler/icons-react";
import type { BriefingSummary } from "@shared/types";
import { useBriefings } from "@/hooks/use-briefings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { cn } from "@/lib/utils";
import {
  briefingStatusDisplay,
  formatBriefingDate,
  formatTimestamp,
} from "@/lib/briefing-format";

/**
 * History list: every briefing the user can see, newest first. Selecting one
 * opens its detail page. Scoped through `accessFilter` server-side, so the list
 * only ever contains briefings the caller owns or was shared.
 */
export function BriefingHistoryPage() {
  useSetPageTitle("Briefing History");
  const navigate = useNavigate();
  const { data: briefings = [], isLoading, error, refetch } = useBriefings();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex items-center gap-2">
        <Button asChild variant="ghost" size="sm" className="h-8 gap-1.5 pl-2">
          <Link to="/briefings">
            <IconArrowLeft className="size-3.5" />
            Today
          </Link>
        </Button>
        <h1 className="ml-1 text-lg font-semibold tracking-tight">History</h1>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      ) : error && briefings.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {error instanceof Error
              ? error.message.replace(/^Action [\w-]+ failed:\s*/, "")
              : "Couldn't load briefings."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => refetch()}
          >
            <IconRefresh className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : briefings.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <IconClipboardText className="size-8 text-muted-foreground/60" />
          <h2 className="text-base font-medium">No briefings yet</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Compiled briefings show up here so you can look back at earlier
            days.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {briefings.map((briefing: BriefingSummary) => {
            const status = briefingStatusDisplay(briefing.status);
            return (
              <li key={briefing.id}>
                <button
                  type="button"
                  onClick={() => navigate(`/briefings/${briefing.id}`)}
                  className="group flex w-full items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-left transition-colors hover:border-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {briefing.title}
                      </span>
                      <Badge
                        variant={status.variant}
                        className={cn("shrink-0 text-[10px]", status.className)}
                      >
                        {status.label}
                      </Badge>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                      <span className="capitalize">{briefing.kind}</span>
                      <span>{formatBriefingDate(briefing.briefingDate)}</span>
                      <span>{formatTimestamp(briefing.createdAt)}</span>
                    </div>
                  </div>
                  <IconChevronRight className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
