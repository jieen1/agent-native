import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { isChecklistComplete } from "../server/lib/review-checklist.js";
import {
  actorFromCaller,
  assertTransition,
  currentGuardState,
  guardStateToStageName,
  TransitionGuardError,
  type GuardState,
} from "../server/lib/transition-guard.js";

// The 7 guard-facing target states. See server/lib/transition-guard.ts for the
// full vocabulary-reconciliation note (target enum ≠ currentStageName enum).
const TARGET_ENUM = [
  "待办",
  "实施",
  "测试",
  "待人工评审",
  "交付",
  "done",
  "closed",
] as const;

/** Extract the number of rows a `.update(...).returning()` call actually
 *  touched — the CAS write's collision signal (T-F3-15). Works across the
 *  drizzle dialect adapters used by `createGetDb` (they all resolve
 *  `.returning()` to an array of the updated rows). */
export function rowsAffectedFromReturning(rows: unknown): number {
  return Array.isArray(rows) ? rows.length : 0;
}

export default defineAction({
  description:
    "受守卫的人工工作项状态流转/关闭通道 —— 唯一写入口。按 02 §8 守卫表校验 " +
    "写入方身份(仅人可执行 done/closed/交付/回退)与证据载荷(done 需 " +
    "verdict=PASSED+commit;交付需 commit 或 links;closed 需未派发),强制 " +
    "reason,写活动流 + 框架审计。target=当前状态时零写入(noop)。正向阶段 " +
    "推进(实施→测试 等)不走本 action —— 那由回写通道(F9)驱动。",
  schema: z.object({
    id: z.string().min(1).describe("Work item id"),
    target: z.enum(TARGET_ENUM).describe("Guard-facing target state"),
    reason: z
      .string()
      .min(4)
      .describe("Why this manual change — written to audit + activity feed"),
    verdict: z
      .enum(["PASSED", "CHANGES_REQUESTED"])
      .optional()
      .describe(
        "Required PASSED for target=done; CHANGES_REQUESTED redirects to a 实施 rollback",
      ),
    evidence: z
      .object({
        runId: z.string().optional(),
        branch: z.string().optional(),
        commit: z
          .string()
          .optional()
          .describe("PR/merge commit — 7-40 hex chars"),
        deliveryItems: z.array(z.string()).optional(),
        links: z.array(z.string()).optional(),
      })
      .optional(),
  }),
  http: { method: "POST" },
  audit: {
    // Precondition called out by T-F3-13: without this, targetId falls back
    // to null and the audit-lookup-by-targetId assertion is permanently red.
    target: (args) => ({ type: "work-item", id: args.id }),
    summary: (args) =>
      `transition → ${args.target}: ${args.reason}`.slice(0, 200),
  },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const actor = actorFromCaller(ctx?.caller, ownerEmail);

    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(eq(schema.workItems.id, args.id), ownerScope(schema.workItems)),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    const snapshot = {
      currentStageName: item.currentStageName,
      status: item.status,
      execState: (item as { execState?: string | null }).execState ?? null,
    };

    // CHANGES_REQUESTED redirect: target=done + verdict=CHANGES_REQUESTED is
    // review-rejection semantics, NOT a done write — it's equivalent to a
    // manual-override rollback to 实施 (S4: "驳回并要求返工"). The redirect is
    // ONLY meaningful from 「待人工评审」(验收) — the one state where a review
    // verdict exists to reject. From any other source state it does NOT fire:
    // target=done reaches the guard as-is and is denied there
    // (`invalid-source-state`, done 仅可自待人工评审进入 — 02 §8), instead of
    // silently converting a nonsensical request into a rollback.
    const isChangesRequestedRedirect =
      args.target === "done" &&
      args.verdict === "CHANGES_REQUESTED" &&
      currentGuardState(snapshot) === "待人工评审";
    const effectiveTarget: GuardState = isChangesRequestedRedirect
      ? "实施"
      : args.target;

    const evidence = {
      verdict: args.verdict,
      commit: args.evidence?.commit,
      links: args.evidence?.links,
      deliveryItems: args.evidence?.deliveryItems,
      runId: args.evidence?.runId,
      branch: args.evidence?.branch,
    };

    let guardResult: { noop: boolean };
    try {
      guardResult = assertTransition(
        snapshot,
        effectiveTarget,
        actor,
        evidence,
      );
    } catch (err) {
      if (err instanceof TransitionGuardError) {
        const wrapped = new Error(`状态迁移被拒绝: ${err.message}`);
        (wrapped as Error & { code?: string; need?: string[] }).code = err.code;
        (wrapped as Error & { code?: string; need?: string[] }).need = err.need;
        throw wrapped;
      }
      throw err;
    }

    if (guardResult.noop) {
      return {
        id: item.id,
        target: args.target,
        effectiveTarget,
        noop: true,
        status: item.status,
        currentStageName: item.currentStageName,
      };
    }

    // F6 §2A done 守卫钩 (T-F6-06): assertTransition above only checks
    // actor/source-state/verdict+commit evidence — it does NOT know about the
    // F6 review checklist (that lives in server/lib/review-checklist.ts, a
    // module transition-guard.ts predates). Re-check here, AFTER the guard
    // passes but BEFORE patch.status='done' is written: if this item's review
    // checklist (03 §2, persisted at review-render time) has any unconfirmed
    // item, deny with the same evidence-missing shape the guard itself uses.
    //
    // CRITICAL (R3 review F-1): this MUST use the READ-ONLY `isChecklistComplete`,
    // never `computeChecklistState` — the latter is the write/render path and,
    // called here with no diff, would recompute machine items in a no-diff
    // context and overwrite review-time checked=1 back to 0 (fail-closed
    // deadlock for nature-含-数据 items whose machine 迁移冒烟 item can't be
    // human-checked). The guard only READS the review-time machine judgments +
    // human confirmations. Only gates target=done — 交付/回退/closed untouched.
    if (effectiveTarget === "done") {
      const complete = await isChecklistComplete(db, {
        id: item.id,
        sprintId: item.sprintId,
      });
      if (!complete) {
        const wrapped = new Error(
          "状态迁移被拒绝: 评审核对清单未全部确认(F6 核对清单门,03 §2)",
        );
        (wrapped as Error & { code?: string; need?: string[] }).code =
          "evidence-missing";
        (wrapped as Error & { code?: string; need?: string[] }).need = [
          "checklist",
        ];
        throw wrapped;
      }
    }

    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { updatedAt: now };
    let eventType = "transition.manual";

    if (effectiveTarget === "done") {
      patch.status = "done";
      eventType = "transition.done";
    } else if (effectiveTarget === "closed") {
      patch.status = "closed";
      patch.closedReason = args.reason;
      patch.closedAt = now;
      eventType = "transition.closed";
    } else if (effectiveTarget === "交付") {
      patch.currentStageName = guardStateToStageName(effectiveTarget);
      eventType = "transition.delivery";
    } else {
      // Ladder target reached only via backward/manual-override (forward is
      // rejected by the guard) — including the CHANGES_REQUESTED redirect.
      patch.currentStageName = guardStateToStageName(effectiveTarget);
      eventType = "transition.manual-override";
    }

    // CAS write: the WHERE clause re-asserts the exact snapshot the guard
    // just evaluated — status + currentStageName + execState. A concurrent
    // transition (or an F9 writeback flipping execState, e.g. a dispatch
    // landing between our read and write, which would invalidate a `closed`
    // decision that requires exec_state∈{null,queued}) changes the row out
    // from under us — .returning() then comes back empty and we surface a
    // structured conflict instead of silently clobbering the other writer's
    // result (T-F3-15; execState axis closes the closed-branch TOCTOU).
    const updated = await db
      .update(schema.workItems)
      .set(patch)
      .where(
        and(
          eq(schema.workItems.id, item.id),
          eq(schema.workItems.status, item.status),
          eq(schema.workItems.currentStageName, item.currentStageName ?? ""),
          snapshot.execState === null
            ? isNull(schema.workItems.execState)
            : eq(schema.workItems.execState, snapshot.execState),
        ),
      )
      .returning();

    if (rowsAffectedFromReturning(updated) === 0) {
      const conflict = new Error("状态已被并发修改,请刷新后重试");
      (conflict as Error & { code?: string }).code = "conflict";
      throw conflict;
    }

    await db.insert(schema.activities).values({
      id: `act_trans_${item.id.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: item.id,
      actorKind: actor.kind,
      actorName: ownerEmail,
      eventType,
      payload: JSON.stringify({
        target: args.target,
        effectiveTarget,
        reason: args.reason,
        verdict: args.verdict ?? null,
        evidence: args.evidence ?? null,
      }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id: item.id,
      target: args.target,
      effectiveTarget,
      noop: false,
      status:
        effectiveTarget === "done"
          ? "done"
          : effectiveTarget === "closed"
            ? "closed"
            : item.status,
      currentStageName:
        typeof patch.currentStageName === "string"
          ? patch.currentStageName
          : item.currentStageName,
    };
  },
});
