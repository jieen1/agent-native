import { defineAction } from "@agent-native/core";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// List agent definitions (DESIGN §7), newest first.
export default defineAction({
  description:
    "List worker agent definitions (agent_defs, DESIGN §7), newest first. Each entry has { id, name, engine, model, tools (parsed array), description, runtime, builtin, version, systemPrompt, createdAt, updatedAt }.",
  schema: z.object({}),
  http: { method: "GET" },
  readOnly: true,
  run: async () => {
    const db = getDb();
    const rows = await db
      .select()
      .from(schema.agentDefs)
      .where(accessFilter(schema.agentDefs, schema.agentDefShares))
      .orderBy(desc(schema.agentDefs.updatedAt));
    return rows.map((r) => {
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
      };
    });
  },
});