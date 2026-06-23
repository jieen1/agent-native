/**
 * @deprecated Use `v3-workflow` action `workflow.get` instead.
 * This V1 action is retained for backward compatibility only.
 */
import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { parseSteps, type Workflow } from "../shared/types.js";

export default defineAction({
  description: "Get a single workflow with its full step DAG.",
  schema: z.object({ id: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("workflow", args.id);
    if (!access) throw new Error(`Workflow ${args.id} not found`);
    const wf = access.resource as Record<string, unknown>;
    const workflow: Workflow = {
      id: String(wf.id),
      name: String(wf.name),
      description: String(wf.description ?? ""),
      steps: parseSteps(wf.steps),
      createdAt: String(wf.createdAt),
      updatedAt: String(wf.updatedAt),
    };
    return { workflow, role: access.role };
  },
});
