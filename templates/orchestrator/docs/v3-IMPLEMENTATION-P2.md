# Orchestrator v3 — 分阶段实施规划 P2

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 前置：[P1](./v3-IMPLEMENTATION-P1.md)（reconciler + dispatcher + ad-hoc spawn + workspace）

---

## P2 — Warm VM Pool + Patch 系统 + ACP Runtime + Run Fork + Pool Inspection

**目标**：提升调度效率（warm pool）、支持运行时 DAG 变异（patch）、接入 ACP 运行时（本地 CLI agent）、
支持 run fork（从运行中 DAG 分支出新 run）。

**前置依赖**：P1 Done（reconciler 跑通、dispatcher 完整、workspace 可用）。

---

### 工作内容

#### A. Warm VM Pool（设计 §10.2）

P1 按需启动 VM，P2 改为预热池。

- **Pool manager**：
  - 启动时预热 N 个 microVM（默认 4，`pool_capacity` 配置）
  - 预烤 image 复用 P0 spike 的 snapshot（避免每次 30-60s install）
  - Acquire：从 idle 队列取，mark busy
  - Release：**销毁**（VM single-use），不入池
  - 异步补位：release 后触发 replenish，保持 idle = N
  - 耗尽处理：spawn 等待 `pool_acquire_timeout_seconds`（默认 120s），超时 → `transient` error
- **Pool 健康监控**：
  - 定时 heartbeat 检测 idle VM 存活
  - 死 VM → 立即替换
  - 内存水位监控：total VMs × image_size < 主机可用内存 80%
- **配置参数**（`server/runtime/pool.ts`）：
  - `pool_capacity` — 预热数量（默认 4）
  - `pool_acquire_timeout_seconds` — 获取超时（默认 120）
  - `base_image_ref` — 预烤 image snapshot ID

#### B. Patch 系统（设计 §8.6, §9）

运行时 DAG 变异。CC 核心干预手段。

- **`workflow.patch(runId, expected_dag_version, ops[])`**：
  1. 验证 CAS：`run.dag_version == expected_dag_version`，不等 → 返回 `version_conflict`
  2. 逐 op 验证（见下方规则）
  3. 应用 op：更新 `run.dag` JSON，`dag_version += 1`
  4. 插入 `v3_patches` 行
  5. Emit `patch_applied` event → 触发 Reconciler 重计算
- **Op 类型**（设计 §8.6）：
  - `modify_node` — 修改 pending 节点的 prompt/model_override/guard/retry
  - `add_node` — 添加新节点（deps 必须引用已有节点，无环）
  - `remove_node` — 移除 pending 节点
  - `modify_loop` — 修改 loop 节点的 max_iterations/until
  - `replace_dag` — 替换完整 DAG（所有 running/done 节点必须保持 node_id + type 不变）
- **约束**：
  1. `modify_node` / `remove_node` 只作用于 `status = pending` 节点
  2. `add_node` 的 deps 引用必须存在，DFS 检测无环
  3. `replace_dag` 必须保留所有 running/done 节点的 `node_id_in_dag` + `type`
  4. CAS 保护：每次 patch 递增 `dag_version`，并发 patch 串行化
- **Reconciler 集成**：
  - `patch_applied` 事件触发 reconciler 重新加载 DAG
  - 新增 pending 节点进入 ready 计算
  - 已 dispatched 节点不受影响

#### C. ACP Runtime（设计 §10.5）

接入 framework ACP adapter，支持本地 CLI agent（如 Claude Code）作为 worker。

- **Dispatcher ACP 路径**（设计 §10.5）：
  1. 解析 `runtime: acp:<runtime>` → `resolveAgentHarness("acp:<runtime>")`
  2. 调用 `startAgentHarnessRun(adapter, spawn-spec)`
  3. 收集最终结果（string/object 合同同 microVM）
  4. 持久化 session state（framework `agent_harness_sessions`）
- **Workspace 支持**：ACP 的 `isolation: worktree` 对应 design §10.6 workspace
- **Engine 透传**：ACP agent 自带 engine，不需要 resolveEngine
- **输出合同**：同 microVM — string 默认，object 需 schema + ajv 验证

#### D. Run Fork（设计 §8.4）

克隆已有 run，复用已完成节点的 artifact 作为缓存。

- **`run.fork(runId, {inputs_override?, tags?, priority?})`**：
  1. 克隆原 run 的 DAG
  2. 插入新 `v3_runs` 行（status=pending, dag_version=1）
  3. 插入新 `v3_nodes` 行（完整克隆所有节点）
  4. **Artifact 缓存**：原 run 中 done 节点，如果新 run 有相同 `node_id_in_dag + type + iteration + fanout_index`，
     直接复用 artifact（不重新 spawn），新节点 status=done
  5. 其余节点 status=pending
  6. 新 run 的 inputs = 原 inputs + `inputs_override`
  7. Emit `run_started` → 触发 Reconciler
- **Patch 后 fork**：fork 可配合 patch 使用 — fork 后 patch 修改 pending 节点的 prompt/model/guard，
  实现 "复用已做工作 + 调整后续步骤" 模式

#### E. Pool / Dispatch Inspection（设计 §8.7）

- **`pool.status()`** — 返回 `{vms: {warm_idle, busy, capacity, queue_waiting}, replenishing}`
- **`dispatch.queue({runId?})`** — 返回等待队列：
  `{runId, nodeId, queued_at, waiting_for: "vm"|"acp"|"deps"|"approval"}`

#### F. Tags + A2A 标记约定（设计 §16）

支持跨应用追踪。不实现 A2A 传输层（那是 framework 职责），只实现 tag 约定和查询。

- **Tag 存储**：`v3_runs.tags`, `v3_spawns.tags`, `v3_workspaces.tags` 已为 JSONB
- **Tag 查询**：`runs.list({tag_match})`, `spawns.list({tag_match})`, `workspaces.list({tag_match})`
  实现 JSONB 部分匹配（Postgres `@>` 操作符）
- **Tag 约定验证**：所有 `workflow.run`, `spawn.once`, `workspace.create` 接受 tags 参数并透传

#### G. 观测数据持久化（设计 §14 Persisted）

P3 UI 需要的底层数据。P2 只建数据，不建 UI。

- **spawn_logs 存储**：每个 spawn 的 stdout/stderr 持久化（`v3_spawns` 加 `log_ref` 列指向文件或 FS path）
- **rendered_prompt 存储**：dispatcher 每次渲染后写入 `v3_spawns.rendered_prompt`（P1 已有，P2 验证）
- **events 表**：P1 已有 `v3_events`，P2 确保 patch_applied、fork 相关事件写入

---

### 验收标准（全勾选才 Done）

#### Warm VM Pool

- [ ] **预热成功**：启动后 `pool.status()` 显示 warm_idle=N（默认 4）
- [ ] **acquire/release 周期**：spawn 获取 VM → 用毕销毁 → 池自动补位回 N
- [ ] **热启时延**：warm VM acquire < 2s；冷启 VM acquire < 30s（对比 P0 spike 基线）
- [ ] **耗尽超时**：pool_acquire_timeout=5s → spawn 等待 5s 后 transient error
- [ ] **死 VM 替换**：kill idle VM → heartbeat 检测 → 自动补位
- [ ] **内存水位**：并发 N VMs 不超主机 80% 内存

#### Patch 系统

- [ ] **modify_node**：修改 pending 节点 prompt → 新 spawn 使用新 prompt
- [ ] **add_node**：新增节点 → reconciler 调度新节点
- [ ] **remove_node**：移除 pending 节点 → 不再调度
- [ ] **replace_dag**：完整替换 → running/done 节点不受影响，新节点生效
- [ ] **CAS 冲突**：并发 patch 第二次用旧 dag_version → 返回 version_conflict
- [ ] **约束检查**：modify running 节点被拒；add_node 成环被拒
- [ ] **patch_applied 事件**：reconciler 收到事件 → 重计算 ready set

#### ACP Runtime

- [ ] **ACP spawn 跑通**：`runtime: acp:<runtime>` → spawn 成功返回 output
- [ ] **输出合同一致**：ACP spawn 的 output_kind/artifact 格式同 microVM
- [ ] **workspace 支持**：ACP spawn 挂载 workspace worktree

#### Run Fork

- [ ] **fork 基本流程**：克隆 run → 新 run 含所有节点
- [ ] **artifact 缓存**：原 run 的 done 节点在新 run 直接复用 artifact（status=done，不重跑 spawn）
- [ ] **inputs_override**：fork 时覆盖 inputs → 新 run 使用覆盖值
- [ ] **DAG 独立**：修改 fork 后 run 的 DAG 不影响原 run
- [ ] **fork + patch 组合**：fork 后 patch 修改 pending 节点 → reconciler 只调度修改后的节点

#### ACP Runtime

- [ ] **ACP spawn 跑通**：`runtime: acp:<runtime>` → spawn 成功返回 output
- [ ] **输出合同一致**：ACP spawn 的 output_kind/artifact 格式同 microVM
- [ ] **workspace 支持**：ACP spawn 挂载 workspace worktree
- [ ] **ACP stub 降级**：framework acp-adapter 不可用时 → spawn error_class=permanent，不阻塞 microVM 路径

#### Pool Inspection

- [ ] **pool.status 返回正确**：idle/busy/capacity/queue_waiting 计数准确
- [ ] **dispatch.queue 过滤**：传 runId 只返回该 run 等待项

#### Tags

- [ ] **tag_match 查询**：`runs.list({tag_match: {source: "tracker"}})` 正确过滤
- [ ] **spawn tag_match**：`spawns.list({tag_match: {source: "tracker"}})` 正确过滤 ad-hoc spawns
- [ ] **tag 透传**：workflow.run/spawn.once/workspace.create 的 tags 写入对应 JSONB 列

#### 不变量

- [ ] **I4: 后端状态持久化** — patch 操作事务性（rollback 不丢半应用状态）
- [ ] **I8: 跨应用可调用** — tag 存储不依赖调用方身份（grep 验证 patch/tag 代码无 caller 检查）
- [ ] **I5: 完成节点不可变** — patch 不改 running/done 节点（约束已在 B 中验证）

---

**风险**：
- Warm pool 内存开销：4 个 prebaked VM × 500MB = 2GB 常驻 → 需监控水位
- Patch CAS 并发：多 CC 同时 patch 同一 run → 严格串行化 + 版本冲突回退
- ACP adapter 依赖 framework：framework 未发布 acp-adapter → P2 可降级为 stub，不影响 microVM 路径
- Fork 的 deps 断裂：从中间节点 fork 可能断裂 deps → 明确 render fail 语义，不静默跳过
