import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const BUILTIN_AGENTS = [
  {
    name: "vllm",
    engine: "vllm",
    model: "qwen3.6",
    tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    runtime: "none",
    description: "General agent running on the local vLLM / OpenAI-compatible engine.",
    systemPrompt: "You are a capable software agent. Complete the task described in the prompt\ndirectly. Use the available tools as needed and give a concise summary of the\nconcrete result when done.",
  },
  {
    name: "claude-code",
    engine: "claude-code",
    model: "claude-sonnet-4-6",
    tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    runtime: "acp:claude-code",
    description: "General coding/reasoning agent powered by the connected Claude Code subscription.",
    systemPrompt: "You are a capable software agent running as Claude Code with full access to your\nnative tools. Complete the task described in the prompt directly and concretely:\nread and edit code, run commands, and verify your work as needed. When finished,\ngive a concise summary of what you did and the concrete result.",
  },
];

export default async function agentDefsSeedPlugin(): Promise<void> {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    for (const def of BUILTIN_AGENTS) {
      const existing = await db
        .select()
        .from(schema.agentDefs)
        .where(eq(schema.agentDefs.name, def.name))
        .limit(1);
      if (existing.length > 0) continue; // already exists — don't overwrite

      await db.insert(schema.agentDefs).values({
        id: `agdef_${def.name}`,
        name: def.name,
        engine: def.engine,
        model: def.model,
        tools: JSON.stringify(def.tools),
        systemPrompt: def.systemPrompt,
        description: def.description,
        runtime: def.runtime,
        builtin: 1,
        version: 1,
        createdAt: now,
        updatedAt: now,
        ownerEmail: "local@localhost",
        orgId: null,
        visibility: "private",
      });
    }
  } catch {
    // best-effort seed; DB not ready yet is not fatal at boot
  }
}