/**
 * Shared presentation helpers for the Tracker UI.
 *
 * Centralizes work-item status + type + node-status presentation (colors,
 * labels, dots) so the board, the work-item detail, and the activity panel all
 * read consistently. Mirrors the visual language of the orchestrator's
 * `v3-format` so the two apps feel like one product.
 */

// ── Work-item status ─────────────────────────────────────────────────────────

export interface StatusPresentation {
  /** Lowercase, human-readable label. */
  label: string;
  /** Badge/chip classes (bg + text + border), readable in light and dark. */
  chip: string;
  /** Solid dot color for the status. */
  dot: string;
  /** Whether the status represents live, in-flight work (animate the dot). */
  live: boolean;
}

const STATUS: Record<string, StatusPresentation> = {
  open: {
    label: "open",
    chip: "bg-muted text-muted-foreground border-border",
    dot: "bg-zinc-400",
    live: false,
  },
  queued: {
    label: "queued",
    chip: "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
    dot: "bg-amber-500",
    live: false,
  },
  running: {
    label: "running",
    chip: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400",
    dot: "bg-blue-500",
    live: true,
  },
  dispatched: {
    label: "dispatched",
    chip: "bg-sky-500/10 text-sky-600 border-sky-500/30 dark:text-sky-400",
    dot: "bg-sky-500",
    live: true,
  },
  done: {
    label: "done",
    chip: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    dot: "bg-emerald-500",
    live: false,
  },
  failed: {
    label: "failed",
    chip: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
    dot: "bg-red-500",
    live: false,
  },
  // F3: run came back successfully — review pending. The poll writeback caps
  // here; done is only reachable through the guarded transition-work-item.
  returned: {
    label: "returned",
    chip: "bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400",
    dot: "bg-violet-500",
    live: false,
  },
  blocked: {
    label: "blocked",
    chip: "bg-orange-500/10 text-orange-600 border-orange-500/30 dark:text-orange-400",
    dot: "bg-orange-500",
    live: false,
  },
  // F3: written by transition-work-item(target=closed) — a human closing an
  // undispatched item. Distinct from `failed` (a run error) — closed is a
  // deliberate, guarded, reason-required decision.
  closed: {
    label: "closed",
    chip: "bg-zinc-500/10 text-zinc-600 border-zinc-500/30 dark:text-zinc-400",
    dot: "bg-zinc-500",
    live: false,
  },
};

export function statusPresentation(status: string): StatusPresentation {
  return (
    STATUS[status] ?? {
      label: status || "unknown",
      chip: "bg-muted text-muted-foreground border-border",
      dot: "bg-zinc-400",
      live: false,
    }
  );
}

// ── Work-item type ───────────────────────────────────────────────────────────

const TYPE_CHIP: Record<string, string> = {
  requirement:
    "bg-blue-500/10 text-blue-600 border-blue-500/25 dark:text-blue-400",
  task: "bg-violet-500/10 text-violet-600 border-violet-500/25 dark:text-violet-400",
  defect: "bg-rose-500/10 text-rose-600 border-rose-500/25 dark:text-rose-400",
  incident:
    "bg-amber-500/10 text-amber-600 border-amber-500/25 dark:text-amber-400",
  epic: "bg-indigo-500/10 text-indigo-600 border-indigo-500/25 dark:text-indigo-400",
  集合: "bg-indigo-500/10 text-indigo-600 border-indigo-500/25 dark:text-indigo-400",
};

export function typeChip(type: string): string {
  return (
    TYPE_CHIP[type] ?? "bg-muted text-muted-foreground border-border"
  );
}

// ── DAG node status (design / develop / review / commit) ─────────────────────

export interface NodeStatusPresentation {
  /** Dot/icon color for the node status. */
  dot: string;
  /** Chip classes for the node pill. */
  chip: string;
  /** Whether to spin/pulse (running). */
  live: boolean;
}

const NODE_STATUS: Record<string, NodeStatusPresentation> = {
  done: {
    dot: "bg-emerald-500",
    chip: "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
    live: false,
  },
  running: {
    dot: "bg-blue-500",
    chip: "bg-blue-500/10 text-blue-600 border-blue-500/30 dark:text-blue-400",
    live: true,
  },
  ready: {
    dot: "bg-sky-400",
    chip: "bg-sky-500/10 text-sky-600 border-sky-500/30 dark:text-sky-400",
    live: false,
  },
  failed: {
    dot: "bg-red-500",
    chip: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
    live: false,
  },
  cancelled: {
    dot: "bg-orange-500",
    chip: "bg-orange-500/10 text-orange-600 border-orange-500/30 dark:text-orange-400",
    live: false,
  },
  skipped: {
    dot: "bg-zinc-400",
    chip: "bg-zinc-500/10 text-zinc-500 border-zinc-500/30",
    live: false,
  },
  pending: {
    dot: "bg-zinc-400",
    chip: "bg-muted text-muted-foreground border-border",
    live: false,
  },
  "awaiting-approval": {
    dot: "bg-purple-500",
    chip: "bg-purple-500/10 text-purple-600 border-purple-500/30 dark:text-purple-400",
    live: false,
  },
};

export function nodeStatusPresentation(status: string): NodeStatusPresentation {
  return NODE_STATUS[status] ?? NODE_STATUS.pending;
}

// ── Brain transcript event presentation ──────────────────────────────────────

/**
 * Classify a brain transcript event into a presentational kind. The transcript
 * carries `type` (assistant / tool_use / tool_result / user / …) and an
 * optional `toolName`; we map those to an icon tone + label.
 */
export type EventKind = "assistant" | "tool" | "result" | "user" | "system";

export function classifyEvent(type: string, toolName?: string | null): EventKind {
  const t = (type ?? "").toLowerCase();
  if (toolName) return "tool";
  if (t.includes("tool_result") || t.includes("result")) return "result";
  if (t.includes("tool")) return "tool";
  if (t.includes("assistant")) return "assistant";
  if (t.includes("user")) return "user";
  if (t.includes("text")) return "assistant";
  return "system";
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return fmtDateTime(iso);
}

// ── Cross-app links ──────────────────────────────────────────────────────────

/**
 * Absolute path to the orchestrator brain transcript for a thread. The
 * orchestrator app is mounted under `/orchestrator` in the gateway; the brain
 * UI reads `?thread=<id>` to open that session. This is a cross-app link, so it
 * must be a full-page navigation (plain anchor), not a react-router Link.
 */
export function orchestratorBrainHref(threadId: string): string {
  return `/orchestrator/brain?thread=${encodeURIComponent(threadId)}`;
}

/**
 * Absolute path to the orchestrator's run detail page for a bound DAG run id
 * (F8 §S4 execution-group deep link). Cross-app link — plain anchor, not a
 * react-router Link, same reasoning as orchestratorBrainHref above.
 */
export function orchestratorRunHref(runId: string): string {
  return `/orchestrator/runs/${encodeURIComponent(runId)}`;
}

/** Turn a clone/remote URL into a browsable GitHub URL (strips `.git`). */
export function repoHref(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const clean = remote.trim().replace(/\.git$/, "");
  if (/^https?:\/\//.test(clean)) return clean;
  // scp-style git@github.com:org/repo
  const m = /^git@([^:]+):(.+)$/.exec(clean);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

/** Short, human label for a repo remote (org/repo when GitHub). */
export function repoLabel(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  if (m) return m[1];
  return remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");
}
