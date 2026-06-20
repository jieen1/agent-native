import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";

// Create a project (DESIGN §6.1 / §9). `workingDir` is the deliverable root and
// is always set (defaults to the project key). A git repo (`gitRemote` +
// `defaultBranch`) is set only for code work. `statusSchemes`/`environments`
// are optional JSON overrides of the default per-type schemes / env list.
export default defineAction({
  description:
    "Create a project: a named container for work items with an id-prefix `key` and a `workingDir` deliverable root. Optionally link a git repo (gitRemote/defaultBranch) for code work, set a defaultWorkflowId, override status schemes, or set environments.",
  schema: z.object({
    name: z.string().describe("Project name"),
    key: z.string().describe("Id prefix for work items, e.g. 'PAY' → PAY-14"),
    description: z.string().optional(),
    workingDir: z
      .string()
      .optional()
      .describe("Deliverable/artifact root; defaults to the project key"),
    gitRemote: z.string().optional().describe("Set only for code projects"),
    defaultBranch: z.string().optional(),
    defaultWorkflowId: z.string().optional(),
    environments: z
      .array(z.string())
      .optional()
      .describe("Env list; default dev/SIT/UAT/prod"),
    statusSchemes: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Per-type status-scheme override (defaults applied otherwise)"),
  }),
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();
    const db = getDb();
    const now = nowIso();
    const id = newId("proj");
    const key = args.key.trim();
    if (!key) throw new Error("Project key is required");

    await db.insert(schema.projects).values({
      id,
      name: args.name.trim() || "Untitled project",
      key,
      description: args.description?.trim() ?? "",
      workingDir: args.workingDir?.trim() || key,
      gitRemote: args.gitRemote?.trim() || null,
      defaultBranch: args.defaultBranch?.trim() || null,
      defaultWorkflowId: args.defaultWorkflowId ?? null,
      statusSchemes: args.statusSchemes
        ? JSON.stringify(args.statusSchemes)
        : null,
      environments: args.environments
        ? JSON.stringify(args.environments)
        : null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, name: args.name, key };
  },
});
