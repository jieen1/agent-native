import { defineAction } from "@agent-native/core";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { and, eq, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// F5 任务拆分阈值(规划前置契约) — docs/sdlc-impl-f5-f10.md §1A /
// docs/sdlc-product-design/02-workflows.md §3.10.
//
// Splits an over-scale work item (files > 6 or crossLifecycle, per
// estimate-brief-scale) into a caller-supplied list of child work items —
// same shape as decompose-epic.ts (never AI-auto-decomposes; only persists
// exactly the children the caller provides). Unlike decompose-epic, split
// children are NOT linked back to the parent via tracker_links — the
// relationship is the `split_parent_id` column (v25) directly, and the
// parent is NOT auto-closed (a human closes it later via the guarded
// transition-work-item, target=closed, once unpateched — keeping
// transition-guard.ts the single write path for closure, per F3).
export default defineAction({
  description:
    "Split an over-scale work item into ≥2 child work items (same project/" +
    "sprint), optionally chained blocked-by in the given order. Refuses if " +
    "the parent has already been dispatched (already-dispatched). Use after " +
    "estimate-brief-scale reports verdict='split-required'.",
  schema: z.object({
    workItemId: z.string().min(1).describe("Parent work item to split"),
    children: z
      .array(
        z.object({
          title: z.string().min(1).describe("Child work item title"),
          description: z
            .string()
            .optional()
            .describe("Child requirement/intent text"),
          nature: z
            .array(z.string())
            .optional()
            .describe("Nature tags (性质): 前端 | 后端 | API | 数据"),
        }),
      )
      .min(2)
      .describe(
        "The fixed list of child work items to create — never inferred by AI",
      ),
    chainBlockedBy: z
      .boolean()
      .optional()
      .describe(
        "Create a blocked-by chain in the given order (children[1] blocked-by " +
          "children[0], etc). Default true (S2 拆分对话框 default-on Switch).",
      ),
  }),
  http: { method: "POST" },
  audit: {
    target: (args) => ({ type: "work-item", id: args.workItemId }),
    summary: (args) => `split → ${args.children.length} children`,
  },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    const db = getDb();

    const parent = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!parent) throw new Error("Work item not found or not accessible");

    // 已派发不可拆 — 复用 F3 的 "already-dispatched" 错误语汇
    // (server/lib/transition-guard.ts describeTransition's closed-branch
    // check uses the same execState∈{null,queued} predicate for the same
    // reason: once a run may be acting on the item, the shape it started
    // with must not be pulled out from under it).
    const execState =
      (parent as { execState?: string | null }).execState ?? null;
    const notDispatched = execState === null || execState === "queued";
    if (!notDispatched) {
      const err = new Error("已派发的工作项不能拆分");
      (err as Error & { code?: string }).code = "already-dispatched";
      throw err;
    }

    const chainBlockedBy = args.chainBlockedBy ?? true;

    // Project key + running sequence number for itemKey generation.
    //
    // F8 未合并前暂沿现状计数(与 create-work-item.ts / decompose-epic.ts 同
    // 一 count(*)-based 生成法)——文档标注消费点:F8 合并后这里改为
    // `UPDATE tracker_project_seq … RETURNING next_seq` 单点原子分配
    // (docs/sdlc-impl-f5-f10.md §1D)。
    const project = (
      await db
        .select({ key: schema.projects.key })
        .from(schema.projects)
        .where(eq(schema.projects.id, parent.projectId))
        .limit(1)
    )[0];
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workItems)
      .where(eq(schema.workItems.projectId, parent.projectId));
    let seq = (Number(countResult[0]?.count) || 0) + 1;

    const now = new Date().toISOString();
    const created: { id: string; itemKey: string; title: string }[] = [];

    for (const child of args.children) {
      const id = nanoid();
      const itemKey = `${project?.key ?? "ITEM"}-${String(seq).padStart(3, "0")}`;
      seq++;
      // Split children pick up mid-lifecycle at 实施 — the parent brief
      // already passed brainstorm/sprint-plan/test-plan/design (it only got
      // flagged for scale at the Briefs step, per the S2 workflow), so
      // children are ready-to-dispatch dev sub-tasks, mirroring the
      // "sprint 外(quick-task/from-audit/hotfix)由 plannedStages=实施→测试
      // 的初始阶段保证" convention F9's contract note documents.
      const plannedStages = ["实施", "测试"];
      await db.insert(schema.workItems).values({
        id,
        projectId: parent.projectId,
        type: "任务",
        title: child.title.trim(),
        description: child.description?.trim() ?? "",
        status: "open",
        priority: parent.priority ?? 2,
        risk: parent.risk ?? "medium",
        tags: "[]",
        nature: JSON.stringify(child.nature ?? []),
        owner: null,
        sprintId: parent.sprintId ?? null,
        executionMode: "manual",
        itemKey,
        plannedStages: JSON.stringify(plannedStages),
        currentStageName: plannedStages[0],
        splitParentId: parent.id,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });
      created.push({ id, itemKey, title: child.title.trim() });
    }

    // blocked-by 链:children[1] blocked-by children[0], children[2] blocked-by
    // children[1], … — 复用既有 add-link 语汇(schema {fromItemId,toItemId,
    // linkType}, linkType='blocked-by'),按 decompose-epic.ts 的先例直插
    // schema.links(不存在名为 link-work-items 的 action,见 §1A 表格注)。
    let chainedLinks = 0;
    if (chainBlockedBy) {
      for (let i = 1; i < created.length; i++) {
        await db.insert(schema.links).values({
          id: nanoid(),
          fromItemId: created[i]!.id,
          toItemId: created[i - 1]!.id,
          linkType: "blocked-by",
          createdAt: now,
          ownerEmail,
          orgId,
        });
        chainedLinks++;
      }
    }

    // 父项写活动 split.performed(children ids) — 父项不自动关闭,由人经 F3
    // 的 transition-work-item(target=closed,未派发)收口。
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: parent.id,
      actorKind: "agent",
      actorName: "智能体",
      eventType: "split.performed",
      payload: JSON.stringify({
        childrenIds: created.map((c) => c.id),
        childrenItemKeys: created.map((c) => c.itemKey),
        chainBlockedBy,
        chainedLinks,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return {
      parentId: parent.id,
      children: created,
      chainBlockedBy,
      chainedLinks,
    };
  },
});
