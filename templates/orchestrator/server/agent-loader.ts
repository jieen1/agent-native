import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "..", ".claude", "agents");

export interface AgentConfig {
  name: string;
  description: string;
  runtime: "microvm" | "none";
  engine: string;
  model: string;
  tools: string[];
  isolation?: string;
  maxSummaryTokens?: number;
  systemPrompt: string;
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
  const filePath = join(AGENTS_DIR, `${name}.md`);
  const content = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(content);

  const runtime = (meta.runtime || "none") as "microvm" | "none";
  const maxSummaryTokens = meta.max_summary_tokens
    ? Number(meta.max_summary_tokens)
    : undefined;

  return {
    name: meta.name || name,
    description: meta.description || "",
    runtime,
    engine: meta.engine || "",
    model: meta.model || "",
    tools: parseTools(meta.tools || "[]"),
    isolation: meta.isolation || undefined,
    maxSummaryTokens,
    systemPrompt: body.trim(),
  };
}
