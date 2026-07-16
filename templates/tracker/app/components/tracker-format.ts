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
    dot: "bg-muted-foreground",
    live: false,
  },
  queued: {
    label: "queued",
    chip: "bg-warning/10 text-warning border-warning/30",
    dot: "bg-warning",
    live: false,
  },
  running: {
    label: "running",
    chip: "bg-info/10 text-info border-info/30",
    dot: "bg-info",
    live: true,
  },
  dispatched: {
    label: "dispatched",
    chip: "bg-info/10 text-info border-info/30",
    dot: "bg-info",
    live: true,
  },
  done: {
    label: "done",
    chip: "bg-success/10 text-success border-success/30",
    dot: "bg-success",
    live: false,
  },
  failed: {
    label: "failed",
    chip: "bg-destructive/10 text-destructive border-destructive/30",
    dot: "bg-destructive",
    live: false,
  },
  // F3: run came back successfully — review pending. The poll writeback caps
  // here; done is only reachable through the guarded transition-work-item.
  returned: {
    label: "returned",
    chip: "bg-agent/10 text-agent border-agent/30",
    dot: "bg-agent",
    live: false,
  },
  blocked: {
    label: "blocked",
    chip: "bg-warning/10 text-warning border-warning/30",
    dot: "bg-warning",
    live: false,
  },
  // F3: written by transition-work-item(target=closed) — a human closing an
  // undispatched item. Distinct from `failed` (a run error) — closed is a
  // deliberate, guarded, reason-required decision.
  closed: {
    label: "closed",
    chip: "bg-muted text-muted-foreground border-border",
    dot: "bg-muted-foreground",
    live: false,
  },
};

export function statusPresentation(status: string): StatusPresentation {
  return (
    STATUS[status] ?? {
      label: status || "unknown",
      chip: "bg-muted text-muted-foreground border-border",
      dot: "bg-muted-foreground",
      live: false,
    }
  );
}

// ── Inbox kind badges (S5) ────────────────────────────────────────────────────
//
// This template's app/global.css only defines a `--destructive` semantic
// token (no `--warning`/`--info`) — these stay literal Tailwind color
// utilities for now (same gap already noted on the NODE_STATUS/STATUS maps
// above), but centralized here so call sites reuse one named chip instead of
// each inlining its own amber/violet literal.
export type InboxKind = "pending-approval" | "review-request";

const INBOX_KIND_CHIP: Record<InboxKind, string> = {
  "pending-approval":
    "bg-amber-400/20 text-amber-700 dark:bg-amber-400/10 dark:text-amber-400",
  "review-request": "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

export function inboxKindChip(kind: InboxKind): string {
  return INBOX_KIND_CHIP[kind];
}

// ── Work-item type ───────────────────────────────────────────────────────────

const TYPE_CHIP: Record<string, string> = {
  requirement: "bg-info/10 text-info border-info/25",
  task: "bg-agent/10 text-agent border-agent/25",
  defect: "bg-destructive/10 text-destructive border-destructive/25",
  incident: "bg-warning/10 text-warning border-warning/25",
  // No dedicated indigo-family token exists in the Foundry token set (only
  // success/warning/info/destructive/agent/evidence) — epic/集合 reuses
  // --evidence (teal) as the one remaining unused hue so all 5 type chips
  // stay visually distinct, at the cost of a hue shift from the old indigo.
  epic: "bg-evidence/10 text-evidence border-evidence/25",
  集合: "bg-evidence/10 text-evidence border-evidence/25",
};

export function typeChip(type: string): string {
  return TYPE_CHIP[type] ?? "bg-muted text-muted-foreground border-border";
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
    dot: "bg-success",
    chip: "bg-success/10 text-success border-success/30",
    live: false,
  },
  running: {
    dot: "bg-info",
    chip: "bg-info/10 text-info border-info/30",
    live: true,
  },
  ready: {
    dot: "bg-info",
    chip: "bg-info/10 text-info border-info/30",
    live: false,
  },
  failed: {
    dot: "bg-destructive",
    chip: "bg-destructive/10 text-destructive border-destructive/30",
    live: false,
  },
  // Foundry has no dedicated "transient/cancelled" tone — the spec's own DAG
  // demo tags a retryable transient failure with `badge b-warning`, so
  // cancelled reuses --warning rather than inventing a new token.
  cancelled: {
    dot: "bg-warning",
    chip: "bg-warning/10 text-warning border-warning/30",
    live: false,
  },
  skipped: {
    dot: "bg-muted-foreground",
    chip: "bg-muted text-muted-foreground border-border",
    live: false,
  },
  pending: {
    dot: "bg-muted-foreground",
    chip: "bg-muted text-muted-foreground border-border",
    live: false,
  },
  "awaiting-approval": {
    dot: "bg-agent",
    chip: "bg-agent/10 text-agent border-agent/30",
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

export function classifyEvent(
  type: string,
  toolName?: string | null,
): EventKind {
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
