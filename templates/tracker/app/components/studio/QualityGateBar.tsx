import type { MergedQualityGateItem } from "@shared/quality-gate-parse";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Bottom quality-gate bar (s2-sprint-studio.html `.quality-bar`) — dual-track
 * rendering per §5.2/§5.4: `check-artifact-gates`'s deterministic items
 * (never overridable) merged with the artifact's own `## 质量门自评` items
 * (overridable). The adopt button is gated on the machine track only.
 */
export function QualityGateBar({
  items,
  docKey,
  nextVersion,
  canAdopt,
  onAdopt,
  onOverride,
  adopting,
}: {
  items: MergedQualityGateItem[];
  docKey: string;
  nextVersion: number;
  canAdopt: boolean;
  onAdopt: () => void;
  /** Toggle a failing self-assessment item's override (never called for
   *  machine-track items — those aren't clickable). */
  onOverride?: (key: string, checked: boolean) => void;
  adopting?: boolean;
}) {
  const failing = items.filter((i) => i.verdict === "fail");

  return (
    <div className="sticky bottom-0 mt-auto flex flex-wrap items-center gap-3.5 border-t border-border bg-background px-5 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        质量门
      </span>
      {items.length === 0 ? (
        <span className="text-xs text-muted-foreground">
          尚无门判据（产物为空或该步无硬性门）
        </span>
      ) : (
        items.map((item) => {
          const overridable =
            item.overridable && item.rawVerdict === "fail" && !!onOverride;
          const content = (
            <>
              {item.verdict === "pass" ? (
                <IconCheck className="size-3.5" />
              ) : (
                <IconAlertTriangle className="size-3.5" />
              )}
              {item.label}
              {item.overridden ? (
                <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                  签核人已覆盖
                </span>
              ) : null}
            </>
          );
          const className = cn(
            "flex items-center gap-1.5 text-xs",
            item.verdict === "pass" ? "text-success" : "text-warning",
            overridable &&
              "cursor-pointer underline decoration-dotted underline-offset-2",
          );
          if (overridable) {
            return (
              <button
                key={`${item.track}:${item.key}`}
                type="button"
                title={`${item.detail ?? ""}（点击${item.overridden ? "撤销覆盖" : "签核人覆盖为通过"}）`}
                className={className}
                onClick={() => onOverride!(item.key, !item.overridden)}
              >
                {content}
              </button>
            );
          }
          return (
            <span
              key={`${item.track}:${item.key}`}
              title={item.detail}
              className={className}
            >
              {content}
            </span>
          );
        })
      )}
      <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
        {!canAdopt && failing.length > 0 ? (
          <span>{failing.length} 项确定性门未过，暂不可采纳</span>
        ) : null}
      </span>
      <Button
        size="sm"
        disabled={!canAdopt || adopting}
        onClick={onAdopt}
        title={
          !canAdopt
            ? `未过：${failing.map((i) => i.label).join("、")}`
            : undefined
        }
      >
        采纳为 {docKey} v{nextVersion}
      </Button>
    </div>
  );
}
