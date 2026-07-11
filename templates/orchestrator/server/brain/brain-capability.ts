// Brain capability matrix (F4 — design 02 §5.4 / docs/sdlc-impl-f1-f4.md §4A).
//
// The brain's tool face is MECHANISM, not a prompt promise (§5.3 red line:
// "提示词红线拦不住任何一步" — the bootstrap trial caught the brain doing a
// printf append, a mis-checkout revert, and a full Write rewrite in sequence
// despite an explicit no-direct-edit instruction). This module is the single
// place that decides, per PHASE (dispatch | review), which CLI tools the
// brain's `claude` child (raw-spawn AND the gated ACP-harness path) is allowed
// to call.
//
// Data source: the EXISTING `orchestrator_agent_defs` table (DESIGN §7 — "S0"
// in docs/sdlc-impl-f1-f4.md §4A) via the existing `loadAgent()` loader
// (server/agent-loader.ts), reading its `capability_profile` column (added by
// this change) for the seeded `name: "brain", kind: "brain"` row — NOT a new
// table. That table already backs the DAG worker agent defs (vllm/
// claude-code); the brain is a THIRD row, tagged `kind: "brain"` (as opposed
// to `kind: "worker"`) precisely so list-agent-defs's default (worker-only)
// output — consumed by WorkflowEditor's DAG-node agent picker — never offers
// "brain" as a selectable DAG-node worker.
//
// Pure functions here (resolveBrainAllowedTools / isToolAllowedForPhase /
// buildBrainArgv) take no DB/network dependency and are unit-tested directly.
// loadBrainCapabilityProfile is the only DB-touching export, isolated so a
// failure to read config never blocks a turn — it degrades to the default.

import type { AgentCapabilityProfile } from "../agent-loader.js";

/** The two tool-face phases the orchestrator brain runs turns under. */
export type BrainPhase = "dispatch" | "review";

/** The `agent_defs.name` row this module reads (kind="brain"). */
export const BRAIN_AGENT_DEF_NAME = "brain";

/**
 * Hard-coded fallback used whenever the `brain` agent-def row is missing,
 * unreadable, or missing the requested phase — the brain must NEVER fail open
 * to a wider tool face than this. Both phases are intentionally IDENTICAL
 * (mcp__orchestrator + read-only inspection tools, no Bash/Write/Edit):
 * design §5.3 requires ALL brain code changes to flow through the DAG
 * workflowRun worker nodes, never a direct Bash/Edit/Write from the brain
 * itself, in EITHER phase — not just during review.
 */
export const DEFAULT_BRAIN_CAPABILITY: Record<
  BrainPhase,
  { tools: string[]; workspaceAccess: "ro" | "rw" | "none" }
> = {
  dispatch: {
    tools: ["mcp__orchestrator", "Read", "Grep", "Glob"],
    workspaceAccess: "ro",
  },
  review: {
    tools: ["mcp__orchestrator", "Read", "Grep", "Glob"],
    workspaceAccess: "ro",
  },
};

/**
 * Pure: resolve the `--allowedTools` list for a phase. Prefers the configured
 * profile's entry for `phase` when it is a non-empty tools array (so editing
 * the `brain` agent-def's `capability_profile` takes effect with zero code
 * changes — T-F4-03); otherwise falls back to DEFAULT_BRAIN_CAPABILITY.
 */
export function resolveBrainAllowedTools(
  phase: BrainPhase,
  profile?: AgentCapabilityProfile | null,
): string[] {
  const entry = profile?.[phase];
  if (entry && Array.isArray(entry.tools) && entry.tools.length > 0) {
    return entry.tools;
  }
  return DEFAULT_BRAIN_CAPABILITY[phase].tools;
}

/**
 * Pure: does `toolName` (as reported by the stream-json `tool_use` / ACP
 * `tool-start` event, e.g. "Read" or "mcp__orchestrator__workflowRun") fall
 * inside `allowedTools`? The `--allowedTools` CLI flag (and the ACP harness's
 * mcpServers channel) whitelists the WHOLE MCP server when a bare
 * "mcp__orchestrator" entry is present — individual tool calls surface as
 * "mcp__orchestrator__<action>" — so that one entry matches any such prefix.
 * Used to detect (and log) a tool_use the engine's own permission gate must
 * have refused (T-F4-06): we recompute this ourselves from the SAME
 * allow-list we built the argv from, rather than parsing denial wording.
 */
export function isToolAllowedForPhase(
  toolName: string,
  allowedTools: string[],
): boolean {
  if (!toolName) return false;
  for (const allowed of allowedTools) {
    if (allowed === toolName) return true;
    if (
      allowed === "mcp__orchestrator" &&
      toolName.startsWith("mcp__orchestrator__")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Best-effort read of the `brain` agent-def's `capability_profile` (via the
 * existing `loadAgent()` loader — DB-first, `.claude/agents/brain.md`
 * fallback, never throws in either branch by design). Wrapped in an
 * additional try/catch here anyway so ANY failure (agent-defs-seed plugin not
 * yet run, no DB configured, a malformed frontmatter file, …) resolves to
 * `null` and callers fall back to DEFAULT_BRAIN_CAPABILITY instead of
 * blocking a turn.
 */
export async function loadBrainCapabilityProfile(): Promise<AgentCapabilityProfile | null> {
  try {
    // Dynamic import keeps this module import-light (pure functions above are
    // unit-tested without pulling the agent-loader → db/index.js chain in).
    const { loadAgent } = await import("../agent-loader.js");
    const agent = await loadAgent(BRAIN_AGENT_DEF_NAME);
    const profile = agent.capabilityProfile;
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      return null;
    }
    return profile;
  } catch {
    return null;
  }
}

export interface BuildBrainArgvOpts {
  message: string;
  brainModel?: string | null;
  mcpConfigPath: string;
  allowedTools: string[];
  systemPrompt: string;
  resumeSessionId?: string | null;
}

/**
 * Pure: construct the `claude` CLI argv for one raw-spawn brain turn. No I/O —
 * the caller resolves brainModel / mcpConfigPath / allowedTools / systemPrompt
 * / resumeSessionId first. Kept as a pure function so the exact tool face for
 * a phase is directly assertable in a unit test (T-F4-01 / T-F4-09) without
 * spawning a child process.
 */
export function buildBrainArgv(opts: BuildBrainArgvOpts): string[] {
  const argv = [
    "-p",
    opts.message,
    ...(opts.brainModel ? ["--model", opts.brainModel] : []),
    "--mcp-config",
    opts.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    ...opts.allowedTools,
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    opts.systemPrompt,
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (opts.resumeSessionId) {
    argv.push("--resume", opts.resumeSessionId);
  }
  return argv;
}

/**
 * The ACP harness path (`runBrainHarnessTurn` in brain-session.ts) grants MCP
 * access through a SEPARATE `mcpServers` channel (buildBrainMcpServers), not
 * through the `tools` list — so the bare "mcp__orchestrator" wildcard entry
 * `resolveBrainAllowedTools` returns must be stripped before handing the list
 * to `_meta.claudeCode.options.tools`, or the ACP preset would reject/ignore
 * an unrecognized built-in tool name.
 */
export function harnessBuiltinTools(allowedTools: string[]): string[] {
  return allowedTools.filter((t) => t !== "mcp__orchestrator");
}

/**
 * Review-phase system-prompt addendum (design 02 §3 evaluation independence).
 * Appended to BRAIN_PROMPT only when phase === 'review' — reinforces (but does
 * NOT substitute for) the mechanical tool-face restriction: the enforcement is
 * the ABSENCE of Bash/Edit/Write from allowedTools, not this text.
 */
export const REVIEW_PHASE_PROMPT_ADDENDUM =
  "You are running in the REVIEW phase (independent evaluation, design 02 §3). " +
  "You may not be the session that authored this run's spec or dispatched it, " +
  "and must not assume or trust that session's framing. Treat the diff " +
  "adversarially — including the SPEC's OWN design decisions (transactionality, " +
  "batching, error handling, N+1 queries), not only whether the implementation " +
  "drifted from the spec. Conclude by calling mcp__orchestrator__runVerdict " +
  "with verdict PASSED or CHANGES_REQUESTED (+ findings). The ONLY remediation " +
  "for CHANGES_REQUESTED is a NEW mcp__orchestrator__workflowRun in fix mode " +
  "carrying your findings — you have no Bash/Edit/Write tools and must never " +
  "modify code yourself.";

/** Both phases: no Bash/Edit/Write, ever — reinforces §5.3 (belt, not buckle). */
export const NO_DIRECT_WRITE_PROMPT_CLAUSE =
  "You have NO Bash/Edit/Write tools in ANY phase — you cannot run shell " +
  "commands or modify files directly. All code changes happen through DAG " +
  "worker nodes (workflowRun); you author + monitor + review, you never " +
  "hand-edit.";
