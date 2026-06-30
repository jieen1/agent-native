import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";

// Dispatch a work item to the orchestrator's CC brain. Sends a STRUCTURED MCP
// `tools/call` for `brain-send` with the requirement + the project's repo/branch
// context + tracker tags. The brain provisions a workspace, decomposes (CC
// analyze, vLLM develop, CC review), monitors, then commits/pushes a PR. We
// store the returned threadId and set the item to `dispatched`.
export default defineAction({
  description:
    "Dispatch a work item to the orchestrator brain for autonomous execution. " +
    "Carries the work item's requirement plus the project's repo/branch and " +
    "tracker tags, returns the brain threadId, and marks the item dispatched.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to dispatch"),
    monitorIntervalSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Periodic drift-check cadence (seconds) for the orchestrator brain " +
          "monitor. Omit → server default (120); 0 → event-only (no timer wakes).",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const project = (
      await db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, item.projectId))
        .limit(1)
    )[0];
    if (!project) throw new Error("Owning project not found");
    if (!project.gitRemote) {
      throw new Error(
        "Project has no git remote configured — set one on the project before dispatching.",
      );
    }

    const tags = { source: "tracker", item_id: item.id };

    const requirement = item.description?.trim() || item.title;
    const message =
      `Work item ${item.id} (${project.key}) — "${item.title}".\n\n` +
      `Requirement:\n${requirement}\n\n` +
      `Work in the checked-out workspace. Follow the orchestrating-v3 skill: ` +
      `decompose as needed (CC analyze, vLLM develop, CC review), monitor by ` +
      `polling, then workspaceCommitPush to open a PR. When done, report the ` +
      `run id and the PR url.`;

    // brain-send (additive `tags` param) instructs the brain to attach these
    // tags to every workflowRun/workspaceCreate/spawnOnce so the activity is
    // reassemblable via runsList/spawnList { tagMatch }.
    const { data } = await callOrchestratorTool(ownerEmail, "brain-send", {
      message,
      repo: project.gitRemote,
      baseBranch: project.defaultBranch || "main",
      tags,
      // Forward the configurable periodic drift-check cadence. Undefined lets
      // the orchestrator apply its env default (BRAIN_MONITOR_INTERVAL_SEC).
      ...(args.monitorIntervalSec !== undefined
        ? { monitorIntervalSec: args.monitorIntervalSec }
        : {}),
    });

    const result = data as { threadId?: string; workspaceId?: string | null };
    const threadId = result?.threadId;
    if (!threadId) {
      throw new Error(
        `Dispatch reached the orchestrator but no threadId was returned: ${JSON.stringify(
          data,
        ).slice(0, 300)}`,
      );
    }

    const now = new Date().toISOString();
    await db
      .update(schema.workItems)
      .set({
        status: "dispatched",
        orchestratorThreadId: threadId,
        orchestratorWorkspaceId: result.workspaceId ?? null,
        dispatchedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.workItems.id, item.id));

    return {
      workItemId: item.id,
      threadId,
      workspaceId: result.workspaceId ?? null,
      status: "dispatched",
      dispatchedAt: now,
      monitorIntervalSec: args.monitorIntervalSec ?? null,
      tags,
    };
  },
});
