import { defineAction } from "@agent-native/core";
import { getRequestUserEmail, getRequestOrgId } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";

// Stages that are "before implementation" — dispatch should advance past these.
const PRE_IMPL_STAGES = new Set(["待办", "分析", "设计"]);
const IMPL_STAGE = "实施";

// Upsert the 实施 stage row for a work item, setting it to 执行中.
async function upsertImplStage(
  db: ReturnType<typeof getDb>,
  workItemId: string,
  ownerEmail: string,
  orgId: string | null,
  now: string,
): Promise<void> {
  const existing = (
    await db
      .select()
      .from(schema.stages)
      .where(
        and(
          eq(schema.stages.workItemId, workItemId),
          eq(schema.stages.stageName, IMPL_STAGE),
        ),
      )
      .limit(1)
  )[0];

  if (existing) {
    await db
      .update(schema.stages)
      .set({ stageStatus: "执行中", startedAt: now, updatedAt: now })
      .where(eq(schema.stages.id, existing.id));
  } else {
    await db.insert(schema.stages).values({
      id: `stage_${workItemId.slice(0, 6)}_impl_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId,
      stageName: IMPL_STAGE,
      stageStatus: "执行中",
      deliveryItems: "[]",
      verdict: null,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });
  }
}

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
    const orgId = getRequestOrgId() ?? null;

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

    // Advance to 实施 if still in a pre-implementation stage (待办/分析/设计).
    // Never roll back a stage that is already at 实施 or beyond.
    const shouldAdvanceToImpl = PRE_IMPL_STAGES.has(item.currentStageName ?? "待办");
    const newStageName = shouldAdvanceToImpl ? IMPL_STAGE : item.currentStageName;

    await db
      .update(schema.workItems)
      .set({
        status: "dispatched",
        orchestratorThreadId: threadId,
        orchestratorWorkspaceId: result.workspaceId ?? null,
        dispatchedAt: now,
        updatedAt: now,
        ...(shouldAdvanceToImpl ? { currentStageName: IMPL_STAGE } : {}),
      })
      .where(eq(schema.workItems.id, item.id));

    // Upsert the 实施 stage row so the board shows it as 执行中.
    if (shouldAdvanceToImpl) {
      await upsertImplStage(db, item.id, ownerEmail, orgId, now);
    }

    return {
      workItemId: item.id,
      threadId,
      workspaceId: result.workspaceId ?? null,
      status: "dispatched",
      currentStageName: newStageName,
      stagedAdvanced: shouldAdvanceToImpl,
      dispatchedAt: now,
      monitorIntervalSec: args.monitorIntervalSec ?? null,
      tags,
    };
  },
});
