import { cn } from "@/lib/utils";

/**
 * Foundry PriorityBars (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.3) — 4-bar priority ladder. Uses the Foundry
 * spec's 1=P0 (urgent) … 4=P3 (low) convention, same as
 * templates/tracker/app/components/PriorityBars.tsx. Note this differs from
 * this app's own `work_items.priority` / `v3_runs.priority` columns, which
 * are unbounded "higher number = dispatched first" scheduling priorities
 * (see actions/v3-run-priority.ts) — callers wiring this component to real
 * data need to map that scale to a 1-4 tier themselves.
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
      className={cn("orc-pbars", `orc-pbars--p${level - 1}`, className)}
    >
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}
