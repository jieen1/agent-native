import {
  IconRobot,
  IconGitFork,
  IconRefresh,
  IconShieldCheck,
  IconBox,
} from "@tabler/icons-react";

import { cn } from "@/lib/utils";

import type { WorkflowNodeType } from "./workflow-dag-types";

/** Icon for a DAG node type — kept in sync with DagVisualizer's run-view mapping. */
export function NodeTypeIcon({
  type,
  className,
}: {
  type: string;
  className?: string;
}) {
  switch (type) {
    case "agent":
      return <IconRobot className={className} />;
    case "parallel_over":
      return <IconGitFork className={className} />;
    case "loop":
      return <IconRefresh className={className} />;
    case "human_gate":
      return <IconShieldCheck className={className} />;
    default:
      return <IconBox className={className} />;
  }
}

/** Tailwind bg-* class per node type — also reused by WorkflowDagThumbnail so
 * the card-grid mini graph and the full DAG preview agree on node coloring. */
export const DOT_COLORS: Record<WorkflowNodeType, string> = {
  agent: "bg-blue-500",
  parallel_over: "bg-violet-500",
  loop: "bg-amber-500",
  human_gate: "bg-emerald-600",
};

/** Colored square icon chip for a node type (list rows, graph preview, legend). */
export function NodeTypeDot({
  type,
  size = "md",
  className,
}: {
  type: WorkflowNodeType;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md text-white",
        size === "sm" ? "size-[18px] rounded-[5px]" : "size-[26px]",
        DOT_COLORS[type] ?? "bg-muted-foreground",
        className,
      )}
    >
      <NodeTypeIcon
        type={type}
        className={size === "sm" ? "size-2.5" : "size-3.5"}
      />
    </div>
  );
}
