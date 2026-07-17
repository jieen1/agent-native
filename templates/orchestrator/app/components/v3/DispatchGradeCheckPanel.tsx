import {
  IconAlertTriangle,
  IconCircleCheck,
  IconGauge,
} from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import type {
  DispatchGradeLintResult,
  LintRuleResult,
} from "./workflow-library-types";

function RuleRow({
  rule,
  onLocateNode,
}: {
  rule: LintRuleResult;
  onLocateNode?: (nodeId: string) => void;
}) {
  const heuristic = rule.confidence === "heuristic";
  const Icon = rule.ok ? IconCircleCheck : IconAlertTriangle;
  const iconClass = rule.ok
    ? heuristic
      ? "text-success/60"
      : "text-success"
    : heuristic
      ? "text-warning/80"
      : "text-destructive";
  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 text-xs",
        rule.ok
          ? "border-border/60 bg-transparent"
          : "border-warning/30 bg-warning/[0.04]",
        !rule.ok && !heuristic && "border-destructive/30 bg-destructive/[0.04]",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", iconClass)} />
        <span className="font-medium">{rule.label}</span>
        {heuristic ? (
          <Badge
            variant="outline"
            className="h-4 rounded-sm px-1 text-[9px] font-normal text-muted-foreground"
          >
            启发式
          </Badge>
        ) : null}
      </div>
      <div className="mt-1 pl-5 text-[11px] leading-snug text-muted-foreground">
        {rule.detail}
        {!rule.ok && onLocateNode && rule.nodeIds?.length ? (
          <>
            {" — "}
            {rule.nodeIds.map((id, i) => (
              <span key={id}>
                {i > 0 ? " / " : ""}
                <button
                  type="button"
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                  onClick={() => onLocateNode(id)}
                >
                  点击定位 {id}
                </button>
              </span>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

export interface DispatchGradeCheckPanelProps {
  result: DispatchGradeLintResult | null;
  isLoading?: boolean;
  onLocateNode?: (nodeId: string) => void;
}

/** Editor's live "派发级检查" side panel (r4 doc §4.5) — re-run on every
 *  debounced draft change, before save. Distinguishes the 5 structural rules
 *  from the 2 heuristic rules per-row (icon strength + an explicit tag) so
 *  the panel never implies the heuristic pair is as certain as the rest. */
export function DispatchGradeCheckPanel({
  result,
  isLoading,
  onLocateNode,
}: DispatchGradeCheckPanelProps) {
  return (
    <div className="flex h-full flex-col border-l border-border">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2.5">
        <IconGauge className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">派发级检查</span>
        {result ? (
          <Badge
            variant="outline"
            className={cn(
              "ml-auto font-mono text-[10px]",
              result.level === "dispatch-grade"
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {result.passCount}/{result.totalCount} ·{" "}
            {result.level === "dispatch-grade" ? "派发级" : "卡片级"}
          </Badge>
        ) : null}
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-2.5">
        {isLoading || !result ? (
          <div className="py-6 text-center text-xs text-muted-foreground">
            校验中…
          </div>
        ) : (
          result.results.map((r) => (
            <RuleRow key={r.rule} rule={r} onLocateNode={onLocateNode} />
          ))
        )}
      </div>
    </div>
  );
}
