import { IconBrain, IconRobot } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

/**
 * Foundry ActorAvatar (docs/sdlc-product-design/design-system/
 * foundry-components.html §3.4) — "shape carries the semantics": circle =
 * human, rounded-square = machine (agent = violet outline, brain = brand/blue
 * outline). There is no separate "--brain" color token in the spec — the
 * brain variant intentionally reuses --brand, exactly like `.avatar.a-brain`
 * does in foundry-components.html. `kind="brain"` is the natural fit for the
 * orchestrator brain session (see CLAUDE.md "V3 Execution").
 */
export type ActorAvatarKind = "human" | "agent" | "brain";

const KIND_LABEL: Record<ActorAvatarKind, string> = {
  human: "人",
  agent: "agent",
  brain: "brain",
};

export interface ActorAvatarProps {
  kind: ActorAvatarKind;
  /** Initials rendered for `kind="human"` (e.g. "SJ"). Ignored for agent/brain — those always show their Tabler glyph. */
  initials?: string;
  /** Shows the breathing "running" presence dot, bottom-right. */
  live?: boolean;
  /** Diameter in px. Defaults to the spec's 20px. */
  size?: number;
  className?: string;
  "aria-label"?: string;
}

export function ActorAvatar({
  kind,
  initials,
  live,
  size,
  className,
  "aria-label": ariaLabel,
}: ActorAvatarProps) {
  const glyphSize = size ? Math.round(size * 0.6) : 12;
  return (
    <span
      role="img"
      aria-label={
        ariaLabel ??
        (kind === "human" ? (initials ?? KIND_LABEL.human) : KIND_LABEL[kind])
      }
      className={cn(
        "orc-avatar",
        kind === "agent" && "orc-avatar--agent",
        kind === "brain" && "orc-avatar--brain",
        className,
      )}
      style={
        size
          ? { width: size, height: size, fontSize: Math.round(size * 0.45) }
          : undefined
      }
    >
      {kind === "human" ? (
        (initials ?? "?")
      ) : kind === "agent" ? (
        <IconRobot size={glyphSize} />
      ) : (
        <IconBrain size={glyphSize} />
      )}
      {live ? (
        <span className="orc-avatar-presence" aria-hidden="true" />
      ) : null}
    </span>
  );
}

export interface ActorAvatarStackItem {
  key: string;
  kind: ActorAvatarKind;
  initials?: string;
}

export interface ActorAvatarStackProps {
  avatars: ActorAvatarStackItem[];
  /** Max avatars shown before collapsing the rest into a "+N" tile. Spec default is 3. */
  max?: number;
  className?: string;
}

/** Foundry's "堆叠最多露 3 个 + N" stacking rule for ActorAvatar. */
export function ActorAvatarStack({
  avatars,
  max = 3,
  className,
}: ActorAvatarStackProps) {
  const shown = avatars.slice(0, max);
  const overflow = avatars.length - shown.length;
  return (
    <span className={cn("orc-avstack", className)}>
      {shown.map((a) => (
        <ActorAvatar key={a.key} kind={a.kind} initials={a.initials} />
      ))}
      {overflow > 0 ? (
        <span
          className="orc-avatar"
          style={{
            background: "hsl(var(--muted))",
            color: "hsl(var(--muted-foreground))",
          }}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}
