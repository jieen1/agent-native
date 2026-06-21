import { IconLoader2 } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { briefingStatusDisplay } from "@/lib/briefing-format";

interface CompilingPlaceholderProps {
  /** Source app ids being compiled, rendered as skeleton sections. */
  apps: readonly string[];
}

/**
 * Optimistic skeleton card shown the instant "Compile now" is pressed (§7,
 * plan §1.5.3 "乐观插入 status:compiling 占位卡"). It mirrors `BriefingView`'s
 * layout — a header with a `compiling` badge, a summary skeleton, and one
 * skeleton section per source app — so the real briefing replaces it in place
 * once the agent's `compile-briefing` insert lands via `useDbSync`.
 */
export function CompilingPlaceholder({ apps }: CompilingPlaceholderProps) {
  const status = briefingStatusDisplay("compiling");

  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight sm:text-2xl">
            Compiling today&apos;s briefing…
          </h1>
          <Badge
            variant={status.variant}
            className={cn("shrink-0 gap-1 text-[10px]", status.className)}
          >
            <IconLoader2 className="size-3 animate-spin" />
            {status.label}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          The Chief of Staff is gathering across {apps.join(", ")}.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Summary
        </h2>
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Sources
        </h2>
        <div className="space-y-2">
          {apps.map((app) => (
            <div
              key={app}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <Skeleton className="size-4 shrink-0 rounded-full" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium capitalize text-muted-foreground">
                {app}
              </span>
              <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
