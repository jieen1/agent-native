import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

const repoFieldsSchema = z.object({
  name: z.string().min(1).describe("Short repo name, unique within the project"),
  gitRemote: z.string().optional().describe("Git remote URL"),
  baseBranch: z.string().optional().describe("Base branch (default: main)"),
  testCmdUnit: z.string().optional().describe("Unit test command"),
  testCmdFull: z.string().optional().describe("Full test command"),
  e2eTestPath: z.string().optional().describe("E2E test path"),
  integrationTestPath: z.string().optional().describe("Integration test path"),
  buildTool: z.string().optional().describe("Build tool (e.g. npm, pnpm, gradle)"),
  ciMode: z.enum(["none", "github"]).optional().describe("CI mode (default: none)"),
  gateMode: z
    .enum(["tests-only", "stack", "none"])
    .optional()
    .describe("Gate mode (default: tests-only)"),
  devModel: z.string().optional().describe("Optional model override for agent work"),
});

export default defineAction({
  description:
    "Manage code repositories registered to a tracker project. " +
    "op=list returns all repos; op=add registers a new repo (name must be unique per project); " +
    "op=update patches fields on an existing repo by name; op=remove hard-deletes a repo by name.",
  schema: z.object({
    projectId: z.string().min(1).describe("Project id"),
    op: z.enum(["list", "add", "update", "remove"]).describe("Operation"),
    repo: repoFieldsSchema
      .extend({
        // For update/remove we need to identify the repo by name.
        name: z.string().min(1),
      })
      .optional()
      .describe("Repo data (required for add/update/remove)"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();

    // Verify the project belongs to the current user/org.
    const project = (
      await db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, args.projectId),
            ownerScope(schema.projects),
          ),
        )
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or access denied");

    switch (args.op) {
      case "list": {
        const rows = await db
          .select()
          .from(schema.projectRepos)
          .where(
            and(
              eq(schema.projectRepos.projectId, args.projectId),
              ownerScope(schema.projectRepos),
            ),
          );
        return rows;
      }

      case "add": {
        if (!args.repo) throw new Error("repo is required for op=add");
        const { name } = args.repo;

        // Enforce uniqueness of name within project+owner scope.
        const existing = (
          await db
            .select()
            .from(schema.projectRepos)
            .where(
              and(
                eq(schema.projectRepos.projectId, args.projectId),
                eq(schema.projectRepos.name, name),
                ownerScope(schema.projectRepos),
              ),
            )
            .limit(1)
        )[0];
        if (existing) throw new Error(`仓库名 "${name}" 在项目中已存在`);

        const id = nanoid();
        const now = new Date().toISOString();
        const row = {
          id,
          projectId: args.projectId,
          name: name.trim(),
          gitRemote: args.repo.gitRemote?.trim() ?? "",
          baseBranch: args.repo.baseBranch?.trim() || "main",
          testCmdUnit: args.repo.testCmdUnit?.trim() ?? "",
          testCmdFull: args.repo.testCmdFull?.trim() ?? "",
          e2eTestPath: args.repo.e2eTestPath?.trim() ?? "",
          integrationTestPath: args.repo.integrationTestPath?.trim() ?? "",
          buildTool: args.repo.buildTool?.trim() ?? "",
          ciMode: args.repo.ciMode ?? "none",
          gateMode: args.repo.gateMode ?? "tests-only",
          devModel: args.repo.devModel?.trim() ?? null,
          createdAt: now,
          updatedAt: now,
          ownerEmail,
          orgId,
          visibility: "private" as const,
        };

        await db.insert(schema.projectRepos).values(row);
        return row;
      }

      case "update": {
        if (!args.repo) throw new Error("repo is required for op=update");
        const { name } = args.repo;

        const target = (
          await db
            .select()
            .from(schema.projectRepos)
            .where(
              and(
                eq(schema.projectRepos.projectId, args.projectId),
                eq(schema.projectRepos.name, name),
                ownerScope(schema.projectRepos),
              ),
            )
            .limit(1)
        )[0];
        if (!target) throw new Error(`仓库 "${name}" 不存在`);

        const now = new Date().toISOString();
        const patch: Partial<typeof schema.projectRepos.$inferInsert> = {
          updatedAt: now,
        };

        if (args.repo.gitRemote !== undefined) patch.gitRemote = args.repo.gitRemote;
        if (args.repo.baseBranch !== undefined) patch.baseBranch = args.repo.baseBranch || "main";
        if (args.repo.testCmdUnit !== undefined) patch.testCmdUnit = args.repo.testCmdUnit;
        if (args.repo.testCmdFull !== undefined) patch.testCmdFull = args.repo.testCmdFull;
        if (args.repo.e2eTestPath !== undefined) patch.e2eTestPath = args.repo.e2eTestPath;
        if (args.repo.integrationTestPath !== undefined)
          patch.integrationTestPath = args.repo.integrationTestPath;
        if (args.repo.buildTool !== undefined) patch.buildTool = args.repo.buildTool;
        if (args.repo.ciMode !== undefined) patch.ciMode = args.repo.ciMode;
        if (args.repo.gateMode !== undefined) patch.gateMode = args.repo.gateMode;
        if (args.repo.devModel !== undefined) patch.devModel = args.repo.devModel || null;

        await db
          .update(schema.projectRepos)
          .set(patch)
          .where(
            and(
              eq(schema.projectRepos.id, target.id),
              ownerScope(schema.projectRepos),
            ),
          );

        const updated = (
          await db
            .select()
            .from(schema.projectRepos)
            .where(eq(schema.projectRepos.id, target.id))
            .limit(1)
        )[0];
        return updated;
      }

      case "remove": {
        if (!args.repo) throw new Error("repo is required for op=remove");
        const { name } = args.repo;

        const target = (
          await db
            .select()
            .from(schema.projectRepos)
            .where(
              and(
                eq(schema.projectRepos.projectId, args.projectId),
                eq(schema.projectRepos.name, name),
                ownerScope(schema.projectRepos),
              ),
            )
            .limit(1)
        )[0];
        if (!target) throw new Error(`仓库 "${name}" 不存在`);

        await db
          .delete(schema.projectRepos)
          .where(
            and(
              eq(schema.projectRepos.id, target.id),
              ownerScope(schema.projectRepos),
            ),
          );

        return { deleted: true, id: target.id, name };
      }

      default:
        throw new Error(`Unknown op: ${args.op}`);
    }
  },
});
