import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";

const BUILTIN_AGENTS = [
  {
    name: "vllm",
    engine: "vllm",
    model: "qwen3.6",
    tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    runtime: "none",
    description:
      "General agent running on the local vLLM / OpenAI-compatible engine.",
    systemPrompt:
      "You are a capable software agent. Complete the task described in the prompt\ndirectly. Use the available tools as needed and give a concise summary of the\nconcrete result when done.",
    kind: "worker",
    // F4 capability matrix (design 02 §5.4) — descriptive only; the DAG
    // dispatcher does not yet enforce per-phase tool faces for worker rows
    // (out of scope, F2/engine territory). Reflects the CURRENT (unrestricted)
    // develop/qa tool face for the deferred S9 read-only matrix.
    capabilityProfile: {
      develop: {
        tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        workspaceAccess: "rw",
      },
      qa: {
        tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        workspaceAccess: "rw",
      },
    },
  },
  {
    name: "claude-code",
    engine: "claude-code",
    model: "claude-sonnet-4-6",
    tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    runtime: "acp:claude-code",
    description:
      "General coding/reasoning agent powered by the connected Claude Code subscription.",
    systemPrompt:
      "You are a capable software agent running as Claude Code with full access to your\nnative tools. Complete the task described in the prompt directly and concretely:\nread and edit code, run commands, and verify your work as needed. When finished,\ngive a concise summary of what you did and the concrete result.",
    kind: "worker",
    // Descriptive only (see vllm's note above). "review" reflects 02 §5.4's
    // reviewer/gatekeeper row: read-only + test execution, no Edit/Write.
    capabilityProfile: {
      develop: {
        tools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
        workspaceAccess: "rw",
      },
      review: {
        tools: ["Read", "Glob", "Grep", "Bash"],
        workspaceAccess: "ro",
      },
    },
  },
  {
    // F4 (docs/sdlc-impl-f1-f4.md §4A / design 02 §5.4) — the orchestrator
    // BRAIN's own capability-profile row. `kind: "brain"` (not "worker") so
    // this NEVER appears in list-agent-defs's default (worker-only) output —
    // it must not be selectable as a DAG-node `agent` in the WorkflowEditor.
    // engine/model/tools/systemPrompt/runtime are left at their defaults
    // (empty/"none") because brain-session.ts does NOT dispatch through the
    // generic worker-spawn path this row would otherwise describe — it reads
    // ONLY `capabilityProfile` (via server/brain/brain-capability.ts) to
    // assemble its own CLI --allowedTools per phase. The brain's engine
    // (raw `claude` spawn or the gated ACP harness) and system prompt
    // (BRAIN_PROMPT) remain defined in server/brain/brain-session.ts /
    // brain-prompt.ts, unrelated to this row.
    name: "brain",
    engine: "",
    model: "",
    tools: [],
    runtime: "none",
    description:
      "The orchestrator brain itself — dispatches/monitors DAG runs and " +
      "independently reviews their results (design 02 §3). Not a DAG-node " +
      "worker; excluded from list-agent-defs's default output.",
    systemPrompt: "",
    kind: "brain",
    capabilityProfile: {
      dispatch: {
        tools: ["mcp__orchestrator", "Read", "Grep", "Glob"],
        workspaceAccess: "ro",
      },
      review: {
        tools: ["mcp__orchestrator", "Read", "Grep", "Glob"],
        workspaceAccess: "ro",
      },
    },
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
        kind: def.kind,
        capabilityProfile: JSON.stringify(def.capabilityProfile ?? {}),
        ownerEmail: "local@localhost",
        orgId: null,
        visibility: "private",
      });
    }
  } catch {
    // best-effort seed; DB not ready yet is not fatal at boot
  }
}
