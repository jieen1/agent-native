import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { parseGraph } from "../shared/types.js";

export default defineAction({
  description: "Get a single v2 workflow template with its parsed graph.",
  schema: z.object({ id: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow_template", args.id);
    if (!access) throw new Error(`Template ${args.id} not found`);
    const t = access.resource as Record<string, unknown>;
    if (t.deletedAt) throw new Error(`Template ${args.id} not found`);
    return {
      id: String(t.id),
      name: String(t.name),
      description: String(t.description ?? ""),
      version: Number(t.version ?? 1),
      graph: parseGraph(t.graph),
      role: access.role,
    };
  },
});
