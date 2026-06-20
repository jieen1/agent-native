// ===========================================================================
// STARTER NODE LIBRARY (DESIGN §3.7) — the pre-built, named, reusable nodes the
// template ships so every workflow ends with the SAME vetted gates.
//
// Two flavors (§3.7):
//  • Deterministic `tool` nodes (no LLM) wrapping one action: run-tests, lint,
//    git-commit, git-push, open-pr, apply-patch, finalize-status.
//  • Parameterized `agent` nodes (FIXED prompt + outputSchema): code-review,
//    security-review, secret-scan, pr-description.
//
// A library entry is the row shape `node_defs` stores: { key, kind, title,
// config } where `config` is the pinned partial-Node the dropped graph node
// inherits (overridable per-use). This module is PURE data + helpers so the seed
// action, the bundled template, and tests all read ONE source of truth.
// ===========================================================================

import type { Node, WorkflowGraph } from "./types.js";
import {
  FINALIZE_STATUS_ACTION,
  FINALIZE_STATUS_KEY,
} from "./finalize-gate.js";

/** A verdict shape every parameterized review/analysis node returns (§1.9). */
const VERDICT_SCHEMA = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail", "needs-changes"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "summary"],
        properties: {
          severity: {
            type: "string",
            enum: ["info", "low", "medium", "high", "critical"],
          },
          summary: { type: "string" },
          location: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * One library entry. `config` is the pinned PARTIAL node a dropped graph node
 * inherits (its `nodeDefKey` points back here). Carries its own `version` so a
 * workflow can pin a known-good gate (DESIGN §3.7).
 */
export interface LibraryNodeDef {
  key: string;
  kind: "tool" | "agent";
  title: string;
  version: number;
  /**
   * The pinned node config (a partial Node minus identity fields). When a graph
   * references this entry by `nodeDefKey`, the node materializes from this.
   */
  config: Partial<Node>;
}

// ── deterministic TOOL nodes (no LLM; wrap one action) ─────────────────────────

const TOOL_DEFS: LibraryNodeDef[] = [
  {
    key: "run-tests",
    kind: "tool",
    title: "Run tests",
    version: 1,
    config: { type: "tool", action: "run-tests", title: "Run tests" },
  },
  {
    key: "lint",
    kind: "tool",
    title: "Lint",
    version: 1,
    config: { type: "tool", action: "lint", title: "Lint" },
  },
  {
    key: "apply-patch",
    kind: "tool",
    title: "Apply patch",
    version: 1,
    config: { type: "tool", action: "apply-patch", title: "Apply patch" },
  },
  {
    key: "git-commit",
    kind: "tool",
    title: "Git commit",
    version: 1,
    config: { type: "tool", action: "git-commit", title: "Git commit" },
  },
  {
    key: "git-push",
    kind: "tool",
    title: "Git push",
    version: 1,
    config: { type: "tool", action: "git-push", title: "Git push" },
  },
  {
    key: "open-pr",
    kind: "tool",
    title: "Open PR",
    version: 1,
    config: { type: "tool", action: "open-pr", title: "Open PR" },
  },
  {
    // The required §6.2b L1 gate. A deterministic tool node that asserts the
    // agent set a sensible business status before `end`; the RUNTIME assertion
    // lives in server/work-items/finalize-gate.ts.
    key: FINALIZE_STATUS_KEY,
    kind: "tool",
    title: "Finalize status",
    version: 1,
    config: {
      type: "tool",
      action: FINALIZE_STATUS_ACTION,
      title: "Finalize status",
    },
  },
];

// ── parameterized AGENT nodes (FIXED prompt + outputSchema) ────────────────────

const AGENT_DEFS: LibraryNodeDef[] = [
  {
    key: "code-review",
    kind: "agent",
    title: "Code review",
    version: 1,
    config: {
      type: "agent",
      title: "Code review",
      assignee: "local",
      effort: "high",
      prompt:
        "Review the candidate change ({{deps}}) for correctness, edge cases, and " +
        "regressions. Be a skeptic: try to break it. Return a structured verdict.",
      outputSchema: VERDICT_SCHEMA,
    },
  },
  {
    key: "security-review",
    kind: "agent",
    title: "Security review",
    version: 1,
    config: {
      type: "agent",
      title: "Security review",
      assignee: "local",
      effort: "high",
      prompt:
        "Audit the candidate change ({{deps}}) for security issues: injection, " +
        "authz/authn gaps, secret exposure, unsafe deserialization, SSRF. Return a " +
        "structured verdict.",
      outputSchema: VERDICT_SCHEMA,
    },
  },
  {
    key: "secret-scan",
    kind: "agent",
    title: "Secret scan",
    version: 1,
    config: {
      type: "agent",
      title: "Secret scan",
      assignee: "local",
      effort: "medium",
      prompt:
        "Scan the candidate change ({{deps}}) for hardcoded secrets, API keys, " +
        "tokens, private URLs, or credential-looking literals. Return a structured " +
        "verdict (fail on any real secret).",
      outputSchema: VERDICT_SCHEMA,
    },
  },
  {
    key: "pr-description",
    kind: "agent",
    title: "PR description",
    version: 1,
    config: {
      type: "agent",
      title: "PR description",
      assignee: "local",
      effort: "low",
      prompt:
        "Write a concise PR description for the change ({{deps}}): what changed, " +
        "why, and the test plan. Markdown.",
      outputSchema: {
        type: "object",
        required: ["title", "body"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
      },
    },
  },
];

/** The full starter set, in a stable order (tools first, then agents). */
export const STARTER_LIBRARY: LibraryNodeDef[] = [...TOOL_DEFS, ...AGENT_DEFS];

/** The starter-set keys, for tests / docs / quick membership checks. */
export const STARTER_LIBRARY_KEYS: string[] = STARTER_LIBRARY.map((d) => d.key);

/** Look up a starter library entry by key (or undefined). */
export function starterLibraryDef(key: string): LibraryNodeDef | undefined {
  return STARTER_LIBRARY.find((d) => d.key === key);
}

/**
 * Materialize a graph node from a library entry: the pinned config + identity
 * (`id`, `nodeDefKey`). Per-use overrides are a shallow merge ON TOP of the
 * library config (DESIGN §3.7 "overridable per-use").
 */
export function nodeFromLibrary(
  def: LibraryNodeDef,
  id: string,
  overrides: Partial<Node> = {},
): Node {
  const merged: Partial<Node> = {
    type: (def.config.type ?? def.kind) as Node["type"],
    title: def.config.title ?? def.title,
    ...def.config,
    ...overrides,
  };
  // identity always wins (never let config/overrides clobber id/nodeDefKey).
  return {
    ...merged,
    id,
    type: merged.type ?? (def.kind as Node["type"]),
    title: merged.title ?? def.title,
    nodeDefKey: def.key,
  };
}

// ── the bundled template: code-change-with-review (DESIGN §1.9 / §3.7) ─────────

/** The bundled template's stable name (matched on idempotent re-seed). */
export const BUNDLED_TEMPLATE_NAME = "code-change-with-review";

/**
 * Build the bundled `code-change-with-review` graph (DESIGN §1.9 / §3.7): a
 * change is produced, then a DIVERSE-LENS review panel (code + security + secret
 * scan, §1.9 "diverse-lens judges") gates it, then the VETTED library tail
 * run-tests → finalize-status → git-commit → git-push → open-pr ends the run.
 *
 * Every gate node references the library by `nodeDefKey`, so a graph the brain
 * composes ends with the SAME vetted tail every time — it wires nodes, it does
 * not reinvent the push/MR step (the §3.7 trust boundary).
 */
export function buildBundledTemplateGraph(): WorkflowGraph {
  const lib = (
    key: string,
    id: string,
    overrides: Partial<Node> = {},
  ): Node => {
    const def = starterLibraryDef(key);
    if (!def) throw new Error(`starter library missing '${key}'`);
    return nodeFromLibrary(def, id, overrides);
  };

  const nodes: Node[] = [
    { id: "start", type: "start", title: "Start" },
    {
      id: "implement",
      type: "agent",
      title: "Implement change",
      assignee: "local",
      effort: "high",
      prompt:
        "Implement the change described by the work item. Produce a patch and a " +
        "short summary of what you changed.",
    },
    lib("code-review", "code-review", { prompt: undefined }),
    lib("security-review", "security-review", { prompt: undefined }),
    lib("secret-scan", "secret-scan", { prompt: undefined }),
    {
      id: "review-join",
      type: "join",
      title: "Review panel",
    },
    lib("run-tests", "run-tests"),
    lib(FINALIZE_STATUS_KEY, "finalize-status"),
    lib("git-commit", "git-commit"),
    lib("git-push", "git-push"),
    lib("open-pr", "open-pr"),
    { id: "end", type: "end", title: "End" },
  ];

  const e = (from: string, to: string) => ({ id: `e-${from}-${to}`, from, to });
  const edges = [
    e("start", "implement"),
    // diverse-lens review panel runs in parallel off the implementation.
    e("implement", "code-review"),
    e("implement", "security-review"),
    e("implement", "secret-scan"),
    e("code-review", "review-join"),
    e("security-review", "review-join"),
    e("secret-scan", "review-join"),
    // vetted tail: tests → finalize-status → commit → push → open PR → end.
    e("review-join", "run-tests"),
    e("run-tests", "finalize-status"),
    e("finalize-status", "git-commit"),
    e("git-commit", "git-push"),
    e("git-push", "open-pr"),
    e("open-pr", "end"),
  ];

  return { nodes, edges };
}
