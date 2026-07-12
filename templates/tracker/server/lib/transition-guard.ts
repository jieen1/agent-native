/**
 * F3 状态迁移守卫 — 纯函数实现。
 *
 * 设计权威：docs/sdlc-product-design/02-workflows.md §8「状态迁移守卫」表
 * （门判据之下的更基础层：每个状态迁移允许谁写、必须带什么证据）。实施细则：
 * docs/sdlc-impl-f1-f4.md §3A。
 *
 * 这个模块不碰数据库、不做 I/O —— 只接受一个「工作项快照」+「写入方身份」+
 * 「证据载荷」，返回/抛出判定结果。`actions/transition-work-item.ts` 是唯一
 * 调用方（写入口），`actions/get-work-item.ts` 调 `allowedTransitions` 供前端
 * 对话框消费 —— 前后端必须同源（T-F3-08），因此这个模块是唯一真相来源。
 *
 * ── 词汇表调和(需在报告中说明的偏差点) ──────────────────────────────────────
 * `docs/sdlc-impl-f1-f4.md` §3A 给出的 `transition-work-item` schema 里，
 * `target` 枚举是 待办/实施/测试/待人工评审/交付/done/closed 七个值 —— 但
 * 现有 DB 词汇（`tracker_work_items.currentStageName` / `complete-stage.ts` /
 * `rollback-stage.ts` 的 VALID_STAGES）用的是 待办/分析/设计/实施/测试/验收/交付
 * 七段。两份词汇不是同一个七元组：设计稿的「待人工评审」在现状 DB 里没有
 * 直接同名列 —— 语义上对应的是「验收」阶段（等待人工签核，才能到 done）。
 * 这里做一层**守卫态归一化**：
 *   - currentStageName ∈ {待办,分析,设计} → 守卫态「待办」（分析/设计collapse，
 *     因为守卫矩阵不区分这两段——都还没到实施，正向推进都归 F9 通道）
 *   - currentStageName === "验收"        → 守卫态「待人工评审」
 *   - currentStageName ∈ {实施,测试,交付} → 同名直通
 *   - work_items.status === "done"/"closed" → 守卫态 done/closed（终态，脱离
 *     currentStageName 的梯子）
 * 写回时用 `guardStateToStageName` 做反向映射。这一层归一化在文档里没有
 * 显式给出，是为了让两份词汇可以在同一个纯函数里对齐而必须做的工程判断——
 * 在报告里已作为偏差点单独列出。
 */

import { writebackActorEmail } from "./writeback-actor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Who is attempting the transition. */
export type ActorKind = "human" | "agent" | "system";

export interface Actor {
  kind: ActorKind;
  email?: string | null;
}

/**
 * Resolve the guard's `Actor` from an action's invocation surface. Mirrors
 * the framework audit log's own convention (`deriveActorKind` in
 * `@agent-native/core/audit`): the in-app agent loop, sub-agents, and A2A
 * dispatch all arrive as `caller==="tool"` — those are the ONLY calls this
 * guard treats as `agent`. Every other surface (frontend browser, http, cli,
 * external MCP client) is a person acting through the UI or a script and is
 * `human`, provided a JWT-resolved user email is present; with no resolved
 * email at all it's `system` (denied by every guard branch that requires
 * human).
 *
 * F9 addendum: the reconciler's deterministic writeback channel calls the
 * tracker over the cross-app MCP surface (`caller==="mcp"`, not `"tool"` —
 * see `server/lib/writeback-actor.ts`), presenting the reserved
 * `writebackActorEmail()` sentinel as its resolved email. Without this
 * special case that identity would fall into the `caller!=="tool"` +
 * `userEmail` branch below and be classified `human` — which would let it
 * sail through every guard branch that is gated on "human only" (done,
 * closed, 交付, manual-override/回退). Recognizing the sentinel here and
 * forcing `kind: "agent"` closes that hole mechanically (T-F9-04): the
 * writeback identity gets EXACTLY the same (zero) standing as any other
 * agent caller on this guard, in addition to (never instead of) the
 * writeback-only actions' own `assertWritebackCaller` check.
 */
export function actorFromCaller(
  caller: string | undefined,
  userEmail: string | undefined | null,
): Actor {
  if (userEmail && userEmail === writebackActorEmail()) {
    return { kind: "agent", email: userEmail };
  }
  if (caller === "tool") return { kind: "agent", email: userEmail ?? null };
  if (userEmail) return { kind: "human", email: userEmail };
  return { kind: "system", email: null };
}

/** The seven guard-facing target states (schema-literal, see docs/sdlc-impl-f1-f4.md §3A). */
export type GuardState =
  | "待办"
  | "实施"
  | "测试"
  | "待人工评审"
  | "交付"
  | "done"
  | "closed";

export const ALL_GUARD_STATES: readonly GuardState[] = [
  "待办",
  "实施",
  "测试",
  "待人工评审",
  "交付",
  "done",
  "closed",
];

/** Forward-progression ladder (rank 0..4). `done`/`closed` sit outside it. */
const LADDER: readonly GuardState[] = ["待办", "实施", "测试", "待人工评审", "交付"];

/** Minimal work-item shape the guard needs — callers pass a projection. */
export interface GuardWorkItem {
  currentStageName: string | null | undefined;
  status: string | null | undefined;
  /** null|queued|dispatched|running|returned (v24 exec_state column). */
  execState?: string | null;
}

/** Evidence payload — flattened from the transition-work-item action's
 *  top-level `verdict` + `evidence.{commit,links,deliveryItems,runId,branch}`. */
export interface TransitionEvidence {
  verdict?: "PASSED" | "CHANGES_REQUESTED";
  commit?: string;
  links?: string[];
  deliveryItems?: string[];
  runId?: string;
  branch?: string;
}

export type TransitionGuardErrorCode =
  | "evidence-missing"
  | "actor-denied"
  | "already-dispatched"
  | "forward-not-allowed"
  | "terminal-state"
  | "invalid-source-state"
  | "changes-requested";

/** Structured error thrown by `assertTransition`. `need` is populated only for
 *  `evidence-missing` — the exact list of missing evidence field names, so the
 *  frontend can red-outline the precise controls (S4 契约, T-F3-02). */
export class TransitionGuardError extends Error {
  readonly code: TransitionGuardErrorCode;
  readonly need: string[];
  constructor(code: TransitionGuardErrorCode, message: string, need: string[] = []) {
    super(message);
    this.name = "TransitionGuardError";
    this.code = code;
    this.need = need;
  }
}

export interface TransitionDescriptor {
  target: GuardState;
  /** True when this actor could legally reach `target` from the item's
   *  current guard state (ignoring evidence completeness — that's checked by
   *  `assertTransition`). */
  ok: boolean;
  /** Evidence field names the caller should supply (UI hint only). */
  need: string[];
  /** Human-readable requirement summary for the Select option (S4). */
  summary: string;
  /** Coarse category — informs activity `eventType` and UI grouping. */
  kind:
    | "noop"
    | "terminal-done"
    | "terminal-closed"
    | "escape-delivery"
    | "manual-override"
    | "forward-blocked"
    | "blocked-terminal";
  /** Present when ok=false — the code `assertTransition` would throw. */
  denyCode?: TransitionGuardErrorCode;
}

// ---------------------------------------------------------------------------
// Guard-state normalization
// ---------------------------------------------------------------------------

/** Map a raw DB row to the guard's 7-value state (see module docblock). */
export function currentGuardState(item: GuardWorkItem): GuardState {
  if (item.status === "done") return "done";
  if (item.status === "closed") return "closed";
  switch (item.currentStageName) {
    case "实施":
      return "实施";
    case "测试":
      return "测试";
    case "验收":
      return "待人工评审";
    case "交付":
      return "交付";
    default:
      // 待办 / 分析 / 设计 / unknown all collapse to 待办 for guard purposes.
      return "待办";
  }
}

/** Reverse mapping — what to write to `currentStageName` for a ladder target.
 *  Not meaningful for target ∈ {done, closed} — those write `status` instead. */
export function guardStateToStageName(target: GuardState): string {
  switch (target) {
    case "待人工评审":
      return "验收";
    default:
      return target;
  }
}

const COMMIT_RE = /^[0-9a-f]{7,40}$/i;

export function isValidCommitRef(commit: string | undefined | null): boolean {
  return typeof commit === "string" && COMMIT_RE.test(commit);
}

function hasNonEmptyLinks(links: string[] | undefined): boolean {
  return Array.isArray(links) && links.length > 0;
}

// ---------------------------------------------------------------------------
// Core per-target legality (actor + source-state only — evidence is checked
// separately by assertTransition so allowedTransitions can list a target
// before evidence has been filled in).
// ---------------------------------------------------------------------------

function describeTransition(
  item: GuardWorkItem,
  target: GuardState,
  actor: Actor,
): TransitionDescriptor {
  const current = currentGuardState(item);

  if (target === current) {
    return { target, ok: true, need: [], summary: "当前状态", kind: "noop" };
  }

  if (target === "done") {
    const need = ["verdict", "commit"];
    const summary = "仅可自「待人工评审」进入,需 PASSED verdict + 合并 commit(7-40 位 hex)";
    if (actor.kind !== "human") {
      return {
        target,
        ok: false,
        need,
        summary,
        kind: "terminal-done",
        denyCode: "actor-denied",
      };
    }
    // 02 §8 (设计权威): done 的唯一合法源态是「待人工评审」(验收) —— 人工
    // 评审通过才可 done。从任何其他源态(含 交付)直接 done 一律拒绝;
    // 想跳过评审的唯一人工逃生口是 target=交付,之后仍须经评审到 done。
    // (细则 §6.3 矩阵原文放松了此约束,属文档冲突,以 02 §8 为准 —— 文档
    // 已同步修订。)
    if (current !== "待人工评审") {
      return {
        target,
        ok: false,
        need,
        summary,
        kind: "terminal-done",
        denyCode: "invalid-source-state",
      };
    }
    return {
      target,
      ok: true,
      need,
      summary,
      kind: "terminal-done",
    };
  }

  if (target === "closed") {
    const execState = item.execState ?? null;
    const notDispatched = execState === null || execState === "queued";
    if (actor.kind !== "human") {
      return {
        target,
        ok: false,
        need: [],
        summary: "未派发项可关闭,需填写原因",
        kind: "terminal-closed",
        denyCode: "actor-denied",
      };
    }
    if (!notDispatched) {
      return {
        target,
        ok: false,
        need: [],
        summary: "未派发项可关闭,需填写原因",
        kind: "terminal-closed",
        denyCode: "already-dispatched",
      };
    }
    return {
      target,
      ok: true,
      need: [],
      summary: "未派发项可关闭,需填写原因",
      kind: "terminal-closed",
    };
  }

  if (target === "交付") {
    const need = ["commit", "links"];
    if (actor.kind !== "human") {
      return {
        target,
        ok: false,
        need,
        summary: "需 PR/commit 或链接至少一项(人工完成逃生口)",
        kind: "escape-delivery",
        denyCode: "actor-denied",
      };
    }
    if (current === "done" || current === "closed") {
      return {
        target,
        ok: false,
        need,
        summary: "需 PR/commit 或链接至少一项(人工完成逃生口)",
        kind: "escape-delivery",
        denyCode: "terminal-state",
      };
    }
    return {
      target,
      ok: true,
      need,
      summary: "需 PR/commit 或链接至少一项(人工完成逃生口)",
      kind: "escape-delivery",
    };
  }

  // Ladder targets: 待办 / 实施 / 测试 / 待人工评审.
  const currentRank = LADDER.indexOf(current);
  const targetRank = LADDER.indexOf(target);
  if (currentRank === -1 || targetRank === -1) {
    // current is a terminal state (done/closed) — no reopen path via this action.
    return {
      target,
      ok: false,
      need: [],
      summary: "终态工作项不能通过此通道回到执行阶段",
      kind: "blocked-terminal",
      denyCode: "terminal-state",
    };
  }
  if (targetRank > currentRank) {
    return {
      target,
      ok: false,
      need: [],
      summary: "正向阶段推进由回写通道(F9)驱动,不走本 action",
      kind: "forward-blocked",
      denyCode: "forward-not-allowed",
    };
  }
  // Backward — manual-override correction, human only.
  if (actor.kind !== "human") {
    return {
      target,
      ok: false,
      need: [],
      summary: "人工纠错回退(需说明原因)",
      kind: "manual-override",
      denyCode: "actor-denied",
    };
  }
  return {
    target,
    ok: true,
    need: [],
    summary: "人工纠错回退(需说明原因)",
    kind: "manual-override",
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Legal targets for this actor from the item's current guard state, WITH
 * evidence-requirement metadata for the S4 Select. Excludes the current state
 * itself (nothing to "transition to" if already there — noop is handled by
 * `assertTransition` directly, not offered as a menu choice) and excludes any
 * target this actor could never legally reach (agent callers get []).
 */
export function allowedTransitions(
  item: GuardWorkItem,
  actor: Actor,
): TransitionDescriptor[] {
  const current = currentGuardState(item);
  return ALL_GUARD_STATES.filter((t) => t !== current)
    .map((t) => describeTransition(item, t, actor))
    .filter((d) => d.ok);
}

/**
 * Assert a transition is legal for this actor + evidence. Returns `{noop:
 * true}` when target already equals the current guard state (idempotent,
 * zero writes — T-F3-10). Throws `TransitionGuardError` otherwise.
 */
export function assertTransition(
  item: GuardWorkItem,
  target: GuardState,
  actor: Actor,
  evidence: TransitionEvidence = {},
): { noop: boolean } {
  const current = currentGuardState(item);
  if (target === current) return { noop: true };

  const desc = describeTransition(item, target, actor);
  if (!desc.ok) {
    const code = desc.denyCode ?? "actor-denied";
    throw new TransitionGuardError(code, describeDenyMessage(code, desc), desc.need);
  }

  // desc.ok === true: actor + source-state eligibility cleared. Now check the
  // evidence payload against the target's specific requirement.
  if (target === "done") {
    if (evidence.verdict === "CHANGES_REQUESTED") {
      // Caller (transition-work-item.ts) should redirect target=done +
      // verdict=CHANGES_REQUESTED to a manual-override back to 实施 BEFORE
      // calling assertTransition — this is a defensive backstop.
      throw new TransitionGuardError(
        "changes-requested",
        "CHANGES_REQUESTED 不写 done —— 请改用回退到「实施」(评审驳回语义)",
      );
    }
    const need: string[] = [];
    if (evidence.verdict !== "PASSED") need.push("verdict");
    if (!isValidCommitRef(evidence.commit)) need.push("commit");
    if (need.length) {
      throw new TransitionGuardError(
        "evidence-missing",
        `缺少证据: ${need.join(", ")}`,
        need,
      );
    }
    return { noop: false };
  }

  if (target === "交付") {
    const need: string[] = [];
    if (!evidence.commit && !hasNonEmptyLinks(evidence.links)) {
      need.push("commit", "links");
    }
    if (need.length) {
      throw new TransitionGuardError(
        "evidence-missing",
        "需要 commit 或 links 至少一项",
        need,
      );
    }
    return { noop: false };
  }

  // closed / manual-override ladder backward: no evidence beyond `reason`,
  // which the action schema already enforces (z.string().min(4)).
  return { noop: false };
}

function describeDenyMessage(
  code: TransitionGuardErrorCode,
  desc: TransitionDescriptor,
): string {
  switch (code) {
    case "actor-denied":
      return `仅人工可执行该迁移(target=${desc.target})`;
    case "already-dispatched":
      return "已派发的工作项不能通过此通道关闭";
    case "forward-not-allowed":
      return "正向阶段推进由回写通道(F9)驱动,不走本 action";
    case "terminal-state":
      return "终态工作项不能再执行该迁移";
    case "invalid-source-state":
      return "done 仅可自「待人工评审」(验收)进入 —— 请先完成评审流转(02 §8)";
    default:
      return `迁移被拒绝(target=${desc.target})`;
  }
}
