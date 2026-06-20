import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import type { Condition } from "../../../shared/types";
import type { FlowEdge } from "@/lib/workflow-graph-model";
import { cn } from "@/lib/utils";

// Custom edge that renders the `when` CONDITION as a label (FRONTEND §6 "edges
// show when labels"). Unconditional edges render as a plain line. The label is a
// compact, human-readable rendering of the Condition union (DESIGN §3.5).

export function conditionLabel(when: Condition | undefined): string | null {
  if (!when) return null;
  switch (when.kind) {
    case "jsonpath":
      return `${when.path} ${when.op} ${JSON.stringify(when.value)}`;
    case "status":
      return `${when.node} = ${when.equals}`;
    case "agent":
      return when.prompt ? `agent: ${when.prompt}` : "agent: …";
    default:
      return null;
  }
}

export function WhenEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const label = conditionLabel(data?.when);
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: selected
            ? "hsl(var(--primary))"
            : "hsl(var(--muted-foreground))",
          strokeWidth: selected ? 2 : 1.5,
        }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              "pointer-events-none absolute max-w-[180px] truncate rounded border bg-card px-1.5 py-0.5 text-[10px] font-medium shadow-sm",
              selected
                ? "border-primary text-foreground"
                : "border-border text-muted-foreground",
            )}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const edgeTypes = {
  when: WhenEdge,
};
