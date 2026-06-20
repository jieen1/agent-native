import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { nowIso } from "./_util.js";

// Patch-style project update. Any of: name/description/workingDir/repo/
// defaultWorkflowId/environments/statusSchemes. Owner/editor-scoped.
export default defineAction({
  description:
    "Update a project. Patch any of: name, description, workingDir, gitRemote, defaultBranch, defaultWorkflowId, environments, statusSchemes.",
  schema: z.object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    workingDir: z.string().optional(),
    gitRemote: z.string().nullable().optional(),
    defaultBranch: z.string().nullable().optional(),
    defaultWorkflowId: z.string().nullable().optional(),
    environments: z.array(z.string()).nullable().optional(),
    statusSchemes: z.record(z.string(), z.unknown()).nullable().optional(),
  }),
  run: async (args) => {
    const access = await resolveAccess("project", args.id);
    if (!access) throw new Error(`Project ${args.id} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const patch: Record<string, unknown> = { updatedAt: nowIso() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    if (args.workingDir !== undefined) patch.workingDir = args.workingDir;
    if (args.gitRemote !== undefined) patch.gitRemote = args.gitRemote;
    if (args.defaultBranch !== undefined)
      patch.defaultBranch = args.defaultBranch;
    if (args.defaultWorkflowId !== undefined)
      patch.defaultWorkflowId = args.defaultWorkflowId;
    if (args.environments !== undefined) {
      patch.environments = args.environments
        ? JSON.stringify(args.environments)
        : null;
    }
    if (args.statusSchemes !== undefined) {
      patch.statusSchemes = args.statusSchemes
        ? JSON.stringify(args.statusSchemes)
        : null;
    }

    const db = getDb();
    await db
      .update(schema.projects)
      .set(patch)
      .where(eq(schema.projects.id, args.id));
    return { id: args.id, ok: true };
  },
});
