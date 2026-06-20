import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { schemeForType } from "../server/work-items/schemes.js";
import { initialStage } from "../shared/status-schemes.js";

// Create a work item under a project (DESIGN §6.2 / §9). The business status is
// initialized to the type scheme's first `todo` stage with statusCategory
// 'todo'; thereafter status moves ONLY through transition-work-item. An initial
// status-log row (from=null → to=initialStage) records creation.
export default defineAction({
  description:
    "Create a work item (requirement|bug|prod-issue|task) under a project. Sets the initial business status to the type's first stage; further status changes go ONLY through transition-work-item. Optionally pre-pick a workflowId, severity, assignee, or priority.",
  schema: z.object({
    projectId: z.string(),
    type: z
      .enum(["requirement", "bug", "prod-issue", "task"])
      .default("task")
      .optional(),
    title: z.string(),
    description: z.string().optional(),
    priority: z.coerce.number().int().optional(),
    assignee: z.string().optional(),
    severity: z.enum(["SEV1", "SEV2", "SEV3", "SEV4"]).optional(),
    workflowId: z.string().optional(),
  }),
  run: async (args) => {
    // Must have write access to the parent project to add a work item to it.
    const projectAccess = await resolveAccess("project", args.projectId);
    if (!projectAccess) throw new Error(`Project ${args.projectId} not found`);
    if (projectAccess.role === "viewer")
      throw new Error("Read-only access to project");
    const project = projectAccess.resource as Record<string, unknown>;

    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId();

    const type = args.type ?? "task";
    const scheme = schemeForType(project.statusSchemes, type);
    const status = initialStage(scheme);

    const db = getDb();
    const now = nowIso();
    const id = newId("wi");

    await db.insert(schema.workItems).values({
      id,
      projectId: args.projectId,
      type,
      title: args.title.trim() || "Untitled work item",
      description: args.description?.trim() ?? "",
      priority: args.priority ?? 0,
      assignee: args.assignee ?? null,
      status,
      statusCategory: "todo",
      environment: null,
      severity: args.severity ?? null,
      blocked: 0,
      blockedReason: null,
      blockedBy: null,
      resolution: null,
      statusStale: 0,
      execState: "idle",
      claimedAt: null,
      claimedBy: null,
      workflowId: args.workflowId ?? null,
      workflowRunId: null,
      deliverable: null,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // Initial trail row: creation lands the item at its first stage.
    await db.insert(schema.workItemStatusLog).values({
      id: newId("wisl"),
      workItemId: id,
      runId: null,
      actor: ownerEmail,
      fromStatus: null,
      toStatus: status,
      blocked: 0,
      resolution: null,
      at: now,
    });

    return { id, type, status, statusCategory: "todo" as const };
  },
});
