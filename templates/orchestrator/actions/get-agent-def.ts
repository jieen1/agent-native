import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
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

// Get a single agent definition by id or name.
export default defineAction({
  description:
    "Get a single agent definition by id or name (DESIGN §7). Returns { id, name, engine, model, tools, description, runtime, builtin, version, systemPrompt, createdAt, updatedAt, kind, capabilityProfile }. " +
    'Unlike list-agent-defs, this always returns the row regardless of `kind` — fetching the "brain" row (design 02 §5.4 F4 capability matrix) by explicit name is intentional here.',
  schema: z
    .object({
      id: z.string().optional(),
      name: z.string().optional(),
    })
    .refine((v) => !!v.id || !!v.name, {
      message: "Provide id or name",
    }),
  run: async (args) => {
    const db = getDb();

    // If name is given but not id, resolve name -> id first
    let id = args.id;
    if (!id && args.name) {
      const byName = await db
        .select({ id: schema.agentDefs.id })
        .from(schema.agentDefs)
        .where(eq(schema.agentDefs.name, args.name))
        .limit(1);
      if (byName.length === 0)
        throw new Error(`Agent '${args.name}' not found`);
      id = byName[0].id;
    }
    if (!id) throw new Error("Agent not found");

    const access = await resolveAccess("agent_def", id);
    if (!access) throw new Error(`Agent ${id} not found`);

    const r = access.resource as any;
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
    };
  },
});
