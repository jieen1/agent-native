# Orchestrator v3 — 分阶段实施规划 P2（修订版）

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 差异分析：[v3-GAP_ANALYSIS.md](./v3-GAP_ANALYSIS.md)
>
> **修订说明**：ACP adapter 完整实现（869 LOC），git-wrapper 完整实现。
> P2 从"ACP + warm pool + patch + git delivery"缩为"Patch + Fork + Tags + ACP 对接"。

---

## P2 — Patch 系统 + Run Fork + ACP 对接 + Tags + 可观测性

**目标**：mid-run DAG mutation（patch）、run fork（克隆+缓存）、Tags 约定、ACP 对接 V3、可观测性数据持久化。

**前置依赖**：P1（reconciler、dispatcher、workspace、SSE）

---

### 执行顺序

```
A. Patch 系统 (~2天)
   │
B. Run Fork (~1天)
   │
C. Tags 约定 (~0.5天)
   │
D. ACP 对接 V3 (~1天)
   │
E. 可观测性持久化 (~0.5天)
```

---

### 工作内容

#### A. Patch 系统（设计 §8.6）

**V2 无此能力**：V2 scheduler 一次性执行，无 mid-run DAG mutation。Patch 是 V3 核心增量。

**核心机制**：CAS 保护的 DAG 突变
```typescript
// server/engine/v3-patcher.ts
async function applyPatch(runId: string, dagVersion: number, mutations: DAGMutation[]) {
  // 1. 读取当前 v3_runs[runId].dag_version
  // 2. CAS 检查：dag_version 必须匹配（防止并发 patch 冲突）
  // 3. 应用 mutations 到 DAG 快照
  // 4. 验证 DAG 合法性（无环、deps 引用存在）
  // 5. 写入 v3_patches 表 + 递增 dag_version
  // 6. 发射 patch_applied 事件 → reconciler 响应
}
```

**Mutation 类型**（与设计 §8.6 对齐）：
- `modify_node` — 修改 `prompt`/`model_override`（**只**改这两项，不改 guard/output_schema/deps）
- `add_node` — 新增节点到运行中 DAG
- `remove_node` — 移除节点（必须是 pending 或 skipped，设计规则 2）
- `modify_loop` — 修改 loop 节点的 `max_iterations`/`until`
- `replace_dag` — 整体替换 DAG（约束：running/done 节点必须保持相同的 `node_id_in_dag` + `type`）

**无环检测**：`add_node`/`modify_node` 后，DFS 从新边 target 回到 source。`replace_dag` 做完整拓扑排序。

**Patch 冲突协议**：CAS 失败返回 `version_conflict` + `current_dag_version`。调用方读取新 DAG（`workflow.run.state`），基于最新版本重新构建 mutations，用新 `dag_version` 重试。单批次 mutations 是原子操作——要么全过，要么全不过。

**Reconciler 响应**：
- `patch_applied` 事件触发 tick
- 重新计算 ready 节点集
- 新增节点参与调度
- 已 resolved 节点不受影响
- **`running` 状态节点的修改**：如果 patch 移除了正在运行的节点，该节点按原路径完成，其结果不影响 downstream（因 edge 已被移除）

**v3_patches 表**：
```sql
CREATE TABLE v3_patches (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES v3_runs(id),
  dag_version_before INTEGER NOT NULL,
  dag_version_after INTEGER NOT NULL,
  mutations JSONB NOT NULL,
  applied_at TIMESTAMPTZ DEFAULT NOW(),
  applied_by TEXT,           -- user_id 或 'system'
  ...ownableColumns...
);
```

#### B. Run Fork（设计 §8.4）

**Fork 语义**：克隆 run + 复用已完成节点的 artifacts 作为缓存

```typescript
// server/engine/v3-fork.ts
async function forkRun(sourceRunId: string, options: ForkOptions): Promise<string> {
  // 1. 读取 sourceRun 的 DAG 快照、inputs、tags
  // 2. 创建新 v3_runs 行（状态=pending，DAG=克隆）
  // 3. 克隆 source 的所有 v3_nodes
  // 4. 对已 resolved 的节点，复制 v3_artifacts → 新节点直接 resolved
  // 5. 未完成的节点保持 pending，等待 reconciler 调度
  // 6. Copy source tags → 新 run tags
  // 7. 返回新 runId
}
```

**artifact 匹配规则**（设计 §8.4）：同 `node_id + type + iteration + fanout_index` 的节点自动复用 artifact，**不限于 `fromNode` 之前**。`fromNode` 控制"从哪个节点开始重置为 pending"。

**`fromNode` 语义明确**：`fromNode` 本身及其所有 transitive descendants 重置为 pending。`fromNode` 上游的 completed 节点如果 key 匹配，仍复用 artifact。

**Artifact 路径问题**：artifact 可能包含 VM 临时路径（如 `/tmp/vm-abc/output.md`），fork 后这些路径已失效。已知限制：路径类 artifact 需在 fork 时标记 `stale: true`，由新节点重新生成。

**Fork 选项**：
- `fromNode` — 从哪个节点开始重新执行（语义见上）
- `extraTags` — 附加标签（与 source tags **合并**，extraTags 覆盖同名字段）
- `overrideInputs` — 覆盖部分 inputs。pending 节点使用新 inputs 渲染，已复用 artifact 的节点不受影响

**Workspace**：fork 不克隆 source 的 workspace VM。fork 的 run 创建新 workspace 时重新 git clone + checkout。

**与 prune 的区别**：设计 §8.4 明确使用 clone + artifact cache，不是 prune-based。

#### C. Tags 约定（设计 §16）

**Tags 用途**：跨应用可追踪性（A2A 集成）

```typescript
// server/engine/v3-tags.ts
interface V3Tags {
  // 来源追踪
  source_app?: string;      // 发起方应用 ID
  source_run_id?: string;    // 发起方 run ID
  source_node_id?: string;   // 发起方节点 ID

  // 业务语义
  project_id?: string;
  work_item_id?: string;
  user_id?: string;

  // 自定义（不解释，透传）
  [key: string]: string | undefined;
}
```

**Tag 规则**（遵循设计 §16 的"opaque"语义）：
- Tags 是**不透明 JSONB**，orchestrator 逻辑不解释内容。不存在"继承"或"合并"。
- run 创建时：`workflow.run` 接收 `tags` 参数，原样写入 `v3_runs.tags`
- fork 时：copy source.run.tags → 新 run.tags，然后与 options.extraTags **合并**（extraKeys 覆盖同名字段）
- **无 tag 继承链**。spawn 不复制 tags；tags 是 run 级别的追踪字段

**Action 扩展**：
- `workflow.run` 接收 `tags` 参数
- `run.state` 返回 tags
- `runs.list` 支持 `?tagSource=app-name` 过滤（SQL：`tags->>'source_app' = 'app-name'`）

#### D. ACP 对接 V3（设计 §10.5）

**可复用**：`acp-adapter.ts`（869 LOC）完整 ACP adapter + session/update mapping + builtin presets。

**对接工作**：
1. **`registerBuiltinAcpHarnesses()` 启动时注册** — 确保 `acp:gemini`, `acp:claude-code` 等预设可被 `resolveAgentHarness()` 找到
2. V3 dispatcher 检测 `runtime: "acp:*"` 前缀（**字段名是 `runtime`，不是 `engine`**）
3. **调用 `resolveAgentHarness("acp:claude-code")`**（不是 `createAcpHarnessAdapter()`）— 通过注册表解析适配器，保持可扩展性
4. 通过 `startAgentHarnessRun` 执行，`onHarnessEvent` 回调写入 V3 表
5. Fork 结果写入 v3_spawns + v3_artifacts

**Session 状态**：ACP harness 使用 framework 的 `agent_harness_sessions` 表。V3 dispatcher 需要在 spawn 行记录 `session_id` 以便追踪。

**降级路径 — error 分类细化**：
- ACP harness **未注册**（配置错误） → error_class=permanent → 节点 skip
- ACP binary **未找到但可安装**（npm cache miss） → error_class=transient → 重试（重试失败 → 转为 permanent）
- ACP binary **无法安装** → error_class=permanent → 节点 skip
- ACP **网络连接失败** → error_class=transient → 重试
- ACP session **超时** → error_class=transient → 重试

**ACP stub 验证**：
- 未注册 → permanent；可安装的 transient → permanent 转换链符合预期

#### E. 可观测性数据持久化（设计 §14）

**现有**：V2 engine 有 node_runs 表 + events + artifacts。V3 需要写入 v3 表。

**Dispatcher 写入时机**：
1. **spawn 开始时**：写入 v3_spawns 行（含 `rendered_prompt`、`log_ref`）
2. **spawn 结束时**：写入 v3_artifacts（text_content / object_content）
3. **状态转换时**：reconciler 写入 v3_nodes.status
4. **v3_events** — 每 tick 由 reconciler 写入（含 seq_num）

**Action 扩展**：
- `spawn.logs` — 读取 spawn 日志（通过 `log_ref` 定位文件）
- `run.events` — 读取事件流
- `node.output` — 读取节点输出（从 v3_artifacts）

**TTL 策略**（P4 细化，P2 预埋）：`log_ref` 文件在 run 完成后 30 天自动删除；`v3_events` 按 run 保留（不设 TTL）。

---

### 验收标准

- [ ] **Patch apply**：CAS 保护，并发 patch 返回 `version_conflict`，调用方重试协议生效
- [ ] **5 种 mutation**（与设计 §8.6 对齐）：modify_node, add_node, remove_node, modify_loop, replace_dag
- [ ] **replace_dag 约束**：running/done 节点保持相同 node_id_in_dag + type
- [ ] **DAG 验证**：patch 后无环（DFS 检测），deps 引用存在
- [ ] **Reconciler 响应**：patch_applied 事件触发重新调度，新增节点参与
- [ ] **Run fork**：完整 clone DAG + artifact 复用（设计 §8.4 4-field key 匹配）+ 未完成的等待调度
- [ ] **Fork `fromNode`**：`fromNode` 及其 transitive descendants 重置 pending；上游已 resolved 的节点仍复用 artifact
- [ ] **Fork workspace**：fork 不克隆 workspace VM，新建时重新 git clone
- [ ] **Tags**：run 创建时原样写入 opaque JSONB，不解释
- [ ] **Tags 过滤**：`runs.list?tagSource=app-name`（SQL：`tags->>'source_app' = 'app-name'`）
- [ ] **ACP 对接**：`runtime: "acp:claude-code"` 走 ACP 路径。`registerBuiltinAcpHarnesses()` 启动时注册，`resolveAgentHarness()` 解析
- [ ] **ACP 降级**：未注册→permanent，npm 可安装→transient（retry→失败→permanent），超时→transient
- [ ] **Log capture**：spawn.log_ref 指向 VM 日志文件。`log_ref` 列存在于 v3_spawns（P0 迁移确认）
- [ ] **Rendered prompt**：每个 spawn 存储渲染后的 prompt
- [ ] **Event persistence**：v3_events 完整记录 run 生命周期

---

**与原版 P2 相比的变化**：
- 去掉 ACP runtime 从零搭建（复用 acp-adapter.ts 完整实现）
- 去掉 ACP session management（复用 harness/store.ts）
- 去掉 Git delivery 实现（复用 git-wrapper.ts）
- 去掉 Warm pool 从零搭建（复用 backpressure.ts VmSemaphore）
- 去掉 VM workspace（复用 microsandbox-runtime mount/init）
- Fork 从 prune-based 改为 clone+artifact-cache（匹配设计 §8.4）
- Mutation 类型从 P1 的 5 种替换为设计 §8.6 对齐的 5 种（modify_node/add_node/remove_node/modify_loop/replace_dag）
- Tags 从"继承链"改为设计 §16"opaque JSONB"，无 orchestrator 解释
- ACP 对接从 `createAcpHarnessAdapter()` 改为 `resolveAgentHarness()`（注册表模式）
- ACP error_class 细化（嘉变→永久）
- 工作量从 ~4 天扩为 ~5 天（Patch 系统是核心复杂度）