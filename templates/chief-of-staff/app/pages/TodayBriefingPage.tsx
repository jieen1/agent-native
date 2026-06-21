import { useEffect, useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  IconRefresh,
  IconHistory,
  IconClipboardText,
  IconSparkles,
} from "@tabler/icons-react";
import { sendToAgentChat } from "@agent-native/core/client";
import { useBriefing, useBriefings } from "@/hooks/use-briefings";
import { DEFAULT_APPS } from "@shared/app-prompts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { BriefingView } from "@/components/briefings/BriefingView";
import { CompilingPlaceholder } from "@/components/briefings/CompilingPlaceholder";
import { formatBriefingDate } from "@/lib/briefing-format";

/**
 * How long the optimistic "compiling" placeholder stays up before we assume the
 * agent never started a compile (e.g. the message was edited/cancelled) and roll
 * it back with a toast. The real briefing normally lands well within this via
 * `useDbSync` once the agent's `compile-briefing` insert runs.
 */
const COMPILE_PLACEHOLDER_TIMEOUT_MS = 45_000;

/** Local-timezone YYYY-MM-DD — matches the navigation-state today scope. */
function todayLocalDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Today command center: renders the most recent briefing for today, with each
 * source app as a collapsible section. `useDbSync` (mounted in root) refetches
 * the list within one poll interval after any mutating action, so a manual
 * `update-briefing` (or an inserted briefing) shows up without a reload.
 */
export function TodayBriefingPage() {
  useSetPageTitle("Today");
  const today = todayLocalDate();

  const {
    data: briefings = [],
    isLoading: listLoading,
    error: listError,
    refetch,
  } = useBriefings(today);

  // The list is already date-scoped and ordered newest-first; the head is the
  // latest briefing for today.
  const latest = briefings[0];
  const {
    data: detail,
    isLoading: detailLoading,
    error: detailError,
  } = useBriefing(latest?.id ?? "");

  const isLoading = listLoading || (latest && detailLoading && !detail);
  const error = listError ?? detailError;

  // Optimistic "compiling" placeholder (§7, plan §1.5.3). "Compile now" routes
  // through the agent chat, so there's no action promise to await; instead we
  // record when the user asked to compile and show a skeleton card until the
  // agent's `compile-briefing` insert surfaces (via `useDbSync`) a briefing row
  // created at/after that moment — or we time out and roll back with a toast.
  const [compileStartedAt, setCompileStartedAt] = useState<number | null>(null);

  const handleCompile = () => {
    setCompileStartedAt(Date.now());
    sendToAgentChat({ message: "Compile and polish today's briefing." });
  };

  // Clear the placeholder once a fresh briefing for today lands.
  useEffect(() => {
    if (compileStartedAt === null || !latest) return;
    const createdAt = new Date(latest.createdAt).getTime();
    if (!Number.isNaN(createdAt) && createdAt >= compileStartedAt) {
      setCompileStartedAt(null);
    }
  }, [compileStartedAt, latest]);

  // Fallback rollback: if no briefing arrives in time, assume the compile never
  // started and clear the placeholder so the panel isn't stuck on a skeleton.
  useEffect(() => {
    if (compileStartedAt === null) return;
    const timer = window.setTimeout(() => {
      setCompileStartedAt(null);
      toast.error("Still compiling — check the chat, or try again.");
    }, COMPILE_PLACEHOLDER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [compileStartedAt]);

  // Show the placeholder only while pending and a fresher briefing hasn't yet
  // appeared. A briefing already in `compiling` status also keeps it visible via
  // `BriefingView`, so we avoid double-rendering once the real row lands.
  const showCompilingPlaceholder = compileStartedAt !== null && !isLoading;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {formatBriefingDate(today)}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Today</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
            <Link to="/briefings/history">
              <IconHistory className="size-3.5" />
              History
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => refetch()}
          >
            <IconRefresh className="size-3.5" />
            Refresh
          </Button>
          {/*
            "Compile now" routes through the agent chat (not a direct
            compile-briefing call) so the Chief-of-Staff agent runs the
            compile -> update-briefing two-step and writes a polished
            summaryMd (§1.5.3). useDbSync refetches this panel once the agent's
            mutating actions land.
          */}
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={compileStartedAt !== null}
            onClick={handleCompile}
          >
            <IconSparkles className="size-3.5" />
            Compile now
          </Button>
        </div>
      </div>

      {showCompilingPlaceholder ? (
        <CompilingPlaceholder apps={DEFAULT_APPS} />
      ) : isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : error && !detail ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {error instanceof Error
              ? error.message.replace(/^Action [\w-]+ failed:\s*/, "")
              : "Couldn't load today's briefing."}
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
      ) : !latest || !detail ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
          <IconClipboardText className="size-8 text-muted-foreground/60" />
          <h2 className="text-base font-medium">No briefing yet for today</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Ask the Chief of Staff to compile today&apos;s briefing across mail,
            calendar, brain, and analytics — it will appear here automatically.
          </p>
        </div>
      ) : (
        <BriefingView briefing={detail} />
      )}
    </div>
  );
}
