import { IconCalendarTime, IconClock } from "@tabler/icons-react";
import type { BriefingDetail } from "@/hooks/use-briefings";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  briefingStatusDisplay,
  formatBriefingDate,
  formatTimestamp,
} from "@/lib/briefing-format";
import { BriefingSourceSection } from "./BriefingSourceSection";
import { BriefingStatusNotice } from "./BriefingStatusNotice";

interface BriefingViewProps {
  briefing: BriefingDetail;
}

/**
 * Render a full briefing: header (title, date, status), the agent-polished
 * summary, and one collapsible section per source app. Shared by the today
 * panel and the detail page so both stay consistent.
 */
export function BriefingView({ briefing }: BriefingViewProps) {
  const status = briefingStatusDisplay(briefing.status);
  const summary = briefing.summaryMd.trim();
  const sources = briefing.sources ?? [];

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight sm:text-2xl">
            {briefing.title}
          </h1>
          <Badge
            variant={status.variant}
            className={cn("shrink-0 text-[10px]", status.className)}
          >
            {status.label}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <IconCalendarTime className="size-3.5" />
            {formatBriefingDate(briefing.briefingDate)}
          </span>
          <span className="inline-flex items-center gap-1.5 capitalize">
            {briefing.kind}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <IconClock className="size-3.5" />
            Updated {formatTimestamp(briefing.updatedAt)}
          </span>
          {briefing.focus ? (
            <span className="truncate">Focus: {briefing.focus}</span>
          ) : null}
        </div>
      </header>

      <BriefingStatusNotice status={briefing.status} sources={sources} />

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Summary
        </h2>
        {summary ? (
          <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
            {summary}
          </pre>
        ) : (
          <p className="text-sm text-muted-foreground">
            No summary yet. The agent writes the polished summary after a
            briefing is compiled.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sources
        </h2>
        {sources.length > 0 ? (
          <div className="space-y-2">
            {sources.map((source, index) => (
              <BriefingSourceSection
                key={`${source.app}-${index}`}
                source={source}
                defaultOpen={index === 0}
              />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
            No sources yet. Sources appear here once a briefing is compiled
            across mail, calendar, brain, and analytics.
          </div>
        )}
      </section>
    </div>
  );
}
