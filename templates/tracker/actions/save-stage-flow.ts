import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { safeParseFlows } from "../shared/stage-vocabulary.js";
import type { StageFlow } from "../shared/types.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// Create or update a named, reusable stage flow: an ordered list of stage
// names plus the workflow template to dispatch for each stage. Stored in the
// project's stageFlows JSON array column (new, additive). Existing work
// items are never touched — plannedStages is snapshotted at creation time by
// create-work-item.ts and is never re-read from here.
export default defineAction({
  description:
    "Create or update a reusable stage flow (ordered stage names + per-stage " +
    "dispatch templates) on a project. Pass `id` to update an existing flow; " +
    "omit it to create a new one.",
  schema: z.object({
    projectId: z.string().min(1),
    id: z
      .string()
      .optional()
      .describe("Existing flow id to update; omit to create"),
    name: z.string().min(1).describe("Flow display name"),
    stageNames: z
      .array(z.string().min(1))
      .min(1)
      .describe(
        "Ordered stage names — becomes plannedStages for items assigned this flow",
      ),
    dispatchTemplates: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Per-stage-name workflow template to dispatch, e.g. {"实施":"sdlc-dev"}',
      ),
  }),
  http: { method: "POST" },
  run: async (args): Promise<StageFlow> => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const project = (
      await db
        .select({
          id: schema.projects.id,
          stageFlows: schema.projects.stageFlows,
        })
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, args.projectId),
            ownerScope(schema.projects),
          ),
        )
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or not accessible");

    const flows = safeParseFlows(project.stageFlows);
    const flow: StageFlow = {
      id: args.id || nanoid(),
      name: args.name.trim(),
      stageNames: args.stageNames,
      dispatchTemplates: args.dispatchTemplates ?? {},
    };

    const idx = flows.findIndex((f) => f.id === flow.id);
    if (idx >= 0) {
      // Preserve dispatchTemplates entries for stages not present in the
      // patch, so a partial dispatchTemplates update (e.g. from the per-stage
      // select in the UI) doesn't clobber the rest.
      flow.dispatchTemplates = {
        ...flows[idx]!.dispatchTemplates,
        ...(args.dispatchTemplates ?? {}),
      };
      flows[idx] = flow;
    } else {
      flows.push(flow);
    }

    const now = new Date().toISOString();
    await db
      .update(schema.projects)
      .set({ stageFlows: JSON.stringify(flows), updatedAt: now })
      .where(
        and(
          eq(schema.projects.id, args.projectId),
          ownerScope(schema.projects),
        ),
      );

    return flow;
  },
});
