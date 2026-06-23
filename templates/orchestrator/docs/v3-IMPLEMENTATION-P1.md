# Orchestrator v3 — 分阶段实施规划 P1

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 前置：[P0](./v3-IMPLEMENTATION-P0.md)（spike go + scaffold 到位）

---

## P1 — Reconciler 引擎 + 完整 Spawn 调度 + Ad-hoc Spawn

**目标**：落地 v3 的核心执行引擎——Reconciler（事件驱动调度器）、Worker Dispatcher（完整 spawn 链路）、
ad-hoc spawn、workspace CRUD。无 run 级队列、无 patch、无 ACP。纯单机单 run 调度。

**前置依赖**：P0 Done（8 张表、spike go、基础 action、表达式解析器、插值渲染器）。

---

### 工作内容

#### A. Worker Dispatcher（设计 §10.3, §10.4, §6.2）

把 P0 spike 的 MVP 变成产品级 dispatcher。

- **输入**：spawn-spec（agent_name, rendered_prompt, tools, engine, model, output_schema?, max_summary_tokens, workspace_id?, secrets_env）
- **流程**（设计 §10.3 的 9 步，完整实现）：
  1. 解析 agent（`loadAgent` → system_prompt, tools, isolation, engine, model）
  2. 解析 engine（`resolveEngine` → base_url, model_id, api_key_env）
  3. workspace VM 挂载（isolation=workspace 时，复用 workspaces 表中的 VM）
  4. 从 warm pool 获取 VM（P1 简单实现：按需启动，warm pool 在 P2）
  5. 写 spawn-spec.json → `msb exec`
  6. Worker shim 跑 agent loop
  7. 读 output，schema 验证（ajv），truncate
  8. 持久化 artifact（`v3_artifacts`）
  9. 读 VM stdout/stderr → 写入 `v3_spawns.log_ref`（文件路径）
  10. 销毁 VM（非 workspace VM）
- **worker-shim.js 完整实现**（设计 §10.4）：
  - `anthropic` engine：`@anthropic-ai/sdk` + agent loop（tool_use → execute → tool_result）
  - `ai-sdk:openai` engine：`openai` SDK + 相同 loop
  - 6 个标准工具：Read, Edit, Write, Bash, Glob, Grep（路径限制在 /work 内）
  - Output extraction：string（默认）/ object（ajv 验证 + ONE self-correction）
  - `max_summary_tokens` 硬截断（设计 §11 Layer 3）
  - stderr 清洗：已知 key 前缀过滤（设计 §13）

#### B. Reconciler 核心（设计 §9）

事件驱动的 per-run 调度器。**单进程假设，无分布式锁**。

- **事件触发**（设计 §9）：`run_started`, `node_completed`, `node_resolved`, `patch_applied`（P2 接入）, `timer`, `cancellation_requested`, `pause_requested`, `resume_requested`
- **决策循环**（设计 §9 伪代码，完整实现）：
  1. 加载 run + DAG + nodes 状态（单事务）
  1a. 应用已接受的 patch（P2 接入，P1 留事件钩子）
  2. 检查 run.status（paused/cancelled/done/failed → return）
  2a. 若 status=pending → 设为 running，更新 started_at
  3. 计算 ready 集：遍历 dag.nodes，deps done + guard 为 true → ready
  4. guard 为 false → skip + cascade（仅依赖 skipped 节点的下游也 skip）
  5. 按 (run.priority desc, node.queued_at asc) 调度 ready 节点
  6. 调度限流：`parallel_over` 节点自有 `max_concurrency` 字段优先；per-run 全局 cap（默认 8）为上限
  7. spawn_done 处理：schema 验证 → artifact → node done → enqueue reconcile event
  8. spawn_failed 处理：错误分类（transient/permanent/cancelled）→ retry 或 fail
  9. 终止检测：全部节点 terminal → 有 failed 且无 `on_failure: continue` → run failed，否则 done
- **特殊节点类型处理**：
  - `parallel_over`：deps done 时 eval `items_from` → fanout body per item（设计 §4.2）
  - `loop`：body[0] 进迭代入口；body[last] done 后 eval `until` → 退出或下一轮（设计 §4.3）
  - `human_gate`：status = awaiting-approval，emit event（设计 §4.4, §9）
- **驱动点**：单 server-plugin tick（仿 `jobs/scheduler.ts` 60s loop），每次 tick 推进所有 active runs

#### C. Ad-hoc Spawn（设计 §8.1）

不关联 run 的轻量委派原语。CC 的主要调用方式。

- `spawn.once({agent, engine_override?, model_override?, runtime_override?, prompt, workspace?, output_schema?, max_summary_tokens?, timeout_seconds?, retry?, tags?, async?})`
  - async=false → 同步等待，返回 `{spawnId, output, output_kind, tokens_*, latency_ms}`
  - async=true → 立即返回 `{spawnId}`，需 poll `spawn.get`
- `spawn.get(spawnId)` — 返回 spawn 状态 + output
- `spawn.cancel(spawnId)` — 取消运行中的 spawn
- `spawn.log(spawnId)` — 返回 spawn 的 stdout/stderr
- `spawns.list({status?, agent?, runtime?, tag_match?, since?, limit?, offset?})`
  - `tag_match` 部分匹配 tags JSONB（设计 §8.1）

实现：直接调 Worker Dispatcher，不经过 Reconciler。ad-hoc spawn 的 `node_id` 为 NULL。

#### D. Workspace CRUD（设计 §8.2）

长生命周期 microVM 管理。

- `workspace.create({repo, branch?, owner_kind: "cc"|"run", owner_id?, tags?, keep_after_run?})`
  - 获取 VM，git clone/fetch，checkout branch，保持 VM 运行
  - 返回 `{workspaceId, vm_name}`
- `workspace.list({owner_kind?, owner_id?, state?, tag_match?})`
- `workspace.diff(workspaceId, {against?})` — 返回 git diff
- `workspace.files(workspaceId, {path?})` — 返回文件列表
- `workspace.read(workspaceId, path)` — 读文件内容
- `workspace.commit_push(workspaceId, {message, push_branch?})`
  - in-VM `git add . && git commit -m <message> && git push origin <push_branch>`
  - 返回 `{sha, branch, pushed}`
  - auth = `resolveSecret("GITHUB_TOKEN")` 注入 VM env（设计 §13）
- `workspace.destroy(workspaceId)` — 停止并销毁 VM

**生命周期**（设计 §8.2）：`run`-owned 在 run terminal 时自动销毁（除非 `keep_after_run`）；
`cc`-owned 仅显式销毁。

**多 spawn 串行化**：同一 workspace 的多个 spawn 写操作通过 dispatcher queue 串行（设计 §10.6）。

#### D1. Workflow Template CRUD（设计 §8.3）

P0 已有 `workflow.*` action 骨架。P1 扩展为完整模板管理：

- `workflow.save({name, dag, input_schema, description?})` — 完整验证：
  - DAG schema 验证（节点类型、deps 引用、无环）
  - 表达式语法检查（guard/until/items_from）
  - `output_schema` ajv compile 不抛
  - 写入 `v3_workflow_templates`，版本号自增，返回 `{id, version}`
- `workflow.get(name, version?)` — 默认返回最新版
- `workflow.list()` — 返回模板列表
- `workflow.delete(name)` — 删除模板

**不可变约束**：编辑创建新版本，已有 run 继续用旧版本（`v3_runs.template_version` 快照）。

#### E. Run 控制 Actions（设计 §8.4）

- `workflow.run({template, dag, inputs, tags?, priority?})` — P0 stub 扩展：
  - validate inputs against `input_schema`（ajv）
  - deep-clone `template.dag`
  - insert `v3_runs` 行（status=pending, dag_version=1）
  - insert `v3_nodes` 行（每节点一条，status=pending）
  - emit `run_started` event → 触发 Reconciler
- `run.cancel(runId)` — 设 status=cancelled，abort 所有 running spawns
- `run.pause(runId)` — 设 status=paused，停止调度新节点，running 的等完成
- `run.resume(runId)` — paused → 恢复调度
- `run.events(runId, since?)` — SSE 流，从 since 序列号开始
- `run.summary(runId)` — on-demand 合成：遍历所有 node output → 汇总（设计 §11，不 auto-compute）

#### F. Node 操作 Actions（设计 §8.5）

- `node.summary(runId, nodeId, {include?})` — 返回节点详情，可选 full_diff/full_log/schema
- `node.spawn_log(runId, nodeId, attempt?)` — 返回指定 attempt 的 spawn 日志
- `node.retry(runId, nodeId)` — 重置节点到 ready，重新 spawn
- `node.skip(runId, nodeId)` — 强制跳过节点，下游 cascade skip
- `node.resolve_gate(runId, nodeId, choice, note?)` — 解决 human_gate（设计 §4.4）
  - approve → 节点 done, output={choice, note}, 放行下游
  - reject → 节点 skipped, 下游 cascade skip

#### G. Restart Safety（设计 §9 Restart safety）

后端重启后的恢复。

- 启动时 scan `v3_runs.status IN ('pending', 'running', 'paused')`
- 每个 in-flight spawn：检查 VM 存活。若 VM 已死 → mark spawn cancelled → re-evaluate node retry
- Resume paused runs

#### H. Server Startup Plugin + 健康检查

V3 的服务器启动入口。解决 V2 scheduler 共存问题。

- **Nitro 插件**（`server/plugins/v3-reconciler.ts`）：
  - 注册为 server plugin，onReady 回调启动 reconciler tick
  - 60s loop，每次推进所有 active runs
  - 启动时执行 restart safety scan（G 节）
- **V2 scheduler 共存**：
  - V2 `server/plugins/runtime.ts` 调度 `workflow_runs`（LibSQL）
  - V3 `server/plugins/v3-reconciler.ts` 调度 `v3_runs`（Postgres）
  - 两表名不同，互不冲突；两个 tick 独立运行
  - V3 reconciler 只查 `v3_runs`，V2 scheduler 只查 `workflow_runs`
- **Host 健康检查**（启动时 + 定期）：
  - KVM 支持：检测 `/dev/kvm` 可访问
  - msb 可用：`msb version` 返回成功
  - 网络：ping host-gateway 地址（vLLM 可达）
  - 任一失败 → 日志警告，pool 不预热，spawn 返回 error="host_unavailable"
- **SSE 路由**（`run.events`）：
  - 独立 Nitro route `GET /_v3/runs/:runId/events?since=<seq>`
  - Content-Type: `text/event-stream`
  - 从 `v3_events WHERE run_id = $1 AND seq_num > $2 ORDER BY seq_num` 开始流式推送
  - 新事件到达时 via POST 触发
- **插值上下文构建器**（连接 interpolator 和 node deps）：
  - Reconciler 在 dispatch 前调用 `buildInterpolationContext(runId, nodeId)`
  - 查询 `v3_nodes` 找出该节点的 deps 列表中已 done 的节点
  - 对每个 dep，查 `v3_artifacts` 获取 output
  - 组装 context 对象 `{ inputs: run.inputs, deps: { A: { output: artifact.object_content | text_content }, ... }, iteration, item? }`
  - 传给 P0 插值渲染器 → 返回 rendered_prompt

#### I. Workspace VM 创建细节

- `workspace.create` 实现步骤：
  1. `msb exec` 获取 VM（不用 pool，workspace VM 独立）
  2. 在 VM 内 `git clone <repo> /work && git checkout <branch>`
  3. 保持 VM 运行（不销毁）
  4. 写入 `v3_workspaces` 行（state=active, vm_name）
  5. 返回 `{workspaceId, vm_name}`
- Dispatcher 挂载 workspace：spawn-spec 的 `workspace` 字段填 `{ mountedAt: "/work", vmName }`

---

### 验收标准（全勾选才 Done）

#### Dispatcher

- [ ] **完整 spawn 链路跑通**：固定 fixture agent + 固定 prompt → 成功返回 output。断言：
  - `v3_spawns` 行写入，status=done, output_kind=string/object, tokens_*>0, latency_ms>0
  - `v3_artifacts` 行写入，text_content 或 object_content 非空
  - `spawns.rendered_prompt` 存储完整渲染后 prompt
- [ ] **三输出路径**：string / object(schema 验证通过) / schema-violation（self-correction 一次后仍失败）
- [ ] **工具执行**：agent 使用 Read/Write/Bash 工具在 workspace 内操作文件；
  VM 内 `cat /work/test.txt` 可见、host 对应路径不存在（隔离可证）
- [ ] **max_summary_tokens 截断**：设 50 tokens → artifact `truncated=true`，byte_size < 150
- [ ] **stderr 清洗**：spawn log 中无 API key 明文（grep 验证）
- [ ] **workspace 多 spawn 串行化**：同 workspace 并发 2 spawn → 顺序执行（日志时间戳可证无重叠）

#### Reconciler

- [ ] **sequential DAG 跑通**：3 节点线性 DAG（A→B→C），journal 时间戳可证严格按序
  （A completed_at < B started_at < C started_at）
- [ ] **implicit parallel**：2 节点同 deps 无依赖 → 重叠 running（时间戳证并发）
- [ ] **guard 分支**：guard 为 false 的节点 → skipped；仅依赖该节点的下游 → cascade skipped
- [ ] **parallel_over fanout**：`items_from` 返回 3 元素数组 → 3 个 body spawn，
  `v3_nodes` 有 3 行 fanout_index=0,1,2
- [ ] **loop 迭代**：`until` 第 2 轮为 true → 恰好 2 次迭代（`v3_nodes.iteration` 可证）
- [ ] **human_gate**：节点到 awaiting-approval → `resolve_gate(approve)` 放行下游 / `resolve_gate(reject)` 分支 skip
- [ ] **run 终止**：全节点 terminal → run status=done/failed；
  有 failed 无 `on_failure: continue` → run failed
- [ ] **retry 机制**：transient error + retry.max=2 → 实际 3 次 spawn（attempt=1,2,3）；
  permanent error → 立即 fail，无 retry
- [ ] **timeout**：设 `timeout_seconds=5` → spawn 超时 → node failed, error_class=permanent（非 transient，不触发 retry）
- [ ] **pause/resume**：pause → 不再调度新节点；resume → 继续调度 pending 节点

#### Ad-hoc Spawn

- [ ] **sync spawn**：`spawn.once(async=false)` 返回完整结果
- [ ] **async spawn**：`spawn.once(async=true)` 立即返回 spawnId → poll `spawn.get` → done 结果
- [ ] **cancel spawn**：`spawn.cancel` → spawn status=cancelled
- [ ] **tag 查询**：`spawns.list({tag_match})` 正确过滤

#### Workspace

- [ ] **create → diff → commit_push → destroy 链路**：workspace 内创建文件 → diff 可见 → commit_push 成功 → destroy VM
- [ ] **run-owned 自动销毁**：run terminal 时 run-owned workspace 自动 destroyed
- [ ] **cc-owned 不自动销毁**：run terminal 时 cc-owned workspace 仍 live

#### Run 控制

- [ ] **workflow.run 完整流程**：template → run → reconciler 驱动 → done。
  `v3_runs` 行 completed_at 写入
- [ ] **input_schema 校验**：workflow.run 传入无效 inputs → 拒绝，不创建 run 行
- [ ] **cancel run**：`run.cancel` → run cancelled，不再调度新节点
- [ ] **run.summary on-demand**：调用返回汇总，不调用则无合成（无 auto-compute，设计 §11）
- [ ] **run.events SSE**：事件流包含 run_started, node_ready, node_done, run_done

#### Node 操作

- [ ] **node.retry**：重试节点 → 新 spawn（attempt+1），下游重调度
- [ ] **node.skip**：强制跳过 → 下游 cascade skip
- [ ] **node.summary**：返回完整节点信息

#### Restart Safety

- [ ] **重启恢复**：杀进程时一 run 含 done+running 混合 → 重启后 done 节点不重跑、
  running 节点 VM 已死 → spawn cancelled → 按 retry 策略处理
- [ ] **paused run 恢复**：重启后 paused run 恢复调度

#### 不变量（设计 §18, §0）

- [ ] **I2: spawn 上下文隔离** — spawn 只看到 4 项输入（system_prompt, rendered_prompt, tools, workspace），
  看不到 DAG、其他节点输出、run 状态（grep 验证 dispatcher 代码不传入多余参数）
- [ ] **I7: 无隐式跨节点注入** — 后端不 auto-dump deps 进 prompt。下游只看到作者显式写的 `{{deps.X.output.Y}}`
  （断言：节点 B 的 `deps` 不包含 A 的 output，除非 B 的 prompt 有 `{{deps.A.output}}`）
- [ ] **I5: 完成节点不可变** — running/done 节点的 artifact 不可修改（artifacts 表 append-only）
- [ ] **I6: 后端不推理 task** — 无 task 状态机、无 "task done" 信号、无 run 边界 auto-summary
  （grep 验证 reconciler 代码无 auto-summary 逻辑）

#### Template CRUD（新增）

- [ ] **workflow.save 验证**：DAG schema + 表达式语法 + output_schema compile 全部通过才写入
- [ ] **模板不可变性**：编辑创建新版本（version+1），已有 run 继续用旧 template_version（快照可证）
- [ ] **parallel_over max_concurrency**：`parallel_over` 设 `max_concurrency: 2` → 最多 2 个 fanout 子节点并发

#### Server Startup + 健康检查

- [ ] **Plugin 启动**：server onReady → reconciler tick 启动，日志可证
- [ ] **V2 共存**：V2 scheduler 仍运行 V2 runs，V3 reconciler 只调度 v3_runs（grep 验证无交叉查询）
- [ ] **健康检查**：启动时检测 KVM/msb/网络 → 失败 → pool 不预热，日志警告
- [ ] **pending→running**：reconciler 首次 tick pending run → status 变为 running

#### SSE

- [ ] **SSE 流**：`GET /_v3/runs/:runId/events` → 返回 text/event-stream
- [ ] **SSE since**：`?since=3` → 从 seq_num=4 开始推送
- [ ] **事件完整**：run_started → node_ready → node_done → run_done 全部到达浏览器

#### 插值上下文

- [ ] **deps 插值**：节点 B deps=[A]，A 的 output 含 `{plan: "do X"}`，B 的 prompt `{{deps.A.output.plan}}` → 渲染为 "do X"
- [ ] **inputs 插值**：`{{inputs.repoUrl}}` → 渲染为 run.inputs.repoUrl
- [ ] **undefined 路径**：`{{deps.A.output.nonExistent}}` → render fail，node failed

#### Workspace VM

- [ ] **VM 创建**：workspace.create → VM 启动 + git clone 完成 → 返回 workspaceId
- [ ] **VM 挂载**：spawn 带 workspace_id → VM 内 /work 可见 repo 内容

---

**风险**：
- Reconciler 并发竞态：同一 run 的多 tick 可能重复调度 → 以 `nodes.status` 原子 UPDATE 防双重分发（设计 §18）
- Worker shim 复杂度：完整 agent loop + 6 工具 ≈ 300-500 LOC → 以 P0 spike 为基础逐步添加
- `parallel_over` fanout 宽度不确定：items_from 数组长度动态决定 → fanout 子树管理（P2 resume 需处理）
- workspace 并发写：同 workspace 多 spawn → dispatcher queue 串行化，P1 验证无竞态
