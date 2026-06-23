# Orchestrator v3 — 分阶段实施规划 P3

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 前置：[P2](./v3-IMPLEMENTATION-P2.md)（warm pool + patch + ACP + fork + pool inspection）

---

## P3 — Web UI 表面

**目标**：为所有后端能力提供人机操作界面。设计 §14 "For humans" 完整覆盖。
纯展示 + 操作入口，不改变后端逻辑。

**前置依赖**：P2 Done（所有 action 可调用、pool/patch/fork 可用、观测数据持久化）。

---

### 工作内容

#### A. Runs List（设计 §14 "For humans"）

- 表格视图：runId, template, status, priority, tags, started_at, completed_at, duration
- 状态过滤：running / paused / done / failed / cancelled
- Tag 过滤：输入 JSON 子集，调用 `runs.list({tag_match})`
- 点击行 → 导航到 Run View

#### B. Run View（设计 §14）

单 run 详情页：

- **DAG 可视化** — 节点拓扑图（非交互式编辑器，只读展示）
  - 节点形状区分 type（agent/parallel_over/loop/human_gate）
  - 节点颜色区分 status（pending/running/done/failed/skipped）
  - 连线 = deps 关系
  - 点击节点 → 右侧 Inspector 面板
- **Per-node Inspector** — 点击节点后展开：
  - 基本信息：nodeId, type, status, iteration, fanout_index
  - Output：调用 `node.summary(runId, nodeId)`
  - Spawn log：调用 `node.spawn_log(runId, nodeId, attempt)`
  - 操作按钮：retry / skip / resolve_gate（仅 human_gate）
- **Patch History** — 调用 `v3_patches` 表，显示 patch 时间线（actor, reason, ops）
- **Event Feed** — SSE 订阅 `run.events(runId)`，实时滚动
- **Workspace Diff** — 如果 run 关联 workspace，显示 `workspace.diff(workspaceId)`

#### C. Spawn List

- 表格视图：spawnId, runId/null, nodeId, agent, status, output_kind, latency_ms, tokens, created_at
- 过滤：run-scoped / ad-hoc, status, agent name, tag_match
- 点击行 → 展开 spawn 详情（rendered_prompt, output, log）

#### D. Workspaces List

- 表格视图：workspaceId, owner_kind, owner_id, repo, branch, state, vm_name, created_at
- 过滤：owner_kind, state
- 操作：destroy（仅 live workspace）

#### E. Templates Editor

- 模板列表：name, version, description, created_at
- 创建/编辑表单：
  - name, description, input_schema（JSON Schema 编辑器）
  - DAG 编辑器：JSON 输入（非图形拖拽，v3 不做图形编辑器，设计 §19）
  - 保存时调用 `workflow.save`，前端显示验证错误
- 版本历史：`workflow.list` + `workflow.get(name, version)`
- 删除：`workflow.delete`

#### F. Agents Directory（设计 §14）

只读目录，展示 `.claude/agents/*.md`：

- 列表：agent name, description, runtime, engine, model, tools, isolation
- 详情：完整 .md 文件内容（Markdown 渲染）
- 不可编辑（agent 编辑走框架子代理管理）

#### G. Pool Dashboard（设计 §14）

- 实时指标：warm_idle, busy, capacity, queue_waiting
- 调用 `pool.status()` 轮询（5s 间隔）
- 队列详情：调用 `dispatch.queue()` 展示等待中 spawn

#### H. Layout & Navigation

- 左侧导航栏：Runs / Spawns / Workspaces / Templates / Agents / Pool
- 响应式布局（mobile-friendly）
- SSE 集成：Run View 自动订阅事件流

---

### 验收标准（全勾选才 Done）

#### Runs List

- [ ] **列表加载**：调用 `runs.list()` 展示最近 20 条
- [ ] **状态过滤**：选择 "running" → 只显示 running runs
- [ ] **Tag 过滤**：输入 `{source: "tracker"}` → 只显示匹配 runs
- [ ] **导航到详情**：点击行 → 路由到 `/runs/:id`

#### Run View

- [ ] **DAG 可视化**：加载 run DAG → 渲染节点拓扑，颜色/形状正确
- [ ] **Inspector 面板**：点击节点 → 显示 summary / spawn log / 操作按钮
- [ ] **Patch History**：有 patch 的 run 显示时间线
- [ ] **Event Feed SSE**：事件实时滚动，刷新不丢失
- [ ] **操作按钮**：retry/skip/resolve_gate 调后端 action，UI 状态即时更新

#### Spawn List

- [ ] **列表加载**：展示 ad-hoc + run-scoped spawns
- [ ] **过滤**：run-scoped only / ad-hoc only 切换正确
- [ ] **详情展开**：点击 spawn → 显示 output + log

#### Workspaces / Templates / Agents / Pool

- [ ] **Workspaces**：列表渲染，destroy 按钮正确调用 action
- [ ] **Templates**：创建/编辑/删除完整链路；验证错误前端展示
- [ ] **Agents**：只读目录渲染正确
- [ ] **Pool Dashboard**：指标每 5s 刷新，数字与 `pool.status()` 一致

#### 通用

- [ ] **Prettier 格式化**：所有前端文件通过 `pnpm format`
- [ ] **TypeScript 无报错**：`pnpm typecheck` 通过
- [ ] **响应式**：mobile/tablet/desktop 三档布局不破损

---

**风险**：
- DAG 可视化库选型：不用 @xyflow/react（P0 已移除），可用 D3 或 SVG 手写 — 只做只读渲染，不需要拖拽
- SSE 连接管理：浏览器关闭标签页自动断开，重进自动重连 — 需处理断线后 since 序列号
- 模板编辑器 UX：JSON 输入门槛高，但 v3 不做图形编辑器（设计 §19 明确），保持简单
