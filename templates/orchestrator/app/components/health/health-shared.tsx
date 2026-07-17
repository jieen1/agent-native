import type { ReactNode } from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// Shared bits for /health and /insights (S10 · docs/sdlc-product-design/04-orchestrator.md §10/§11).
// Both pages mix real action-backed data with sections that have no backing
// action yet. Per AGENTS.md "Frontend And UX", that honesty must not read as
// a standing caption — DataHint is the shared affordance for it: a small
// hover/focus trigger that reveals the caveat instead of printing it inline.

export function HealthDot({
  tone,
  title,
}: {
  tone: "ok" | "warn" | "off" | "pending";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "warn" && "bg-amber-500",
        tone === "off" && "bg-muted-foreground/40",
        tone === "pending" && "bg-muted-foreground/40",
      )}
    />
  );
}

/**
 * Inline hover/focus hint marking a value as not backed by a real action yet.
 * Renders as a small dotted-underline trigger, not a standing paragraph — the
 * caveat only appears on hover/focus.
 */
export function DataHint({
  trigger,
  children,
  variant = "underline",
}: {
  trigger: ReactNode;
  children: ReactNode;
  /** "bare" drops the dotted underline — use for glyph triggers (e.g. "—")
   * where an underline would visually collide with the glyph itself. */
  variant?: "underline" | "bare";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "cursor-help outline-none",
            variant === "underline" &&
              "underline decoration-dotted decoration-muted-foreground/50 underline-offset-2",
          )}
        >
          {trigger}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64 text-xs">{children}</TooltipContent>
    </Tooltip>
  );
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s 前`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.round(min / 60);
  return `${hr}h 前`;
}
