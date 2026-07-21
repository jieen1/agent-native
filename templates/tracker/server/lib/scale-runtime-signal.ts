/**
 * F5 运行期规模定性 — docs/sdlc-impl-f5-f10.md §1A 第 5 行。
 *
 * 设计意图:执行期 vLLM 单节点输出预算耗尽 ≥2 次 → 自动把 scale_estimate
 * 定性为 'split-required'(覆盖既有 'ok'),不再"换更大模型硬扛"(02 §3.10)。
 *
 * ── 完备性缺口(如实记录,勿隐藏) ────────────────────────────────────────
 * R3 实核结论(docs/sdlc-impl-f5-f10.md §1A 本行原文):F2 现状代码
 * (orchestrator 的 engine-loop.ts / v3-dispatcher.ts)与 F9 本方案均**未定义**
 * 任何"预算耗尽"事件的产生点 —— 本文件的自动运行期通道因此没有生产者可接,
 * 不在本批可交付。本批实际可用路径**只有人工触发**:一个人工评审(或未来
 * 任何调用方)显式调用 `markScaleExceeded`,把某工作项的估算标为运行期超标。
 * 自动通道(orchestrator 侦测到 ≥2 次预算耗尽后自动调用本函数)留作后续硬化
 * 项 —— 需要先在 F2/F7 usage-suspect 或一个新的专门信号点上补一个"输出预算
 * 耗尽"事件的生产者,再由 orchestrator 侧的回写客户端(F9 tracker-client.ts)
 * 调用 tracker 这一侧的窄 action。
 *
 * 因此这个模块目前只做「同一次调用把 exhaustionCount 与阈值比较、决定是否
 * 定性」的纯判定 + 一个直接写库的函数,由 `actions/mark-scale-exceeded.ts`
 * (框架要求 action 必须落在 actions/<name>.ts 才能被 `pnpm action`/HTTP/agent
 * 按文件名路由发现——见 .agents/skills/actions/SKILL.md「Action not found」
 * 一节)瘦包装后暴露为人工可调用的 action。两者是同一个功能单元的两个文件,
 * 不是两个独立职责。
 */

import { and, eq } from "drizzle-orm";

import type { getDb, schema as trackerSchema } from "../db/index.js";
import { ownerScope } from "./access.js";

export const RUNTIME_EXHAUSTION_THRESHOLD = 2;

export interface ScaleEstimateShape {
  files: number;
  crossLifecycle: boolean;
  signals: string[];
  verdict: "ok" | "split-required";
  at?: string;
}

/** Pure judgment: does this exhaustion count cross the runtime threshold? */
export function shouldMarkScaleExceeded(exhaustionCount: number): boolean {
  return exhaustionCount >= RUNTIME_EXHAUSTION_THRESHOLD;
}

/**
 * Overlay a runtime-exhaustion verdict onto an existing (possibly absent)
 * scale_estimate snapshot. Never downgrades an existing 'split-required' —
 * always upgrades toward 'split-required' once the threshold is crossed.
 * Pure — does not touch signals beyond appending a runtime marker so the
 * activity/UI can tell "why" this item flipped.
 */
export function applyRuntimeExhaustion(
  existing: ScaleEstimateShape | null,
  exhaustionCount: number,
): ScaleEstimateShape {
  const base: ScaleEstimateShape = existing ?? {
    files: 0,
    crossLifecycle: false,
    signals: [],
    verdict: "ok",
  };
  if (!shouldMarkScaleExceeded(exhaustionCount)) return base;
  return {
    ...base,
    verdict: "split-required",
    signals: base.signals.includes("runtime:budget-exhausted")
      ? base.signals
      : [...base.signals, "runtime:budget-exhausted"],
  };
}

/**
 * Write the runtime-exceeded verdict to a work item's scale_estimate column
 * and log the `scale.exceeded-at-runtime` activity. Called either by a human
 * evaluator (via actions/mark-scale-exceeded.ts, today's only real path — see
 * module docblock) or — once F2/F9 grow a real exhaustion-event producer — by
 * the F9 writeback channel.
 */
export async function markScaleExceeded(
  db: ReturnType<typeof getDb>,
  schema: typeof trackerSchema,
  args: {
    workItemId: string;
    exhaustionCount: number;
    ownerEmail: string;
    orgId: string | null;
    reason?: string;
  },
): Promise<{ marked: boolean; scaleEstimate: ScaleEstimateShape }> {
  // ownerScope on BOTH read and write (CLAUDE.md 红线): mark-scale-exceeded is
  // a live HTTP/agent-callable action, so an unscoped eq(id) would let any
  // authenticated caller read + flip + write a冠名 activity on ANOTHER tenant's
  // work item. Scope it to the caller's owner_email/org (request-context via
  // ownerScope) so a foreign id resolves to zero rows → "not accessible".
  const item = (
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
  if (!item) throw new Error("Work item not found or not accessible");

  let existing: ScaleEstimateShape | null = null;
  const raw = (item as { scaleEstimate?: string | null }).scaleEstimate;
  if (raw) {
    try {
      existing = JSON.parse(raw);
    } catch {
      existing = null;
    }
  }

  const marked = shouldMarkScaleExceeded(args.exhaustionCount);
  const next = applyRuntimeExhaustion(existing, args.exhaustionCount);
  const now = new Date().toISOString();
  const scaleEstimate: ScaleEstimateShape = { ...next, at: now };

  if (marked) {
    await db
      .update(schema.workItems)
      .set({ scaleEstimate: JSON.stringify(scaleEstimate) })
      .where(
        and(
          eq(schema.workItems.id, args.workItemId),
          ownerScope(schema.workItems),
        ),
      );

    await db.insert(schema.activities).values({
      id: `act_scaleex_${args.workItemId.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
      workItemId: args.workItemId,
      actorKind: "human",
      actorName: args.ownerEmail,
      eventType: "scale.exceeded-at-runtime",
      payload: JSON.stringify({
        exhaustionCount: args.exhaustionCount,
        threshold: RUNTIME_EXHAUSTION_THRESHOLD,
        reason: args.reason ?? null,
        scaleEstimate,
      }),
      createdAt: now,
      ownerEmail: args.ownerEmail,
      orgId: args.orgId,
    });
  }

  return { marked, scaleEstimate };
}
