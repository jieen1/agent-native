import type { DerivedStudioStep } from "@shared/studio-step-derive";
import type { Approval, GateKey } from "@shared/types";
import { GATE_KEY_LABELS } from "@shared/types";

import { StatusIcon } from "@/components/StatusIcon";
import { StatusRing } from "@/components/StatusRing";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const SIGNOFF_GATES: GateKey[] = [
  "plan-signoff",
  "ui-signoff",
  "design-signoff",
];

function StepStatus({ state }: { state: DerivedStudioStep["state"] }) {
  switch (state) {
    case "final":
      return <StatusIcon tone="ok" size="sm" />;
    case "in-progress":
      return <StatusRing status="running" size={14} />;
    case "skipped":
      return <StatusRing status="skipped" size={14} />;
    case "not-applicable":
      return <StatusIcon tone="mut" size="sm" aria-label="不适用" />;
    default:
      return <StatusRing status="pending" size={14} />;
  }
}

function stepSubtext(step: DerivedStudioStep): string | null {
  if (step.state === "final" && step.latestVersion != null) {
    return `${step.docKey} v${step.latestVersion}${
      step.producedByKind ? ` · ${step.producedByKind}` : ""
    }`;
  }
  if (step.state === "in-progress") return "会话进行中";
  if (step.state === "skipped") return "已跳过";
  if (step.state === "not-applicable") return "不适用";
  return null;
}

/**
 * Left 220px step rail (s2-sprint-studio.html `.steps-rail`) — 7 planning
 * steps + 3 signoff gates. Purely presentational: state is pre-derived by
 * the caller via `deriveStudioSteps` (shared/studio-step-derive.ts) from
 * already-fetched artifact/approval data, no fetching here.
 */
export function StepRail({
  steps,
  activeStep,
  onSelectStep,
  approvals,
  onSignoffClick,
}: {
  steps: DerivedStudioStep[];
  activeStep: number;
  onSelectStep: (step: number) => void;
  approvals: Approval[];
  onSignoffClick: (gateKey: GateKey) => void;
}) {
  return (
    <nav
      aria-label="规划步骤"
      className="flex w-[220px] shrink-0 flex-col gap-px overflow-y-auto border-r border-border bg-muted/40 p-2.5"
    >
      <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        规划步骤
      </div>
      {steps.map((step) => (
        <button
          key={step.step}
          type="button"
          onClick={() => onSelectStep(step.step)}
          title={step.reason}
          className={cn(
            "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
            step.step === activeStep
              ? "border border-primary/30 bg-primary/10"
              : "border border-transparent hover:bg-foreground/5",
          )}
        >
          <span className="w-3 shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {step.step}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "flex items-center gap-1.5 truncate text-[12.5px]",
                step.step === activeStep && "font-semibold text-primary",
              )}
            >
              {step.label}
              {step.optional ? (
                <Badge
                  variant="secondary"
                  className="h-4 px-1 text-[9.5px] font-normal"
                >
                  可选
                </Badge>
              ) : null}
            </span>
            {stepSubtext(step) ? (
              <span className="mt-0.5 block truncate text-[10.5px] text-muted-foreground">
                {stepSubtext(step)}
              </span>
            ) : null}
          </span>
          <StepStatus state={step.state} />
        </button>
      ))}

      <div className="mt-3.5 flex flex-col gap-px border-t border-border pt-2.5">
        <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          签核
        </div>
        {SIGNOFF_GATES.map((gateKey) => {
          const approval = approvals
            .filter((a) => a.gateKey === gateKey)
            .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
          const status = approval?.status;
          return (
            <button
              key={gateKey}
              type="button"
              onClick={() => onSignoffClick(gateKey)}
              className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-foreground/5"
            >
              {status === "approved" ? (
                <StatusIcon tone="ok" size="sm" />
              ) : status === "rejected" ? (
                <StatusIcon tone="err" size="sm" />
              ) : status === "pending" ? (
                <StatusRing status="gate" size={14} />
              ) : (
                <StatusRing status="pending" size={14} />
              )}
              <span className="flex-1 truncate">
                {GATE_KEY_LABELS[gateKey]}
              </span>
              {approval?.staleAt ? (
                <Badge variant="destructive" className="h-4 px-1 text-[9px]">
                  待重确认
                </Badge>
              ) : status === "approved" ? (
                <span className="font-mono text-[10.5px] text-muted-foreground">
                  已批
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
