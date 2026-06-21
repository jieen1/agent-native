import { IconCalendarTime } from "@tabler/icons-react";
import type { PublicBriefingView as PublicBriefing } from "../../../server/lib/briefing-meta.server";
import { formatBriefingDate } from "@/lib/briefing-format";

interface PublicBriefingViewProps {
  briefing: PublicBriefing;
}

/**
 * Server-rendered, read-only view of a PUBLIC briefing (Phase C / §455, §462).
 *
 * Rendered from loader data so the briefing's real title + summary body land in
 * the SSR HTML source for unauthenticated viewers and link-unfurl bots — this is
 * the "查 HTML 源含简报正文" gate, stronger than meta-only SSR. It is a pure
 * presentational component (no hooks, no client-only deps, no action calls) so
 * it is safe in the server bundle and hydrates cleanly. Only public briefings
 * ever reach it; private briefings fall back to the CSR shell.
 *
 * It deliberately renders only title + polished summary (no per-source raw
 * replies, no deep-link buttons) — a public share surface shows the curated
 * narrative, not the internal fan-out detail.
 */
export function PublicBriefingView({ briefing }: PublicBriefingViewProps) {
  const summary = briefing.summaryMd.trim();
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
      <article className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {briefing.title}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <IconCalendarTime className="size-3.5" />
              {formatBriefingDate(briefing.briefingDate)}
            </span>
            <span className="capitalize">{briefing.kind}</span>
          </div>
        </header>

        <section className="rounded-xl border border-border bg-card p-4 sm:p-6">
          {summary ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground sm:text-base">
              {summary}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              This briefing has no summary yet.
            </p>
          )}
        </section>

        <footer className="text-xs text-muted-foreground">
          Compiled by Chief of Staff.
        </footer>
      </article>
    </main>
  );
}
