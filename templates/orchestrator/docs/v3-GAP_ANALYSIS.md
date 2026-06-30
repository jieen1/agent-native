# Orchestrator v3 — 现有代码 vs 设计差异分析

> 基于最新分支代码（2026-06-22）与 v3-DESIGN.md 的逐项对照
>
> **结论：大量 V3 设计能力已有实现。V2 的 runtime/engine 架构已覆盖 V3 核心。
> 实施规划需从"从零搭建"调整为"迁移+对接"。**

---

## 已有实现（不需从零做）

| V3 设计 § | 现有实现 | 成熟度 |
|---|---|---|
| §10.2 microVM pool | `server/runtime/microsandbox-runtime.ts` — 完整 7 阶段 NodeRunner | ✅ 产品级 |
| §10.3 single-spawn lifecycle | `server/runtime/node-runner.ts` — provision/mount/init/execute/collect/extract/teardown | ✅ 产品级 |
| §10.4 worker shim | `server/runtime/executors/engine-loop.ts` + `claude-code-executor.ts` — agent loop + tool execution | ✅ 产品级 |
| §7.1 agent resolution | `.claude/agents/*.md` frontmatter + framework loader | ✅ P0 可复用 |
| §7.2 engine resolution | `resolveEngine()` + `executor-choice.ts` choice judge | ✅ P0 可复用 |
| §10.5 ACP runtime | `packages/core/src/agent/harness/acp-adapter.ts` (869 LOC) — 完整 ACP adapter | ✅ 产品级 |
| §10.5 ACP presets | `acp-builtin.ts` — `acp:gemini`, `acp:claude-code` 预设 | ✅ 产品级 |
| §10.5 ACP session | `packages/core/src/agent/harness/store.ts` — session CRUD + status tracking | ✅ 产品级 |
| §8.1 ad-hoc spawn | Framework subagent + `spawn.once` 通过 MCP action 暴露 | ⚠️ 需 V3 格式 |
| §8.2 workspace | `git-wrapper.ts` — clone/checkout/add/commit/push/openPr 完整实现 | ✅ 产品级 |
| §8.3 workflow templates | `v3_workflow_templates` 表 (V3 naming) + V2 `workflow_templates` 已有 CRUD | ⚠️ 需 V3 schema |
| §8.4 run lifecycle | `executeRun()` + `Scheduler` — 完整 run 执行 + status 管理 | ✅ 产品级 |
| §8.5 node operations | Scheduler 支持 retry/skip/human_gate + control.ts resolvers | ✅ 产品级 |
| §8.6 patch | 未实现 — V2 无 runtime DAG mutation | ❌ 需新增 |
| §9 reconciler | `scheduler.ts` — 确定性调度器（非事件驱动，但功能等效） | ⚠️ 架构不同 |
| §10.6 workspace VM | `microsandbox-runtime.ts` mount+init — git clone + branch + creds | ✅ 产品级 |
| §12 error/retry | `onFailure: rollback\|recreate\|keep` + `retry.max` in NodeRunner | ✅ 产品级 |
| §13 auth/secrets | `vm-creds.ts` — `~/.claude` mount + `GITHUB_TOKEN` Vault resolve | ✅ 产品级 |
| §14 observability | v2 engine 有 node_runs 表 + events + artifacts | ⚠️ 需 V3 表 |
| §16 tags | 未实现 — V2 无 tag 约定 | ❌ 需新增 |
| §10.2 warm pool | `backpressure.ts` — VmSemaphore + acquire timeout | ⚠️ 部分实现 |
| §7.4.9 VM egress | `networking.ts` — DNS fix + NAT/代理选择 + NO_PROXY | ✅ 产品级 |

## 架构差异（关键发现）

### 1. Reconciler vs Scheduler

V3 设计 §9 的 **事件驱动 reconciler** 与现有 **确定性 scheduler** 架构不同：

- **现有 scheduler**（`scheduler.ts`）：一次性执行完整 DAG 到结束。`executeRun()` 同步调用，返回 `RunOutcome`。适合 V2 work-item 模式。
- **V3 reconciler**：事件驱动 tick，支持暂停/恢复/patch 中间干预。`run.pause()` / `workflow.patch()` 需要中间状态。

**影响**：V3 的 patch/fork/pause 需要事件驱动模型。现有 scheduler 不支持 mid-run 干预。
**策略**：保留现有 scheduler 作为 V2 兼容层；V3 需要新建事件驱动 reconciler 或扩展 scheduler。

### 2. Data Model

V2 用 LibSQL + V2 表名。V3 需要 Postgres + `v3_*` 前缀表。
**现有 `getDb()` 用 LibSQL**。P0 双数据库策略正确。

### 3. Node types

V3 设计 4 种节点：`agent`, `parallel_over`, `loop`, `human_gate`
V2 scheduler 支持的节点：`agent`, `tool`, `start`, `end`, `join`, `parallel`, `fanout`, `branch`, `subworkflow`

**差异**：V3 的 `parallel_over` ≈ V2 `fanout`；V3 `loop` ≈ V2 `join`+iteration；V3 `human_gate` ≈ V2 human gate。
命名不同但语义可映射。V3 需要 adapter 层。

### 4. Channel Contract

V3 的 channel contract（4 输入 / string-or-object 输出）与 V2 的 deps injection 不同。
**现有 scheduler 的 deps 传递**：`deps: Record<string, unknown>` — 这已经接近 V3 的 `{{deps.X.output.Y}}`。
**策略**：P1 在 prompt render 阶段实现 V3 插值，deps 对象从 scheduler 传入。

---

## 实施规划修订

### P0 不变
- Spike 仍需做（验证 worker-shim 在 V3 channel contract 下的可行性）
- 双数据库策略 + 8 张 V3 表 — 仍需
- 表达式解析器 + 插值渲染器 — 仍需（V2 用 conditions.ts 的 evalCondition，V3 需要独立解析器）

### P1 大幅缩减
**可复用的（不需新建）**：
- Worker Dispatcher → 复用 `node-runner.ts` 7-stage NodeRunner
- Worker shim tools → 复用 `executors/engine-loop.ts` + `acting-bridge.ts`
- Workspace CRUD → 复用 `git-wrapper.ts` + `microsandbox-runtime.ts` mount/init
- VM provision/teardown → 复用 `MicrosandboxRuntime`
- Error/retry → 复用 NodeRunner `onFailure` + `retry.max`
- Auth/secrets → 复用 `vm-creds.ts`
- VM egress → 复用 `networking.ts`

**仍需新建的**：
- V3 reconciler（事件驱动，支持 mid-run patch/pause）
- V3 channel contract enforcement（4 输入限制 + 输出验证）
- Ad-hoc spawn（`spawn.once/get/cancel` — 不关联 run 的轻量调用）
- `buildInterpolationContext`（deps → V3 `{{deps.X.output.Y}}` 格式）
- Server startup plugin + SSE route
- Health check

### P2 大幅缩减
**可复用的**：
- ACP runtime → `acp-adapter.ts` 完整实现，只需对接 V3 dispatcher
- Warm pool → `backpressure.ts` 已有 VmSemaphore，需扩展为 warm pool manager
- Git delivery → `git-wrapper.ts` 完整实现

**仍需新建的**：
- Patch 系统（V2 无此能力）
- Run fork
- Pool inspection actions
- Tags 约定

### P3 P4 基本不变
P3 UI + P4 硬化基本不受影响。

---

## 总结

| 类别 | 行数估算 |
|---|---|
| V3 设计从零搭建 | ~15,000 LOC |
| 现有可复用代码 | ~10,000 LOC |
| 实际需要新建 | ~5,000 LOC |
| **工作量减少** | **~65%** |

核心调整：从"搭建"变为"迁移+对接"。V3 的新增能力（patch/fork/tags/event-driven reconciler）是真正的增量工作。
