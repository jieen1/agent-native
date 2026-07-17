import { IconAlertTriangle, IconCircleCheck } from "@tabler/icons-react";

import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import type {
  DispatchGradeLintResult,
  LintRuleResult,
} from "./workflow-library-types";

/**
 * §4.2's own review round drew a hard line: rules ①②③⑥⑦ are exact
 * structural checks, ④⑤ are Chinese keyword heuristics with known false
 * positives/negatives — never render them with the same solid-checkmark
 * confidence. Heuristic rows get a dimmed icon + an explicit "启发式" tag
 * instead of a full-strength pass/fail color, in both directions (a
 * heuristic PASS reads as "probably fine", not "verified").
 */
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
    <div className="flex items-start gap-2 text-xs">
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
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
        <div className="text-muted-foreground">
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
                    {id}
                  </button>
                </span>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export interface DispatchGradeBadgeProps {
  result: DispatchGradeLintResult;
  className?: string;
  onLocateNode?: (nodeId: string) => void;
}

/** Compact badge (card grid / editor toolbar) — click to expand the 7-rule
 *  detail in a popover instead of a standing explanatory block. */
export function DispatchGradeBadge({
  result,
  className,
  onLocateNode,
}: DispatchGradeBadgeProps) {
  const dispatchGrade = result.level === "dispatch-grade";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn("inline-flex", className)}
          onClick={(e) => e.stopPropagation()}
        >
          <Badge
            variant="outline"
            className={cn(
              "gap-1 font-mono text-[10.5px]",
              dispatchGrade
                ? "border-success/40 bg-success/10 text-success"
                : "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            {dispatchGrade ? (
              <IconCircleCheck className="size-3" />
            ) : (
              <IconAlertTriangle className="size-3" />
            )}
            {dispatchGrade ? "派发级" : "卡片级"} {result.passCount}/
            {result.totalCount}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>派发级检查</span>
          <span className="font-mono normal-case">
            {result.passCount}/{result.totalCount}
          </span>
        </div>
        <div className="flex flex-col gap-2.5">
          {result.results.map((r) => (
            <RuleRow key={r.rule} rule={r} onLocateNode={onLocateNode} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
