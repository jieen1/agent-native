import { cn } from "@/lib/utils";

/**
 * Foundry StatusRing (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.1) — pure-CSS geometric ring for the
 * "in-progress family" of V3 node/run states. Terminal states (done/failed)
 * use `StatusIcon` instead, never this component. Orchestrator's own port
 * (see design-system.css) — templates don't share component code.
 */
export type StatusRingStatus =
  | "pending"
  | "queued"
  | "running"
  | "gate"
  | "skipped";

const STATUS_RING_LABEL: Record<StatusRingStatus, string> = {
  pending: "待处理",
  queued: "就绪",
  running: "运行中",
  gate: "待审批",
  skipped: "已跳过",
};

export interface StatusRingProps {
  status: StatusRingStatus;
  /** Diameter in px. Defaults to the spec's 14px. */
  size?: number;
  className?: string;
  /** Overrides the default Chinese status label used for the accessible name. */
  "aria-label"?: string;
}

export function StatusRing({
  status,
  size,
  className,
  "aria-label": ariaLabel,
}: StatusRingProps) {
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? STATUS_RING_LABEL[status]}
      className={cn("fd-ring", `fd-ring--${status}`, className)}
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
