import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

function deriveKey(name: string): string {
  const letters = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (letters.length === 0) return "PRJ";
  if (letters.length === 1) return letters[0]!.slice(0, 4);
  return letters
    .map((w) => w[0])
    .join("")
    .slice(0, 4);
}

export default defineAction({
  description:
    "Create a tracker project. The git remote and default branch are configured " +
    "ONCE here and carried on every work item dispatched to the orchestrator.",
  schema: z.object({
    name: z.string().min(1).describe("Project name"),
    key: z
      .string()
      .optional()
      .describe(
        "Short id prefix (e.g. PAY). Auto-derived from name if omitted.",
      ),
    description: z.string().optional().describe("Project description"),
    gitRemote: z
      .string()
      .optional()
      .describe(
        "Git remote URL the orchestrator clones, e.g. https://github.com/org/repo.git",
      ),
    defaultBranch: z
      .string()
      .optional()
      .describe(
        "Default base branch the orchestrator cuts from (default main)",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    const id = nanoid();
    const now = new Date().toISOString();
    const name = args.name.trim();
    const key = (args.key?.trim() || deriveKey(name)).toUpperCase();

    const db = getDb();
    await db.insert(schema.projects).values({
      id,
      key,
      name,
      description: args.description?.trim() ?? "",
      gitRemote: args.gitRemote?.trim() ?? "",
      defaultBranch: args.defaultBranch?.trim() || "main",
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id,
      key,
      name,
      description: args.description?.trim() ?? "",
      gitRemote: args.gitRemote?.trim() ?? "",
      defaultBranch: args.defaultBranch?.trim() || "main",
      createdAt: now,
      updatedAt: now,
    };
  },
});
