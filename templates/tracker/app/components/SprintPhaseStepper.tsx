import { SPRINT_PHASE_LABELS, SPRINT_PHASE_ORDER } from "@shared/types";
import type { SprintPhase } from "@shared/types";

import { StatusIcon } from "@/components/StatusIcon";
import { StatusRing } from "@/components/StatusRing";
import { cn } from "@/lib/utils";

const PHASE_TITLE: Partial<Record<SprintPhase, string>> = {
  auditing: "= gap-analysis（Phase H）：按 Goal 判 NO_GAPS 才可晋升合入 base",
};

/**
 * Foundry 八相位 Stepper (s6-sprint-cockpit.html ~356-374, 03-tracker.md
 * §5.2 头部). Purely presentational — driven entirely by the sprint's real
 * `phase` column, no fabricated progress. An unrecognized/legacy phase value
 * renders every node as pending rather than guessing a position.
 */
export function SprintPhaseStepper({ phase }: { phase: string }) {
  const currentIdx = SPRINT_PHASE_ORDER.indexOf(phase as SprintPhase);

  return (
    <div
      role="list"
      aria-label="Sprint 相位"
      className="flex items-center gap-1.5 overflow-x-auto px-0.5 py-1"
    >
      {SPRINT_PHASE_ORDER.map((p, i) => {
        const done = currentIdx >= 0 && i < currentIdx;
        const active = i === currentIdx;
        const connectorDone = currentIdx >= 0 && i <= currentIdx;
        return (
          <div
            key={p}
            role="listitem"
            className="flex shrink-0 items-center gap-1.5"
          >
            {i > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "h-0.5 w-5 shrink-0 rounded-full",
                  connectorDone ? "bg-success" : "bg-border",
                )}
              />
            ) : null}
            <span
              title={PHASE_TITLE[p]}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap text-xs",
                done && "text-foreground",
                active && "font-semibold text-info",
                !done && !active && "text-muted-foreground",
              )}
            >
              {done ? (
                <StatusIcon tone="ok" size="sm" />
              ) : active ? (
                <StatusRing status="running" size={13} />
              ) : (
                <StatusRing status="pending" size={13} />
              )}
              {SPRINT_PHASE_LABELS[p]}
            </span>
          </div>
        );
      })}
    </div>
  );
}
