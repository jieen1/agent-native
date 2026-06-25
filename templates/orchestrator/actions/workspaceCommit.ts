// Commit + push a local workspace and (optionally) open a PR. The actual
// git/MR mechanics + ephemeral GITHUB_TOKEN handling (DESIGN §13) live in
// server/v3-workspace-local.ts; this is the thin MCP/HTTP surface the
// orchestrator brain (or a commit node) calls after review.
import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { commitAndPush } from "../server/v3-workspace-local.js";

export default defineAction({
  description:
    "Commit all changes in a local workspace, push its branch, and optionally " +
    "open a pull request. Uses the vault GITHUB_TOKEN ephemerally (never persisted).",
  schema: z.object({
    workspaceId: z.string(),
    message: z.string(),
    createMr: z.boolean().optional().default(false),
    prTitle: z.string().optional(),
    prBody: z.string().optional(),
    baseBranch: z.string().optional(),
  }),
  run: async (args) => {
    return await commitAndPush({
      id: args.workspaceId,
      message: args.message,
      createMr: args.createMr,
      prTitle: args.prTitle,
      prBody: args.prBody,
      baseBranch: args.baseBranch,
    });
  },
});
