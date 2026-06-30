/**
 * @deprecated Use `v3-workflow` action `workflow.save` instead.
 * This V1 action is retained for backward compatibility only.
 */
import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { parseSteps, validateWorkflowDag } from "../shared/types.js";

const stepSchema = z.object({
  key: z.string(),
  title: z.string(),
  assignee: z.string().default("local"),
  engine: z.string().optional(),
  model: z.string().optional(),
  prompt: z.string().default(""),
  dependsOn: z.array(z.string()).default([]),
});

// Create (no id) or update (id given) a workflow. Validates the DAG so an
// unrunnable graph (cycle / dup key) is rejected before it can be executed.
export default defineAction({
  description:
    "Create or update a workflow (a DAG of sub-agent steps). Pass `id` to update.",
  schema: z.object({
    id: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    steps: z
      .union([z.string(), z.array(stepSchema)])
      .optional()
      .describe("WorkflowStep[] or JSON string of the same"),
  }),
  run: async (args) => {
    const rawSteps =
      typeof args.steps === "string" ? args.steps : JSON.stringify(args.steps ?? []);
    const steps = parseSteps(rawSteps);
    const dag = validateWorkflowDag(steps);
    if (!dag.ok) throw new Error(`Invalid workflow: ${dag.error}`);

    const db = getDb();
    const now = nowIso();

    if (args.id) {
      const access = await resolveAccess("workflow", args.id);
      if (!access) throw new Error(`Workflow ${args.id} not found`);
      if (access.role === "viewer") throw new Error("Read-only access");
      await db
        .update(schema.workflows)
        .set({
          name: args.name,
          description: args.description ?? "",
          steps: JSON.stringify(steps),
          updatedAt: now,
        })
        .where(eq(schema.workflows.id, args.id));
      return { id: args.id, ok: true };
    }

    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const id = newId("wf");
    await db.insert(schema.workflows).values({
      id,
      name: args.name,
      description: args.description ?? "",
      steps: JSON.stringify(steps),
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
    return { id, ok: true };
  },
});
