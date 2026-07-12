import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { allocateItemKey } from "../server/lib/item-key-sequencer.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Create a work item under a project. Holds the requirement/intent only — " +
    "repo and branch come from the project (configured once), NOT the item.",
  schema: z.object({
    projectId: z.string().min(1).describe("Owning project id"),
    title: z.string().min(1).describe("Short work item title"),
    description: z
      .string()
      .optional()
      .describe("The requirement / intent handed to the orchestrator brain"),
    type: z
      .enum(["需求", "任务", "缺陷", "测试", "生产问题", "集合", "from-audit", "requirement", "task", "defect", "incident", "story", "epic"])
      .optional()
      .describe("Work item type: 需求/任务/缺陷/测试/生产问题/集合(epic,汇总子项的容器)/from-audit(审计发起,阶段子集实施+测试) (or legacy English names)"),
    priority: z.coerce.number().int().optional().describe("Priority: 1=P0 (紧急/Critical), 2=P1 (高/High), 3=P2 (中/Medium, 默认), 4=P3 (低/Low)"),
    risk: z.enum(["low", "medium", "high"]).optional().describe("Risk level"),
    tags: z.array(z.string()).optional().describe("Feature/label tags"),
    nature: z.array(z.string()).optional().describe("Nature tags (性质): 前端 | 后端 | API | 数据"),
    owner: z.string().nullable().optional().describe("Owner email or 'agent'. Null = unassigned."),
    sprintId: z.string().optional().describe("Sprint to assign this item to"),
    executionMode: z
      .enum(["auto", "manual"])
      .optional()
      .describe("auto = enter queue on create; manual = stay in 待办"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    // Confirm the project exists and is visible to the caller.
    const project = (
      await db
        .select({ id: schema.projects.id, key: schema.projects.key })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, args.projectId), ownerScope(schema.projects)))
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or not accessible");

    // F8: itemKey allocation is the single project-level sequencer — an
    // atomic RETURNING increment on tracker_project_seq, NOT a count(*) (the
    // old count(*)-based generation raced under concurrency and minted
    // duplicate itemKeys — SDLC-038; see server/lib/item-key-sequencer.ts).
    const itemKey = await allocateItemKey(args.projectId, project.key);

    const id = nanoid();
    const now = new Date().toISOString();

    // Compute default plannedStages based on item type and tags
    const tags = args.tags ?? [];
    const isNarrowScope =
      args.type === "缺陷" ||
      args.type === "defect" ||
      args.type === "from-audit" ||
      tags.includes("from-audit");
    const defaultPlannedStages = isNarrowScope ? ["实施", "测试"] : ["待办","分析","设计","实施","测试","验收","交付"];
    const defaultCurrentStageName = defaultPlannedStages[0];

    await db.insert(schema.workItems).values({
      id,
      projectId: args.projectId,
      type: args.type ?? "需求",
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      status: "open",
      priority: args.priority ?? 3,
      risk: args.risk ?? "medium",
      tags: JSON.stringify(args.tags ?? []),
      nature: JSON.stringify(args.nature ?? []),
      owner: args.owner ?? null,
      sprintId: args.sprintId ?? null,
      executionMode: args.executionMode ?? "manual",
      itemKey,
      plannedStages: JSON.stringify(defaultPlannedStages),
      currentStageName: defaultCurrentStageName,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id,
      projectId: args.projectId,
      itemKey,
      type: args.type ?? "requirement",
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      status: "open",
      priority: args.priority ?? 3,
      risk: args.risk ?? "medium",
      tags: args.tags ?? [],
      sprintId: args.sprintId ?? null,
      executionMode: args.executionMode ?? "manual",
      plannedStages: defaultPlannedStages,
      currentStageName: defaultCurrentStageName,
      createdAt: now,
      updatedAt: now,
    };
  },
});
