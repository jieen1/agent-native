import type { Icon } from "@tabler/icons-react";
import {
  IconArrowRight,
  IconCheck,
  IconExclamationMark,
  IconMinus,
  IconX,
} from "@tabler/icons-react";

import { cn } from "@/lib/utils";

/**
 * Foundry StatusIcon (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.1a) — terminal/judgement states: a solid-fill
 * circle with a centered Tabler glyph. Distinct from `StatusRing` (the
 * in-progress geometric ring). Orchestrator's own port (see
 * design-system.css) — templates don't share component code.
 */
export type StatusIconTone = "ok" | "err" | "warn" | "inf" | "mut";
export type StatusIconSize = "sm" | "md" | "lg";

const DEFAULT_ICON: Record<StatusIconTone, Icon> = {
  ok: IconCheck,
  err: IconX,
  warn: IconExclamationMark,
  inf: IconArrowRight,
  mut: IconMinus,
};

const DEFAULT_LABEL: Record<StatusIconTone, string> = {
  ok: "完成",
  err: "失败",
  warn: "警告",
  inf: "信息",
  mut: "已取消",
};

export interface StatusIconProps {
  tone: StatusIconTone;
  size?: StatusIconSize;
  /** Overrides the tone's default glyph (e.g. a custom Tabler icon). */
  icon?: Icon;
  className?: string;
  /** Overrides the default Chinese tone label used for the accessible name. */
  "aria-label"?: string;
}

export function StatusIcon({
  tone,
  size = "md",
  icon,
  className,
  "aria-label": ariaLabel,
}: StatusIconProps) {
  const Glyph = icon ?? DEFAULT_ICON[tone];
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? DEFAULT_LABEL[tone]}
      className={cn(
        "fd-status-icon",
        `fd-status-icon--${tone}`,
        size !== "md" && `fd-status-icon--${size}`,
        className,
      )}
    >
      <Glyph />
    </span>
  );
}
