/**
 * F9 — 回写通道专用身份判定。
 *
 * 设计权威：docs/sdlc-impl-f5-f10.md §5A（"两者均要求调用身份带 writeback 标记
 * (A2A JWT claim)，人工/普通 agent 调用拒绝"）+
 * docs/sdlc-product-design/02-workflows.md §8 守卫表（"实施→测试"/"→待人工评审"
 * 两行的合法写入方 = 回写通道，而非任意人工/agent）。
 *
 * ── 机制说明（本模块如何在不改 core 的前提下落实"JWT claim" 判据）──────────
 * `packages/core` 的 A2A JWT 校验（`mcp/build-server.ts` `verifyAuth`）目前只把
 * `sub` → `userEmail`、`org_id` → `orgId` 两个声明透传进请求上下文——没有任何
 * "自定义角色 claim → ctx" 的通路，新增一条要改 core（违反"不改 core"红线，
 * 也超出本次"tracker 侧"授权范围）。因此本模块**复用已有的 `sub` 声明**：
 * 约定一个保留哨兵邮箱 `WRITEBACK_ACTOR_EMAIL`（orchestrator 侧 reconciler 在
 * 铸造回调 tracker 的 A2A JWT 时，把 `sub` 设为这个哨兵值，`org_id` 设为该工
 * 作项的真实 orgId——后者沿用 `ownerScope()` 现有的 OR 语义即可放行，不需要
 * `sub` 等于真实 owner）。判定 = **双因子**：`ctx.caller === "mcp"`（跨应用
 * A2A `tools/call` 落地的调用面，区别于站内 agent 工具循环的 `"tool"` 与浏览
 * 器/CLI 等人工面）**且** 解析出的 `userEmail` 命中哨兵值。
 *
 * 这不是"文本约定"——`assertWritebackCaller` 是每个窄 action 运行时都会执行
 * 的真实判定，任何一个因子不对都会抛出结构化错误（T-F9-05）。
 *
 * 同时见 `transition-guard.ts` 的 `actorFromCaller`：它也识别这个哨兵邮箱，把
 * 回写身份的 `Actor.kind` 判为 `"agent"`——确保回写身份即便被人错误地拿去调
 * `transition-work-item`，也会被 F3 既有的 actor 门拒绝 done/closed/交付/回退
 * （T-F9-04），不需要给 transition-guard 再开一个特例分支。
 */

export type WritebackCallerLike =
  | {
      caller?: string | null;
      userEmail?: string | null;
    }
  | null
  | undefined;

const DEFAULT_WRITEBACK_ACTOR_EMAIL = "writeback@orchestrator.internal";

/** The reserved `sub` value the orchestrator's reconciler must mint into its
 *  outbound A2A JWT when calling the tracker's writeback-only actions.
 *  Overridable via env so a deployment can rotate it without a code change. */
export function writebackActorEmail(): string {
  return (
    process.env.WRITEBACK_ACTOR_EMAIL?.trim() || DEFAULT_WRITEBACK_ACTOR_EMAIL
  );
}

/** True when this call presents BOTH the cross-app MCP surface AND the
 *  reserved writeback identity. Either factor alone is not enough — a normal
 *  external MCP client (a human operating Claude Desktop, say) also arrives
 *  with `caller==="mcp"`, and a compromised/curious agent could try setting
 *  its own resolved email to the sentinel string from the frontend/http/cli
 *  surfaces (rejected because those aren't `"mcp"`). */
export function isWritebackCaller(ctx: WritebackCallerLike): boolean {
  if (!ctx) return false;
  if (ctx.caller !== "mcp") return false;
  return ctx.userEmail === writebackActorEmail();
}

export type WritebackGuardErrorCode = "actor-denied";

export class WritebackGuardError extends Error {
  readonly code: WritebackGuardErrorCode = "actor-denied";
  constructor(
    message = "此通道仅接受回写身份 (writeback actor) 调用 —— 人工/普通 agent 调用拒绝",
  ) {
    super(message);
    this.name = "WritebackGuardError";
  }
}

/** Throws `WritebackGuardError` unless `ctx` is the writeback channel. Call
 *  this FIRST, before any read/write, in every writeback-only action
 *  (T-F9-05: rejection leaves zero activity residue). */
export function assertWritebackCaller(ctx: WritebackCallerLike): void {
  if (!isWritebackCaller(ctx)) {
    throw new WritebackGuardError();
  }
}
