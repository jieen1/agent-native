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

/** Solid status dot color, readable on any background. */
export const STATUS_DOT: Record<string, string> = {
  running: "bg-blue-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  cancelled: "bg-orange-500",
  skipped: "bg-zinc-400",
  "awaiting-approval": "bg-purple-500",
  ready: "bg-sky-400",
  pending: "bg-zinc-500",
  paused: "bg-amber-500",
};

/** Accent ring/border color per status for high-contrast cards. */
export const STATUS_ACCENT: Record<string, string> = {
  running: "border-blue-500/60 bg-blue-500/5",
  done: "border-emerald-500/50 bg-emerald-500/[0.04]",
  failed: "border-red-500/60 bg-red-500/[0.06]",
  cancelled: "border-orange-500/60 bg-orange-500/[0.06]",
  skipped: "border-zinc-500/40 bg-zinc-500/[0.04]",
  "awaiting-approval": "border-purple-500/60 bg-purple-500/[0.06]",
  ready: "border-sky-500/50 bg-sky-500/[0.05]",
  pending: "border-border bg-transparent",
  paused: "border-amber-500/60 bg-amber-500/[0.06]",
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
      className:
        "bg-orange-500/10 text-orange-600 border-orange-500/30 dark:text-orange-400",
    };
  }
  if (key.includes("vllm")) {
    return {
      label: "vLLM",
      className:
        "bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400",
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
