import { cn } from "@/lib/utils";

/**
 * Foundry StatusRing (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.1) — pure-CSS geometric ring for the
 * "in-progress family" of states. Terminal states (done/failed) use
 * `StatusIcon` instead, never this component.
 */
export type StatusRingStatus =
  | "pending"
  | "queued"
  | "running"
  | "review"
  | "gate"
  | "skipped"
  | "rejected";

const STATUS_RING_LABEL: Record<StatusRingStatus, string> = {
  pending: "待办",
  queued: "排队",
  running: "进行中",
  review: "评审中",
  gate: "门前等待",
  skipped: "已跳过",
  rejected: "已驳回",
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
      className={cn("orc-ring", `orc-ring--${status}`, className)}
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
