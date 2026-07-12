import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { assertWritebackCaller } from "../server/lib/writeback-actor.js";

// F9 — 回写通道专用窄 action #1: exec_state 迁移.
//
// 设计权威: docs/sdlc-impl-f5-f10.md §5A + docs/sdlc-product-design/02-workflows.md
// §8 守卫表.
//
// 严格守边界 —— 这个 action 只做一件事: 把 `tracker_work_items.exec_state`
// (v24 列, 消费 F3 交付物) 迁移到 {queued|running|returned} 集合内的某个值,
// 并写一条活动流记录. 它绝不触碰 `currentStageName`/`status='done'`/
// `closed_reason` 等 —— 那些字段的正向阶段推进走 `advance-stage.ts`(F3/F8,
// 未改), 终态写入走 `transition-work-item.ts`(F3 守卫, 唯一人工写入口)。
//
// 注: F3 的 `transition-guard.ts` 不含 execState 转移函数(其导出仅
// `allowedTransitions`/`assertTransition`/`currentGuardState`/
// `guardStateToStageName`/`isValidCommitRef`, execState 仅在 guard 的 closed
// 分支被读作"未派发"判据) —— 这里的 execState 白名单集合由本 action 自身定义,
// 消费的 F3 交付物只是 v24 `exec_state` 列本身.
//
// 典型用途 (T-F3-06 async 半边闭合): brain 首轮零交付(thread error 且无
// workflowRun) → reconciler 调本 action 把 execState 从 'dispatched' 打回
// 'queued', 写活动 `dispatch.failed`——工作项的业务阶段(currentStageName)
// 纹丝不动, 因为派发本来就"不推进阶段"(SDLC-063), 失败路径同样不留假进度。
//
// 调用身份: 必须是回写通道 (assertWritebackCaller) —— 人工/普通 agent 调用
// 一律结构化拒绝 (T-F9-05), 且拒绝路径零写入 (不读工作项、不写活动)。
const TARGET_ENUM = ["queued", "running", "returned"] as const;

export default defineAction({
  description:
    "回写通道专用窄 action(仅回写身份可调用): 把工作项的 exec_state 迁移到 " +
    "queued/running/returned 之一,并写活动流。绝不写 currentStageName/status。" +
    "典型用途: brain 零交付时把 execState 打回 queued(T-F3-06 async 半边)。",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item whose exec_state to migrate"),
    target: z.enum(TARGET_ENUM).describe("New exec_state — queued|running|returned only"),
    reason: z
      .string()
      .optional()
      .describe("Why (e.g. zero-delivery/thread-error) — written to the activity payload"),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    // Actor check FIRST — a rejected call must leave zero trace (T-F9-05).
    assertWritebackCaller({ caller: ctx?.caller, userEmail: getRequestUserEmail() });

    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(eq(schema.workItems.id, args.workItemId))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found");

    const currentExecState = (item as { execState?: string | null }).execState ?? null;

    if (currentExecState === null) {
      const err = new Error(
        "工作项从未派发(exec_state 为空)—— 回写通道只能迁移已派发项的 exec_state",
      );
      (err as Error & { code?: string }).code = "not-dispatched";
      throw err;
    }

    // Idempotent no-op — repeat writeback reports of the same target state
    // must be zero-side-effect (T-F9-02/T-F9-03 style idempotency).
    if (currentExecState === args.target) {
      return { noop: true, workItemId: item.id, execState: currentExecState };
    }

    const now = new Date().toISOString();
    await db
      .update(schema.workItems)
      .set({ execState: args.target, updatedAt: now })
      .where(eq(schema.workItems.id, item.id));

    // The zero-delivery failure path (→queued) gets its own named event so
    // S10's "回写:最近成功/失败计数" and the work item's own activity feed can
    // tell "brain never delivered" apart from an ordinary in-flight update.
    const eventType = args.target === "queued" ? "dispatch.failed" : "writeback.exec-state";

    await db.insert(schema.activities).values({
      id: `act_wbexec_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: item.id,
      actorKind: "agent",
      actorName: "回写通道",
      eventType,
      payload: JSON.stringify({
        from: currentExecState,
        to: args.target,
        reason: args.reason ?? null,
      }),
      createdAt: now,
      ownerEmail: item.ownerEmail,
      orgId: item.orgId ?? null,
      visibility: "private",
    });

    return { noop: false, workItemId: item.id, execState: args.target };
  },
});
