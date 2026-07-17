import type { WorkflowNode } from "./workflow-dag-types";

export interface WorkflowMeta {
  builtin: boolean;
  family?: "core" | "sdlc" | "light" | string;
  tags: string[];
  changeNote?: string;
  /** r4 doc §4.1: this version's dag was never written by this seed — a real
   *  brain/human row whose meta got patched by the boot script's name-
   *  collision path. Mutually exclusive with `builtin`. */
  metaTaggedOnly?: boolean;
}

export interface WorkflowRunStats {
  runCount: number;
  successRate: number | null;
}

/** `lintTemplateDispatchGrade` result shape (r4 doc §4.2, 7 rules). */
export type LintConfidence = "structural" | "heuristic";

export interface LintRuleResult {
  rule: number;
  key: string;
  label: string;
  confidence: LintConfidence;
  ok: boolean;
  detail: string;
  nodeIds?: string[];
}

export interface DispatchGradeLintResult {
  ok: boolean;
  level: "dispatch-grade" | "card-grade";
  passCount: number;
  totalCount: number;
  results: LintRuleResult[];
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
  dispatchGrade: DispatchGradeLintResult;
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

export type VersionLineage = "seed" | "brain" | "human";

/**
 * Per-version "saved by" identity (r4 doc §4.1/§4.5): `metaTaggedOnly` wins
 * first — it's the boot plugin's own signal that this row's real dag came
 * from brain/human history, regardless of what `builtin`/ownerEmail say.
 * Otherwise `builtin` means the boot seed itself wrote this exact version
 * (only ever true for a fresh version-1 insert). Otherwise fall back to the
 * ownerEmail system-sentinel check used elsewhere in this file — note this
 * can't distinguish "seed" from "brain-without-a-session" on its own, which
 * is exactly why metaTaggedOnly/builtin are checked first.
 */
export function versionLineage(
  meta: WorkflowMeta,
  ownerEmail: string,
): VersionLineage {
  if (meta.metaTaggedOnly) return "brain";
  if (meta.builtin) return "seed";
  return isSystemOwner(ownerEmail) ? "brain" : "human";
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
