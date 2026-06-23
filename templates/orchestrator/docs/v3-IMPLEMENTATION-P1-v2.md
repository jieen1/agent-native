# Orchestrator v3 — 分阶段实施规划 P1（修订版）

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 差异分析：[v3-GAP_ANALYSIS.md](./v3-GAP_ANALYSIS.md)
>
> **修订说明**：基于最新分支代码重新评估。NodeRunner、git-wrapper、vm-creds、networking 全部已有。
> P1 从"构建核心引擎"缩为"V3 reconciler + 对接现有 runtime"。

---

## P1 — V3 事件驱动 Reconciler + Spawn 对接 + Server 启动

**目标**：基于现有 NodeRunner 建立 V3 的事件驱动 reconciler；对接 workspace、auth、网络；完成 server 启动。

**前置依赖**：P0（双数据库、V3 表、表达式引擎、action 骨架）

---

### 执行顺序

```
A. V3 Reconciler 核心 (~2-3天)
   │
B. 对接现有 Runtime (~1天)
   │
C. Workspace + Auth + 网络 (~0.5天)
   │
D. Server 启动 + SSE + 健康检查 (~1天)
   │
E. 插值上下文 + ad-hoc spawn (~1天)
```

---

### 工作内容

#### A. V3 事件驱动 Reconciler 核心（设计 §9）

**现有 scheduler 不适用**：V2 `scheduler.ts` 是一次性执行，不支持 mid-run patch/pause。V3 需要事件驱动 tick。

**核心差异**：
| | V2 Scheduler | V3 Reconciler |
|---|---|---|
| 执行模型 | 一次性 `executeRun()` 到结束 | 事件 tick，可暂停/恢复 |
| mid-run 干预 | 不支持 | patch, pause, resume, fork |
| 状态持久化 | 内存 + 写入 node_runs | 每 tick 写 v3_nodes.status |
| 事件循环 | 无 | 监听 v3_events → 决策 → 调度 |

**实现**：`server/engine/v3-reconciler.ts`

```typescript
// 简化结构
class V3Reconciler {
  constructor(db: DrizzleV3, executor: NodeExecutor) {}

  // 主循环：事件驱动 tick
  async tick(runId: string): Promise<void> {
    // 1. 读取 run 状态
    // 2. 收集待调度节点 (ready = deps 全完成)
    // 3. 根据节点类型决策 (agent → spawn, parallel_over → fanout, loop → iterate, human_gate → wait)
    // 4. 调度 spawn 或推进状态
    // 5. 写入 v3_nodes / v3_events
  }

  // 事件触发 tick
  onEvent(runId: string, event: V3Event): void { ... }

  // pause/resume
  async pause(runId: string): Promise<void> { ... }
  async resume(runId: string): Promise<void> { ... }
}
```

**Tick 流程详细步骤**：
0. **Acquire lock**：`SELECT pg_try_advisory_lock(hashtext(runId))` — 失败说明另有 tick 在执行，直接返回。锁在 tick 结束时 `SELECT pg_advisory_unlock(hashtext(runId))`
1. 读取 `v3_runs[runId]`，检查 status (paused → skip, completed/failed → skip, pending/running → continue)
2. 读取 `v3_nodes` 中该 run 的所有节点
3. **检测失败节点**：
   - 有 `status=failed` 的节点 → 对其所有 downstream 设置 `status=skipped, error_class=permanent`
   - failed 节点不可恢复 → 设置 run status=failed，写入 `run.failed` 事件 → 返回
4. 找出 ready 节点（所有 deps 状态 = resolved **或** skipped）。dep 未完成 → 节点保持 pending，不进入 ready 队列
5. 对每个 ready 节点：
   - **agent**：构建插值上下文 → 调度 spawn → 设置 `running`
   - **parallel_over**：解析 `items_from` → 创建 fanout children（状态 `pending`，非 `ready`，等下个 tick）
   - **loop**：求值 `until` 表达式（数据来自 `deps.NODE.previous_iteration.output`）。真 → resolve；假 → 新 iteration。超过 `max_iterations`（默认 100）→ resolve + 警告
   - **human_gate**：设置 `waiting_human`
6. 检查 run 完成条件：
   - 所有非-skipped 节点 resolved → `completed`，写入 `run.completed` 事件
   - 任何 failed → `failed`，写入 `run.failed` 事件
7. 写入 `v3_events`。`seq_num` 由 tick 内部计数器递增（非 DB auto-increment）

**并发控制**：
- **Postgres advisory lock 确定性选择**（不用 Redis，减少依赖）：`SELECT pg_try_advisory_lock(hashtext(runId))`。PG connection 自动持有，连接断开自动释放（无死锁）。每个 tick 一个 PG 连接，锁作用域 = 整个 tick 事务
- `max_concurrency`：全局通过 `v3_runs` 的 `active_spawns` 字段原子计数（`SELECT ... FOR UPDATE`），per-node 字段优先覆盖

**V3 vs V2 Node type adapter**：
V3 node type（`agent | parallel_over | loop | human_gate`）需要转换为 NodeRunner 可接受的 `Node` 对象。Adapter 层在 dispatcher 内部完成类型映射。

#### B. 对接现有 Runtime（复用 NodeRunner）

**可复用组件**：
| V3 需要 | 现有实现 | 对接方式 |
|---|---|---|
| Worker dispatch | `node-runner.ts` (7-stage NodeRunner) | 直接调用 `NodeRunner.run(node, context)` |
| VM provision/teardown | `microsandbox-runtime.ts` | NodeRunner 内部已调用 |
| Worker shim (agent loop) | `executors/engine-loop.ts` + `claude-code-executor.ts` | 通过 acting-bridge 挂载 |
| Tool surface | `acting-bridge.ts` | V3 channel 限制 tools 数组（设计 §6.2） |
| Error/retry | NodeRunner `onFailure` + `retry.max` | 映射 V3 error_class → onFailure 策略 |
| Git operations | `git-wrapper.ts` | workspace 创建/提交时调用 |
| Credentials | `vm-creds.ts` (`mountVmCredentials`) | mount 阶段注入 |
| VM networking | `networking.ts` | provision 阶段配置 |

**V3 适配层**：`server/engine/v3-dispatcher.ts`
- 封装 NodeRunner 调用，增加 V3 channel contract 约束
- 限制 spawn 输入为 4 项（system_prompt, rendered_prompt, tools, workspace）
- 输出路径：string / object(schema 验证) / schema-violation → 映射到 v3_artifacts
- `max_summary_tokens` 截断
- 写入 v3_spawns 表（含 log_ref）

**Error class 映射**：

现有 `onFailure` 只接受 `rollback | recreate | keep`。V3 error_class 需映射到此 3 值：

```
V3 error_class                                → onFailure
transient (API error, 网络错误, OOM kill)    → rollback    (同 VM 重试)
permanent (timeout, schema 违反)              → keep        (标记 failed，不进重试队列)
workspace_error (VM 崩溃, mount 失败)        → recreate    (销毁 VM，重建)
```

dispatcher 的 catch 块根据 NodeRunner 返回的 `onFailure` 结果写入 v3_spawns.error_class，reconciler 的 step 3 据此判断是否可恢复。

#### C. Workspace + Auth + 网络（已有，只需对接）

**Workspace 创建**（设计 §8.2）— 复用 `git-wrapper.ts`：
```typescript
// server/engine/v3-workspace.ts
async function createWorkspace(runId: string, repoUrl: string, branch: string) {
  // 1. MicrosandboxRuntime 实例创建 VM
  // 2. git-wrapper.cloneRepo() — 传入 GitContext（含 exec、工作目录、VM handle）
  // 3. git-wrapper.checkoutRunBranch()
  // 4. vm-creds.mountVmCredentials() — 注入 .claude + GITHUB_TOKEN
  // 5. networking.resolveEgress() — DNS fix + NO_PROXY（**不是** configureEgress）
  // 6. 写入 v3_workspaces 表
}
```

**关键参数**：
- `keep_after_run: boolean` — 是否保留 workspace
- `tag_match` — 按标签筛选 workspace
- `mountSpec` — 挂载配置（复用 node-runtime.ts MountSpec 接口）

#### D. Server 启动插件 + SSE + 健康检查

**Server 启动插件**：`server/plugins/v3-reconciler.ts`
- Nitro plugin，应用启动时注册
- 启动 reconciler 主循环
- 注册 V3 SSE route
- 注册 V3 health check route

**SSE route**：`GET /_v3/runs/:runId/events?since=<seq>`
- 读取 `v3_events` 表，按 `seq_num > since` 过滤
- EventSource streaming，保持连接
- 事件类型：`run.created`, `run.started`, `node.ready`, `spawn.started`, `spawn.completed`, `node.resolved`, `run.completed`, `run.failed`, `patch_applied`

**健康检查**：`GET /_v3/health`
- Postgres 连接检查（`getV3Db()` ping）
- msb CLI 可用性检测
- KVM 后端检测（WSL2 环境）
- 网络 egress 检测
- 返回 JSON 健康报告

#### E. 插值上下文 + Ad-hoc spawn

**插值上下文构建**（设计 §5.1, §6.4）：`buildInterpolationContext(runId, nodeId)`
```typescript
async function buildInterpolationContext(runId: string, nodeId: string): Promise<Record<string, unknown>> {
  // 1. 读取 v3_nodes 中 nodeId 的 deps 列表
  // 2. 对每个 dep，读取 v3_artifacts 中对应 output
  // 3. 构建 deps 对象: { depId: { output: artifactData } }
  // 4. 读取 v3_runs[runId].inputs 作为顶层 context
  // 5. 合并返回
}
```

**插值渲染**：`renderTemplate(template, context)`
- 扫描 `{{ ... }}` 占位
- 解析路径表达式（`deps.X.output.Y`）
- 类型规则：string→verbatim, number→literal, object→JSON.stringify
- undefined → render fail → node error

**Ad-hoc spawn**（设计 §8.1）：`spawn.once/get/cancel`
- 不关联 run 的轻量 worker 调用
- 复用 NodeRunner，不传 runId
- 结果写入 v3_spawns（runId 为空）+ v3_artifacts
- Action: `spawn.once`, `spawn.get`, `spawn.cancel`

---

### 验收标准

- [ ] **Reconciler tick**：独立 tick 调度 ready 节点，失败节点 cascade skip downstream，写入 v3_nodes/v3_events
- [ ] **Advisory lock**：`pg_try_advisory_lock(hashtext(runId))` —— 两个并发 tick 只有一个执行
- [ ] **4 种节点类型**：agent → spawn, parallel_over → fanout(child pending), loop → iterate(max_iterations 上限), human_gate → wait
- [ ] **Pause/Resume**：run.pause() 停止 tick，run.resume() 恢复。暂停/恢复发射 `run.paused`/`run.resumed` 事件
- [ ] **Node type adapter**：V3 `agent|parallel_over|loop|human_gate` → NodeRunner `Node` 对象类型映射
- [ ] **Channel contract**：spawn 输入限制 4 项，输出 3 路径（string/object/schema-violation）验证。array/null 等 → schema-violation
- [ ] **Error mapping**：transient→rollback, permanent→keep, workspace→recreate。3+1 场景（OOM kill → transient→rollback）
- [ ] **Workspace 创建**：VM + git clone + branch + creds + networking 全自动。`resolveEgress()` 正确调用
- [ ] **NodeRunner 集成**：v3-dispatcher 调用 NodeRunner，结果写入 v3_spawns/v3_artifacts
- [ ] **插值上下文**：`buildInterpolationContext` 正确聚合 deps output。dep 未完成 → 节点不进入 ready 队列（reconciler step 4 保证）
- [ ] **插值渲染**：`{{deps.X.output.Y}}` 四种类型路径全覆盖。artifact 字段映射（`text_content`/`object_content` → `output` resolver）
- [ ] **SSE route**：`GET /_v3/runs/:runId/events` 实时推送。事件含 `run.paused`/`run.resumed`/`node.failed`/`spawn.failed`
- [ ] **Health check**：`GET /_v3/health` 返回完整健康报告
- [ ] **Ad-hoc spawn**：`spawn.once` 独立于 run 可调用

---

**与原版 P1 相比的变化**：
- 去掉 Worker Dispatcher 从零搭建（复用 NodeRunner）
- 去掉 VM provision/teardown 实现（复用 MicrosandboxRuntime）
- 去掉 Worker shim 实现（复用 engine-loop + claude-code-executor）
- 去掉 Git workspace CRUD（复用 git-wrapper）
- 去掉 Auth/secrets 实现（复用 vm-creds）
- 去掉 VM networking（复用 networking.ts）
- 去掉 Error/retry 逻辑（复用 NodeRunner onFailure）
- 新增 V3 reconciler（事件驱动，真正的增量架构）
- 新增 V3 dispatcher（适配层，封装 NodeRunner）
- 新增插值上下文构建器
- 工作量从 ~5 天缩为 ~5 天（reconciler 是核心复杂度）
