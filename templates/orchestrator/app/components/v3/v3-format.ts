/**
 * Shared formatting + presentation helpers for the V3 run-detail UI.
 *
 * Centralizes duration / token / status / agent formatting so the run header,
 * node cards, and inspector all read consistently.
 */

// ── Duration ─────────────────────────────────────────────────────────────────

export function durationMs(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start) return null;
  const e = end ? new Date(end).getTime() : Date.now();
  const ms = e - new Date(start).getTime();
  return ms >= 0 ? ms : null;
}

export function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Tokens ───────────────────────────────────────────────────────────────────

export function fmtTokens(n: number | null | undefined): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return String(iso);
  }
}

// ── Status presentation ──────────────────────────────────────────────────────

/**
 * Solid status dot color, readable on any background. Covers BOTH the v3 run
 * vocabulary (running/done/failed/...) and the brain-thread vocabulary
 * (running/done/error/queued/idle) — the two overlap on running/done and
 * share the same color identity for the statuses they hold in common, so a
 * brain thread and a v3 run never disagree about what "running" looks like.
 */
export const STATUS_DOT: Record<string, string> = {
  running: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-warning",
  skipped: "bg-muted-foreground",
  "awaiting-approval": "bg-agent",
  ready: "bg-info",
  pending: "bg-muted-foreground",
  paused: "bg-warning",
  // Brain-thread-only statuses (brain_threads.status; see brain.tsx).
  error: "bg-destructive",
  queued: "bg-warning",
  idle: "bg-muted-foreground",
};

/**
 * Full badge (bg/text) classes per status, derived from the SAME color
 * identity as {@link STATUS_DOT} — the single mapping both the thread rail's
 * dot and any header/status badge must read from, instead of each surface
 * hardcoding its own literal Tailwind palette (a past brain.tsx inconsistency:
 * ad hoc bg-blue-100/bg-red-100/bg-emerald-100 literals with no shared source
 * of truth). Covers the statuses STATUS_DOT does; falls back to a neutral
 * muted badge for anything else. Semantic tokens (--info/--success/--...) are
 * already theme-aware (see global.css :root/.dark), so no separate `dark:`
 * variant is needed the way the old literal palette required one.
 */
export const STATUS_BADGE: Record<string, string> = {
  running: "bg-info/15 text-info",
  done: "bg-success/15 text-success",
  failed: "bg-destructive/15 text-destructive",
  error: "bg-destructive/15 text-destructive",
  cancelled: "bg-warning/15 text-warning",
  queued: "bg-warning/15 text-warning",
  paused: "bg-warning/15 text-warning",
  idle: "bg-muted text-muted-foreground",
};

/** Badge classes for a status, falling back to a neutral muted style. */
export function statusBadgeClass(status: string): string {
  return STATUS_BADGE[status] ?? "bg-muted text-muted-foreground";
}

/** Accent ring/border color per status for high-contrast cards. */
export const STATUS_ACCENT: Record<string, string> = {
  running: "border-info/60 bg-info/5",
  done: "border-success/50 bg-success/[0.04]",
  failed: "border-destructive/60 bg-destructive/[0.06]",
  cancelled: "border-warning/60 bg-warning/[0.06]",
  skipped: "border-muted-foreground/40 bg-muted-foreground/[0.04]",
  "awaiting-approval": "border-agent/60 bg-agent/[0.06]",
  ready: "border-info/50 bg-info/[0.05]",
  pending: "border-border bg-transparent",
  paused: "border-warning/60 bg-warning/[0.06]",
};

export function statusLabel(status: string): string {
  return status === "awaiting-approval" ? "awaiting approval" : status;
}

// ── StatusRing / StatusIcon presentation ─────────────────────────────────────

import type { StatusIconTone } from "../StatusIcon";
import type { StatusRingStatus } from "../StatusRing";

export type StatusVocabPresentation =
  | { el: "ring"; status: StatusRingStatus }
  | { el: "icon"; tone: StatusIconTone };

/**
 * Maps a V3 run/node status string onto the Foundry status vocabulary
 * (StatusRing for in-progress states, StatusIcon for terminal/judgement
 * states) — replaces the plain solid-dot status marker across the run-detail
 * surface (04-orchestrator.md §3, DagVisualizer node cards + NodeInspector
 * header + run header). `ready` reads as "queued" (排队执行); `awaiting-approval`
 * reads as the human_gate "gate" ring; `paused` reads as "gate" too (waiting,
 * not moving) since the ported vocabulary has no dedicated paused ring.
 */
export function statusVocabPresentation(
  status: string,
): StatusVocabPresentation {
  switch (status) {
    case "pending":
      return { el: "ring", status: "pending" };
    case "ready":
      return { el: "ring", status: "queued" };
    case "running":
      return { el: "ring", status: "running" };
    case "awaiting-approval":
    case "paused":
      return { el: "ring", status: "gate" };
    case "skipped":
      return { el: "ring", status: "skipped" };
    case "done":
      return { el: "icon", tone: "ok" };
    case "failed":
      return { el: "icon", tone: "err" };
    case "cancelled":
      return { el: "icon", tone: "mut" };
    default:
      return { el: "ring", status: "pending" };
  }
}

// ── Agent presentation ───────────────────────────────────────────────────────

export interface AgentPresentation {
  label: string;
  className: string;
}

/**
 * Map an agent key to a readable label + accent class.
 * Falls back gracefully for unknown agents.
 */
export function agentPresentation(
  agent: string | null | undefined,
): AgentPresentation {
  const key = (agent ?? "").toLowerCase();
  if (key.includes("claude")) {
    return {
      label: "Claude Code",
      // No dedicated orange token in the Foundry set — closest existing hue
      // is --warning (amber), same "borrow the nearest hue" call tracker made
      // for its orange cancelled/blocked statuses.
      className: "bg-warning/10 text-warning border-warning/30",
    };
  }
  if (key.includes("vllm")) {
    return {
      label: "vLLM",
      // --agent is literally the violet/purple hue this used as a raw literal.
      className: "bg-agent/10 text-agent border-agent/30",
    };
  }
  if (key.includes("codex")) {
    return {
      label: "Codex",
      className:
        "bg-cyan-500/10 text-cyan-600 border-cyan-500/30 dark:text-cyan-400",
    };
  }
  if (!agent) {
    return {
      label: "—",
      className: "bg-muted text-muted-foreground border-border",
    };
  }
  return {
    label: agent,
    className: "bg-sky-500/10 text-sky-600 border-sky-500/30 dark:text-sky-400",
  };
}

/**
 * Best-effort model display: prefer an explicit model ref, then the runtime
 * or engine ref (e.g. claude-code agents report no model but do report a
 * runtime like `acp:claude-code`).
 */
export function modelDisplay(opts: {
  modelRef?: string | null;
  runtime?: string | null;
  engineRef?: string | null;
}): string {
  const { modelRef, runtime, engineRef } = opts;
  if (modelRef && modelRef.trim()) return modelRef.trim();
  if (engineRef && engineRef.trim() && engineRef !== "claude-code")
    return engineRef.trim();
  if (runtime && runtime.trim() && runtime !== "none")
    return runtime.replace(/^acp:/, "");
  return "—";
}
