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
 * in-progress geometric ring): the spec treats these as two separate
 * components, not two names for the same thing.
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
  mut: "无",
};

export interface StatusIconProps {
  tone: StatusIconTone;
  size?: StatusIconSize;
  /** Overrides the tone's default glyph (e.g. a custom Tabler icon). */
  icon?: Icon;
  className?: string;
  /** Overrides the default Chinese tone label used for the accessible name. */
  "aria-label"?: string;
  /**
   * Plays the spec's one-time "fm-complete" badge pop (foundry-motion.html).
   * Only for a genuine first-time completion moment — never on historical
   * rows or on every render.
   */
  animateComplete?: boolean;
}

export function StatusIcon({
  tone,
  size = "md",
  icon,
  className,
  "aria-label": ariaLabel,
  animateComplete,
}: StatusIconProps) {
  const Glyph = icon ?? DEFAULT_ICON[tone];
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? DEFAULT_LABEL[tone]}
      className={cn(
        "tk-status-icon",
        `tk-status-icon--${tone}`,
        size !== "md" && `tk-status-icon--${size}`,
        animateComplete && "tk-status-icon--complete",
        className,
      )}
    >
      <Glyph />
    </span>
  );
}
