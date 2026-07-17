import { defineAction } from "@agent-native/core";
import { accessFilter, resolveAccess } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

function parseCapabilityProfile(
  raw: string | null | undefined,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * Mirrors the write-eligibility decision `save-agent-def.ts` / `delete-agent-def.ts`
 * make for a row: builtin rows are never editable, otherwise the current user
 * needs at least an `editor` share role (or ownership) via `resolveAccess`.
 */
async function computeCanEdit(row: {
  id: string;
  builtin: number;
}): Promise<boolean> {
  if (row.builtin !== 0) return false;
  const access = await resolveAccess("agent_def", row.id);
  return !!access && access.role !== "viewer";
}

// List agent definitions (DESIGN §7), newest first.
export default defineAction({
  description:
    "List worker agent definitions (agent_defs, DESIGN §7), newest first. Each entry has { id, name, engine, model, tools (parsed array), description, runtime, builtin, version, systemPrompt, createdAt, updatedAt, kind, capabilityProfile, ownerEmail, canEdit }. " +
    'By default only kind="worker" rows are returned (DAG-node-selectable agents like vllm/claude-code) — pass includeBrain:true to also see the kind="brain" row (the orchestrator brain\'s own F4 capability-profile row, design 02 §5.4), which is never a valid DAG-node `agent` value. ' +
    'This is an application-level shared registry (`visibility="public"` rows are visible to every account, not just the owner) — `canEdit` tells the caller whether THEY can save/delete a given row (false for builtin rows and rows owned by someone else).',
  schema: z.object({
    includeBrain: z.boolean().optional().default(false),
  }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const db = getDb();
    const filters = [
      accessFilter(
        schema.agentDefs,
        schema.agentDefShares,
        undefined,
        "viewer",
        { includePublic: true },
      ),
    ];
    if (!args.includeBrain) {
      filters.push(eq(schema.agentDefs.kind, "worker"));
    }
    const rows = await db
      .select()
      .from(schema.agentDefs)
      .where(and(...filters))
      .orderBy(desc(schema.agentDefs.updatedAt));
    return Promise.all(
      rows.map(async (r) => {
        let tools: string[] = [];
        try {
          tools = JSON.parse(r.tools || "[]");
        } catch {
          tools = [];
        }
        return {
          id: r.id,
          name: r.name,
          engine: r.engine,
          model: r.model,
          tools,
          description: r.description,
          runtime: r.runtime,
          builtin: Boolean(r.builtin),
          version: r.version,
          systemPrompt: r.systemPrompt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          kind: r.kind || "worker",
          capabilityProfile: parseCapabilityProfile(r.capabilityProfile),
          ownerEmail: r.ownerEmail,
          canEdit: await computeCanEdit(r),
        };
      }),
    );
  },
});
