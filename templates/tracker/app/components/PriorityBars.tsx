import { cn } from "@/lib/utils";

/**
 * Foundry PriorityBars (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.3) — 4-bar priority ladder. Uses this app's
 * existing priority convention (1=P0 … 4=P3, see tracker-format.ts /
 * CLAUDE.md "Key Conventions"), not a 0-indexed one, so callers can pass a
 * work item's `priority` field straight through.
 */
export interface PriorityBarsProps {
  /** 1=P0 (urgent) … 4=P3 (low). Values outside 1-4 render as P3. */
  priority: number;
  className?: string;
  "aria-label"?: string;
}

const PRIORITY_LABEL: Record<number, string> = {
  1: "P0 紧急",
  2: "P1 高",
  3: "P2 中",
  4: "P3 低",
};

export function PriorityBars({
  priority,
  className,
  "aria-label": ariaLabel,
}: PriorityBarsProps) {
  const level = priority >= 1 && priority <= 4 ? priority : 4;
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? PRIORITY_LABEL[level]}
      className={cn("tk-pbars", `tk-pbars--p${level - 1}`, className)}
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
