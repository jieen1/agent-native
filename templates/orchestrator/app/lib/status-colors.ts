// ===========================================================================
// THE SINGLE SEMANTIC COLOR SOURCE (FRONTEND §C2).
//
// ONE map, four keyed dimensions. Board columns, every badge/chip, and (later,
// P4) the run-canvas node tints all read THIS file — so a "running" blue is the
// same blue everywhere and a category green is the same green on the column
// header, the card stripe, and the badge. Never inline a color per surface;
// add/adjust it here and every surface follows.
//
// Colors are expressed as Tailwind token classes only (the C2 rule: no raw
// hex/hsl). Each entry exposes the variants a surface needs:
//   - `badge`   : background + text + ring for a pill/chip
//   - `dot`     : a small status dot (bg only)
//   - `stripe`  : a left/top accent stripe (bg only)
//   - `column`  : a column header tint (bg + text) for the kanban
//   - `text`    : standalone foreground tint
// ===========================================================================

import type { StatusCategory } from "../../shared/status-schemes";

export interface ColorVariant {
  badge: string;
  dot: string;
  stripe: string;
  column: string;
  text: string;
}

// NOTE on Tailwind JIT: every color class below is written as a LITERAL string
// so the build-time scanner sees it (dynamic `bg-${stem}-500` template strings
// would be invisible to the scanner and silently dropped). Each dimension is a
// plain map of literals — that is deliberate, not verbosity for its own sake.

// ── Business status categories (the kanban's four buckets — §6.2a) ──────────
// completed (shipped) ≠ cancelled (killed) → never the same color.
export const CATEGORY_COLORS: Record<StatusCategory, ColorVariant> = {
  todo: {
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-1 ring-inset ring-slate-500/30",
    dot: "bg-slate-400",
    stripe: "bg-slate-400",
    column: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
    text: "text-slate-600 dark:text-slate-300",
  },
  "in-progress": {
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30",
    dot: "bg-blue-500",
    stripe: "bg-blue-500",
    column: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    text: "text-blue-600 dark:text-blue-400",
  },
  completed: {
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30",
    dot: "bg-emerald-500",
    stripe: "bg-emerald-500",
    column: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    text: "text-emerald-600 dark:text-emerald-400",
  },
  cancelled: {
    badge: "bg-muted text-muted-foreground ring-1 ring-inset ring-border line-through",
    dot: "bg-muted-foreground/50",
    stripe: "bg-muted-foreground/30",
    column: "bg-muted/40 text-muted-foreground",
    text: "text-muted-foreground",
  },
};

// ── Automation overlay (execState — the Queue view lanes + the card badge) ──
export type ExecState =
  | "idle"
  | "queued"
  | "claimed"
  | "running"
  | "paused"
  | "failed"
  | "done";

export const EXEC_COLORS: Record<ExecState, ColorVariant> = {
  idle: {
    badge: "bg-muted text-muted-foreground ring-1 ring-inset ring-border",
    dot: "bg-muted-foreground/40",
    stripe: "bg-muted-foreground/30",
    column: "bg-muted/40 text-muted-foreground",
    text: "text-muted-foreground",
  },
  queued: {
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30",
    dot: "bg-amber-500",
    stripe: "bg-amber-500",
    column: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "text-amber-600 dark:text-amber-400",
  },
  claimed: {
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30",
    dot: "bg-amber-500",
    stripe: "bg-amber-500",
    column: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "text-amber-600 dark:text-amber-400",
  },
  running: {
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/30",
    dot: "bg-blue-500",
    stripe: "bg-blue-500",
    column: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
    text: "text-blue-600 dark:text-blue-400",
  },
  paused: {
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-1 ring-inset ring-violet-500/30",
    dot: "bg-violet-500",
    stripe: "bg-violet-500",
    column: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    text: "text-violet-600 dark:text-violet-400",
  },
  failed: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-inset ring-red-500/30",
    dot: "bg-red-500",
    stripe: "bg-red-500",
    column: "bg-red-500/10 text-red-700 dark:text-red-300",
    text: "text-red-600 dark:text-red-400",
  },
  done: {
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 ring-1 ring-inset ring-emerald-500/30",
    dot: "bg-emerald-500",
    stripe: "bg-emerald-500",
    column: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    text: "text-emerald-600 dark:text-emerald-400",
  },
};

// ── NodeRun status (the mini node-run strip dots + P4 canvas tints) ─────────
export type NodeRunStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "awaiting-approval";

export const NODE_STATUS_DOT: Record<NodeRunStatus, string> = {
  pending: "bg-muted-foreground/40",
  ready: "bg-amber-500",
  running: "bg-blue-500",
  done: "bg-emerald-500",
  failed: "bg-red-500",
  skipped: "bg-muted-foreground/30",
  "awaiting-approval": "bg-orange-500",
};

// ── Incident severity (SEV1..4 chip) ────────────────────────────────────────
export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export const SEVERITY_COLORS: Record<Severity, ColorVariant> = {
  SEV1: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-inset ring-red-500/40",
    dot: "bg-red-500",
    stripe: "bg-red-500",
    column: "bg-red-500/10 text-red-700 dark:text-red-300",
    text: "text-red-600 dark:text-red-400",
  },
  SEV2: {
    badge: "bg-orange-500/15 text-orange-600 dark:text-orange-400 ring-1 ring-inset ring-orange-500/30",
    dot: "bg-orange-500",
    stripe: "bg-orange-500",
    column: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
    text: "text-orange-600 dark:text-orange-400",
  },
  SEV3: {
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/30",
    dot: "bg-amber-500",
    stripe: "bg-amber-500",
    column: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    text: "text-amber-600 dark:text-amber-400",
  },
  SEV4: {
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-1 ring-inset ring-slate-500/30",
    dot: "bg-slate-400",
    stripe: "bg-slate-400",
    column: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
    text: "text-slate-600 dark:text-slate-300",
  },
};

// ── Environment tag (SIT/UAT/prod/dev) — prod is loud, lower envs are calm ──
export const ENV_COLORS: Record<string, ColorVariant> = {
  prod: {
    badge: "bg-red-500/15 text-red-600 dark:text-red-400 ring-1 ring-inset ring-red-500/30",
    dot: "bg-red-500",
    stripe: "bg-red-500",
    column: "bg-red-500/10 text-red-700 dark:text-red-300",
    text: "text-red-600 dark:text-red-400",
  },
  UAT: {
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400 ring-1 ring-inset ring-violet-500/30",
    dot: "bg-violet-500",
    stripe: "bg-violet-500",
    column: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
    text: "text-violet-600 dark:text-violet-400",
  },
  SIT: {
    badge: "bg-teal-500/15 text-teal-600 dark:text-teal-400 ring-1 ring-inset ring-teal-500/30",
    dot: "bg-teal-500",
    stripe: "bg-teal-500",
    column: "bg-teal-500/10 text-teal-700 dark:text-teal-300",
    text: "text-teal-600 dark:text-teal-400",
  },
  dev: {
    badge: "bg-slate-500/15 text-slate-600 dark:text-slate-300 ring-1 ring-inset ring-slate-500/30",
    dot: "bg-slate-400",
    stripe: "bg-slate-400",
    column: "bg-slate-500/10 text-slate-700 dark:text-slate-300",
    text: "text-slate-600 dark:text-slate-300",
  },
};

const ENV_FALLBACK: ColorVariant = {
  badge: "bg-secondary text-secondary-foreground ring-1 ring-inset ring-border",
  dot: "bg-muted-foreground/40",
  stripe: "bg-muted-foreground/30",
  column: "bg-muted/40 text-muted-foreground",
  text: "text-muted-foreground",
};

// ── lookups (the public surface every component uses) ───────────────────────

export function categoryColor(category: string): ColorVariant {
  return (
    CATEGORY_COLORS[category as StatusCategory] ?? CATEGORY_COLORS.todo
  );
}

export function execColor(state: string): ColorVariant {
  return EXEC_COLORS[state as ExecState] ?? EXEC_COLORS.idle;
}

export function nodeStatusDot(status: string): string {
  return NODE_STATUS_DOT[status as NodeRunStatus] ?? NODE_STATUS_DOT.pending;
}

export function severityColor(severity: string): ColorVariant {
  return SEVERITY_COLORS[severity as Severity] ?? SEVERITY_COLORS.SEV4;
}

export function envColor(env: string): ColorVariant {
  return ENV_COLORS[env] ?? ENV_FALLBACK;
}
