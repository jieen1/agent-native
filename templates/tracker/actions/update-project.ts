import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

export default defineAction({
  description:
    "Update mutable fields on a project (name, description, git remote, default branch).",
  schema: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    gitRemote: z.string().optional(),
    defaultBranch: z.string().optional(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const existing = (
      await db
        .select()
        .from(schema.projects)
        .where(
          and(eq(schema.projects.id, args.id), ownerScope(schema.projects)),
        )
        .limit(1)
    )[0];
    if (!existing) throw new Error("Project not found");

    const now = new Date().toISOString();
    const patch: Partial<typeof schema.projects.$inferInsert> = {
      updatedAt: now,
    };

    if (args.name !== undefined) patch.name = args.name;
    if (args.description !== undefined) patch.description = args.description;
    if (args.gitRemote !== undefined) patch.gitRemote = args.gitRemote;
    if (args.defaultBranch !== undefined)
      patch.defaultBranch = args.defaultBranch;

    if (Object.keys(patch).length === 1) {
      throw new Error("No fields provided to update");
    }

    await db
      .update(schema.projects)
      .set(patch)
      .where(and(eq(schema.projects.id, args.id), ownerScope(schema.projects)));

    const updated = (
      await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, args.id))
        .limit(1)
    )[0];

    return updated;
  },
});
