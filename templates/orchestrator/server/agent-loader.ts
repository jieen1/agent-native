import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
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
  return inner.split(",").map((s) => s.trim().replace(/['"]/g, "")).filter(Boolean);
}

export function loadAgent(name: string): AgentConfig {
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
  };
}
