import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb, schema } from "./db/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolve `.claude/agents/` at RUNTIME. In a built bundle `__dirname` points
// into `.output/server/`, so `.claude/agents` is NOT next to it — prefer the
// app's working dir (the template root, where the agents live and are mounted),
// then fall back to source-relative paths for dev/tests.
const AGENTS_DIR_CANDIDATES = [
  join(process.cwd(), ".claude", "agents"),
  join(__dirname, "..", ".claude", "agents"),
  join(__dirname, "..", "..", ".claude", "agents"),
];
function agentsDir(): string {
  return (
    AGENTS_DIR_CANDIDATES.find((d) => existsSync(d)) ?? AGENTS_DIR_CANDIDATES[0]
  );
}

/**
 * The runtime for an agent. Either a microVM/none runtime or an ACP runtime
 * string of the form "acp:<runtime>" (e.g. "acp:claude-code", "acp:gemini-cli")
 * per DESIGN §7.1 / §10.1.
 */
export type AgentRuntime = "microvm" | "none" | `acp:${string}`;

/** One phase/node-type entry in an agent def's `capability_profile` (F4). */
export interface AgentCapabilityEntry {
  /** Allowed tool names for this phase (e.g. "Read", "mcp__orchestrator"). */
  tools: string[];
  /** Advisory workspace-access label for the S9 read-only matrix (informational only). */
  workspaceAccess?: "ro" | "rw" | "none";
}

/**
 * `agent_defs.capability_profile` shape (F4 — design 02 §5.4 / docs/
 * sdlc-impl-f1-f4.md §4A): a JSON map from phase/node-type key (e.g.
 * "dispatch", "review", "develop", "qa") to its tool face. Consumed by
 * server/brain/brain-capability.ts for the `kind: "brain"` row; other rows
 * (`kind: "worker"`, e.g. vllm/claude-code) carry it as descriptive data for
 * the deferred S9 read-only matrix — nothing in the DAG dispatcher enforces it
 * yet (out of F4's scope; enforcement there is F2/engine territory).
 */
export type AgentCapabilityProfile = Record<string, AgentCapabilityEntry>;

export interface AgentConfig {
  name: string;
  description: string;
  runtime: AgentRuntime;
  engine: string;
  model: string;
  tools: string[];
  isolation?: string;
  maxSummaryTokens?: number;
  systemPrompt: string;
  /** True when the runtime is an ACP harness (runtime.startsWith("acp:")). */
  isAcp?: boolean;
  /** The ACP harness ref (e.g. "acp:claude-code") when isAcp is true. */
  acpHarnessRef?: string;
  /**
   * "worker" (default — a DAG-node-selectable agent, e.g. vllm/claude-code) or
   * "brain" (the orchestrator brain's own capability-profile row — never a
   * selectable DAG-node worker; excluded from list-agent-defs's default
   * output so it can never appear in the WorkflowEditor's agent picker). F4.
   */
  kind?: string;
  /**
   * Per-phase tool face (F4) — see {@link AgentCapabilityProfile}. Optional
   * (not every AgentConfig producer sets it — e.g. existing
   * v3-dispatcher.spec.ts fixtures predate this field) so callers must treat
   * a missing value the same as `{}`.
   */
  capabilityProfile?: AgentCapabilityProfile;
}

/**
 * Parse a `capability_profile` JSON string (DB column or `.md` frontmatter
 * value). Never throws — malformed/absent input resolves to `{}` so a caller
 * can always index `profile[phase]` safely.
 */
function parseCapabilityProfile(
  raw: string | null | undefined,
): AgentCapabilityProfile {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AgentCapabilityProfile)
      : {};
  } catch {
    return {};
  }
}

/**
 * The minimal, prompt-only agent config the dispatcher spawns with when no real
 * worker def resolves (agent not found, or the resolved row is the brain
 * capability-profile row). Single source so the two fallback paths in
 * resolveAgentConfig cannot drift. F4.
 */
export function minimalAgentConfig(name: string): AgentConfig {
  return {
    name,
    description: "",
    runtime: "none",
    engine: "",
    model: "",
    tools: [],
    systemPrompt: "",
  };
}

/**
 * F4 (design 02 §5.4): reduce a LOADED agent def to the config the dispatcher
 * should actually spawn a DAG node with. Real worker rows pass through
 * unchanged; the brain capability-profile row (`kind === "brain"`) is NEVER a
 * DAG worker, so it collapses to {@link minimalAgentConfig} — mirroring the
 * agent-not-found fallback (spawn proceeds prompt-only, WITHOUT the brain
 * row's identity). Pure — this is the unit-tested decision behind
 * V3Dispatcher.resolveAgentConfig's brain gate.
 */
export function dispatchWorkerConfig(
  loaded: AgentConfig,
  agentName: string,
): AgentConfig {
  return loaded.kind === "brain" ? minimalAgentConfig(agentName) : loaded;
}

function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    meta[key] = raw;
  }
  return { meta, body: match[2] };
}

function parseTools(raw: string): string[] {
  const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((s) => s.trim().replace(/['"]/g, ""))
    .filter(Boolean);
}

/**
 * Load an agent definition from a `.claude/agents/<name>.md` file.
 * Kept for backwards compatibility — used as the fallback when the SQL table
 * has no matching row or is unavailable.
 */
export function loadAgentFromFile(name: string): AgentConfig {
  const filePath = join(agentsDir(), `${name}.md`);
  const content = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(content);

  // Runtime is "microvm" | "none" | "acp:<harness>" (DESIGN §7.1).
  const rawRuntime = meta.runtime || "none";
  const isAcp = rawRuntime.startsWith("acp:");
  const runtime: AgentRuntime = isAcp
    ? (rawRuntime as `acp:${string}`)
    : rawRuntime === "microvm"
      ? "microvm"
      : "none";

  const maxSummaryTokens = meta.max_summary_tokens
    ? Number(meta.max_summary_tokens)
    : undefined;

  return {
    name: meta.name || name,
    description: meta.description || "",
    runtime,
    isAcp,
    acpHarnessRef: isAcp ? rawRuntime : undefined,
    engine: meta.engine || "",
    model: meta.model || "",
    tools: parseTools(meta.tools || "[]"),
    isolation: meta.isolation || undefined,
    maxSummaryTokens,
    systemPrompt: body.trim(),
    kind: meta.kind || "worker",
    capabilityProfile: parseCapabilityProfile(meta.capability_profile),
  };
}

/**
 * SQL-first agent loader with file fallback.
 *
 * Queries `orchestrator_agent_defs` by `name` (globally unique). Falls back to
 * the original file-based loader (`.claude/agents/<name>.md`) when:
 *   – DB is unavailable, or
 *   – no matching row exists.
 *
 * This is called from the V3 dispatcher queue-worker context where there is
 * no HTTP request scope, so we do a plain `eq(name)` select with no access
 * filtering (name is globally unique).
 */
export async function loadAgent(name: string): Promise<AgentConfig> {
  try {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.agentDefs)
      .where(eq(schema.agentDefs.name, name))
      .limit(1);
    if (rows.length > 0) {
      const row = rows[0] as any;
      const rawRuntime = row.runtime || "none";
      const isAcp = rawRuntime.startsWith("acp:");
      let tools: string[] = [];
      try {
        tools = JSON.parse(row.tools || "[]");
      } catch {
        tools = [];
      }
      return {
        name: row.name,
        description: row.description || "",
        runtime: isAcp
          ? rawRuntime
          : rawRuntime === "microvm"
            ? "microvm"
            : "none",
        isAcp,
        acpHarnessRef: isAcp ? rawRuntime : undefined,
        engine: row.engine || "",
        model: row.model || "",
        tools,
        systemPrompt: row.systemPrompt || "",
        kind: row.kind || "worker",
        capabilityProfile: parseCapabilityProfile(row.capabilityProfile),
      };
    }
  } catch {
    // DB unavailable or query failed — fall back to file-based agent defs.
  }
  return loadAgentFromFile(name);
}
