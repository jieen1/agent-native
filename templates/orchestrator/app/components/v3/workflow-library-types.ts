import type { WorkflowNode } from "./workflow-dag-types";

export interface WorkflowMeta {
  builtin: boolean;
  family?: "sdlc" | "light" | string;
  tags: string[];
  changeNote?: string;
}

export interface WorkflowRunStats {
  runCount: number;
  successRate: number | null;
}

/** `workflowList` row shape (04 §4 — one card per template name, latest version). */
export interface WorkflowListRow {
  id: string;
  name: string;
  version: number;
  description: string | null;
  nodeCount: number;
  dag: { nodes?: WorkflowNode[] } | null;
  createdAt: string | null;
  ownerEmail: string;
  meta: WorkflowMeta;
  stats: WorkflowRunStats;
}

/** `workflowVersions` row shape (one entry per saved version, newest first). */
export interface WorkflowVersionRow {
  id: string;
  version: number;
  description: string | null;
  createdAt: string | null;
  ownerEmail: string;
  meta: WorkflowMeta;
  stats: WorkflowRunStats;
}

/**
 * Boot-time seeds and brain-authored saves both write `ownerEmail =
 * "local@localhost"` when there is no real authenticated session
 * (server/db/index.ts's `resolveOwnerEmail()` fallback) — a REAL logged-in
 * human session always resolves to their own email. That existing
 * write-side convention is the only provenance signal this data model has
 * today, so it's what the version chain's avatar uses to distinguish
 * "system/agent" saves from human ones — not a fabricated field.
 */
export function isSystemOwner(email: string): boolean {
  // guard:allow-localhost-fallback — read-only display comparison vs the pre-existing V3 sentinel, never used to grant access (see doc comment above)
  return email === "local@localhost";
}

export function ownerInitial(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (local[0] ?? "?").toUpperCase();
}

export function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`;
  } catch {
    return "—";
  }
}
