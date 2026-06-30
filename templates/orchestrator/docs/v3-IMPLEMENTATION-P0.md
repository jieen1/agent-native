# Orchestrator v3 — 分阶段实施规划 P0

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
>
> 本文按 P0→P1→P2→... 分阶段逐步推进。
> 每阶段独立成文，全勾选才 Done，不进下一阶段。

---

## P0 — 基础设施闸门 + 基线收尾 + 数据模型

**目标**：用一次性 spike 证明 microVM worker shim 执行链在目标主机可行（否则 P1 不得开工）；
通过后，把 v3 的数据骨架落地；搭建基础项目结构、依赖、action 骨架。

**前置依赖**：无（基于当前 orchestrator 模板现状）。

### 执行顺序

```
D0 (spike 闸门, 独立运行, ~1天)
   │ go?
   ├─ yes → A+B+C+E (scaffold, 可并行 B+C, ~2-3天)
   └─ no  → 解决 microsandbox/KVM 本身，不进入 scaffold
```

spike 失败时 scaffold 已做的工作丢弃，损失最小。

---

### 工作内容

#### D0. microVM Worker Shim Spike（设计 §10.2, §10.3, §10.4）— 硬闸门

在目标主机实测完整 worker 链路。D0 是独立阶段，先跑：

1. **预烤 base image** — alpine + git + nodejs + ca-certificates + worker-shim.js
   - 用 `msb snapshot` 缓存（避免每次 30-60s install）
   - 验证 image 大小 < 500MB
2. **worker-shim.js MVP** — 最小可用 shim：
   - 从 stdin 读 `spawn-spec.json`（设计 §10.3 的 spawn-spec 结构）
   - 对 `ai-sdk:openai` engine，调 host vLLM（用 v2 spike 确定的 host-gateway 地址）
   - 跑一轮 agent loop（system_prompt + user prompt，**无 tools**，先纯对话）
   - 输出 `/tmp/output.json`
3. **Dispatcher MVP（host 端脚本）**：
   - `msb exec <vm> -- node /opt/worker-shim/index.js < spawn-spec.json`
   - 读 `/tmp/output.json`，验证输出格式
   - 销毁 VM
4. **三种输出测测**：
   - 默认 string 输出
   - 带 `output_schema` 的 object 输出（ajv 验证）
   - schema 不匹配 → `schema-violation`
5. **销毁+重启**干净复跑（证明单用 VM 可销毁重来）
6. **并发 4 个 VM** 验证不 OOM
7. **secrets 注入** — `secrets_env` 在 `spawn-spec.json` 中声明一个假 key，
   验证 VM 内 `process.env` 可见（设计 §13, §10.3 step 4）

产出 `docs/spike-worker-shim.md`（结果 + 实测时延 + go/no-go）

**Worker shim 构建流水线**（P0 spike 验证，P1 产品化）：
- Shim 源码位置：`server/runtime/worker-shim/` 目录
- 依赖打包：`npm pack` 将 shim + node_modules (`@anthropic-ai/sdk`, `openai`, `ajv`) 打成一个 tarball
- 预烤 image：Alpine → `npm install -g <tarball>` → `msb snapshot` → 得 base_image_ref
- P1 dispatcher 用此 base_image_ref 启动 VM，shim 已内置

#### A. 项目基线与依赖（设计 §1, §10.2）

D0 go 之后执行。

- 确认当前 `package.json` 已有依赖：`microsandbox`（v2 spike 已引入，`0.5.7`）
- `microsandbox` 的 npm 包是否已被 `pnpm` 锁定。如果版本过旧，pin 最新版
- 新增依赖（先 `pnpm view` 核验最新版后 pin）：
  - `ajv` + `ajv-formats` — JSON Schema 验证（设计 §6.2, §6.3）
  - `postgres` — Postgres 客户端（设计 §3，v3 从 LibSQL 迁 Postgres）
- 确认 `drizzle-orm` 的 pg 连接已在 `packages/core` 中支持（framework 已有 `postgres` 包引用）

**数据库策略**（重要）：V2 用 LibSQL，V3 切 Postgres。V3 不替换 LibSQL — 双数据库共存：
- LibSQL 继续服务 V2 表
- Postgres 服务 V3 表（`v3_*` 前缀）
- `server/db/index.ts` 新增 `getV3Db()` 函数，返回 Postgres 连接的 drizzle 实例
- V2 的 `getDb()` 不变，V3 action 调用 `getV3Db()`
- 环境变量 `DATABASE_URL_PG` 配置 Postgres 连接串
- 移除依赖：`@xyflow/react`（v3 不做图形编辑器，设计 §19）

#### B. 数据模型（设计 §3）

v3 数据模型和 v2 完全不同（无 projects/work_items/node_defs/status_log/links）。

**表名冲突处理**：v2 已有 `workflow_templates`、`artifacts`、`workflow_runs` 三张表但 schema
完全不同（v2 `artifacts` 有 `runId/nodeRunId/kind/ref/summary`，v3 `artifacts` 有
`spawn_id/text_content/object_content/full_content_ref`）。v3 使用**新表名**避免冲突：

| v3 表名 | v2 同名表 | 说明 |
|---|---|---|
| `v3_workflow_templates` | `workflow_templates` | 命名、版本化 DAG + input_schema |
| `v3_runs` | `workflow_runs` | 一次执行实例，含 DAG 快照 + inputs + status + dag_version + tags |
| `v3_nodes` | `node_runs` | DAG 中一个节点，关联 run，含 status/iteration/fanout_index |
| `v3_spawns` | —（新） | 一次 worker 调用，最小单元。可为 ad-hoc 或 node 的执行尝试 |
| `v3_artifacts` | `artifacts` | spawn 的持久化结果，含 text_content / object_content / full_content_ref |
| `v3_workspaces` | —（新） | 长生命周期 microVM，含 git checkout，跨 spawn 共享 |
| `v3_patches` | —（新） | 对 live run DAG 的变异操作，CAS 保护 |
| `v3_events` | —（新） | 事件日志，run/spawn 级 |

- **全部加性、不删 v2 表**（设计 §3, CLAUDE.md 加性约束）
- 所有表用 `ownableColumns()`（framework 自带 owner 作用域）
- 逐列对齐设计 §3 的 SQL DDL，不遗漏列：
  - `v3_workflow_templates`: id, name, version, description, dag, input_schema, created_at, UNIQUE(name, version)
  - `v3_runs`: id, template_id, template_version, inputs, dag, dag_version, status, priority, tags, started_at, completed_at
  - `v3_nodes`: id, run_id, node_id_in_dag, type, status, iteration, fanout_index, current_spawn_id, output_artifact_id, started_at, completed_at, error, UNIQUE(run_id, node_id_in_dag, iteration, fanout_index)
  - `v3_spawns`: id, node_id, attempt, agent_name, engine_ref, model_ref, runtime, workspace_id, rendered_prompt, log_ref, vm_name, acp_session_id, status, output_artifact_id, output_kind, tokens_input, tokens_output, latency_ms, error, error_class, tags, started_at, completed_at
  - `v3_artifacts`: id, spawn_id, kind, text_content, object_content, full_content_ref, byte_size, truncated, created_at
  - `v3_workspaces`: id, owner_kind, owner_id, tags, vm_name, repo_url, branch, state, created_at, destroyed_at, created_by
  - `v3_patches`: id, run_id, dag_version_before, dag_version_after, patch_ops, actor, reason, applied, applied_at
  - `v3_events`: id, run_id, spawn_id, kind, payload, seq_num (INTEGER, per-run 递增), ts
  - seq_num 非全局自增，每 run 独立从 1 开始。INSERT 时通过 `LASTVAL` 或窗口函数 `ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY ts)` 实现
- 索引：`v3_nodes(run_id)`、`v3_spawns(node_id)`、`v3_artifacts(spawn_id)`、
  `v3_patches(run_id)`、`v3_events(run_id, seq_num)`、`v3_events(spawn_id)`、
  `v3_workspaces(owner_kind, owner_id)`、`v3_workspaces(vm_name)` 唯一
- **更新 `getDb`**：`server/db/index.ts` 的 `createGetDb` 包含 v3 表 schema

#### C. Agent 目录 + 模型解析（设计 §7.1, §7.2）

- 确认 `.claude/agents/` 目录存在、可用 framework 的 subagent loader
- 建立 starter agent 模板（`implementer.md`）验证 frontmatter 加载：
  ```markdown
  ---
  name: implementer
  description: Implements one file per design plan.
  runtime: microvm
  engine: ai-sdk:openai
  model: qwen3.6
  tools: [Read, Edit, Write, Bash, Glob, Grep]
  isolation: workspace
  max_summary_tokens: 2000
  ---

  You are a backend implementation agent...
  ```
- 写一个 `loadAgent(name)` 工具函数，复用 framework loader 逻辑，验证 .md → frontmatter 解析
- **Engine 解析验证**（设计 §7.2）：调用 framework `resolveEngine("ai-sdk:openai")` 确认返回可调用对象
  （base_url, model_id, api_key_env）；不解析则 P1 无 executor

#### E. 基础 Actions + 表达式解析器 + 插值渲染器（设计 §5.1, §5.2, §6.4, §8.3, §8.4）

**Action 列表**（不接引擎、只读写数据库）：
- `workflow.list()` — 返回模板列表
- `workflow.get(id|name, version?)` — 返回模板详情
- `workflow.save({name, dag, input_schema, description?})` — 验证 DAG schema + 表达式语法 + 写库 → 返回 `{id, version}`
- `workflow.delete(id|name)` — 删除模板
- `workflow.run({template, dag, inputs, tags, priority?})` — stub：验证 input_schema、clone DAG、插入 run 行 → 返回 `{runId, dag_version:1}`（不调度，P1 接入引擎）
- `runs.list({status?, tag_match?, limit?, offset?})` — 返回 run 列表
- `run.state(runId)` — 返回 run 当前状态（status + 节点计数）

**DAG 验证器**（`workflow.save` 内调用）：
- 节点类型只能是 `agent | parallel_over | loop | human_gate`
- `deps` 引用必须存在（对 `agent`, `human_gate`, **`parallel_over`**）；
  `parallel_over.body` 必须是 agent；`loop.body` 引用的节点 id 必须存在
- 无环（DFS 检测）
- `guard` / `until` / `items_from` 表达式语法合法（用 §5.2 表达式解析器做语法检查）
- `output_schema` 合法（ajv `compile` 不抛）

**表达式解析器**（设计 §5.2，完整实现，不做 MVP 子集）：
- 运算符：`== != > >= < <= && || !`
- 函数：`len(x)`, `contains(arr, x)`, `startsWith(s, p)`, `endsWith(s, p)`, `exists(path)`, `coalesce(a, b, ...)`
- 字面量：string（`"..."` 或 `'...'`），number, boolean, null
- 路径：`inputs.X`, `deps.NODE.output[.path]`, `item`, `iteration`, `deps.NODE.previous_iteration.output[.path]`, `deps.NODE.iterations`, `deps.NODE.history[i].NODE2.output[.path]`
- 禁止：函数定义、IO、对象方法调用、成员赋值、控制流关键字
- 实现：~50 LOC tokenizer + 递归下降求值器。不在 P0 做，语法校验在 P0

**插值渲染器 MVP**（设计 §5.1, §6.4）：
- 解析 `{{ ... }}` 占位，对给定的 context 对象做路径查找和替换
- 规则：string→verbatim, number/boolean/null→literal, object/array→`JSON.stringify`, undefined→render fail
- P0 只做单测验证（不接入实际 spawn dispatch），P1 接入 Worker Dispatcher

**Legacy action 处理**：v2 已有 ~70 个 actions（`actions/` 目录）。P0 **不删不改**；
标记 `save-workflow`, `list-workflows`, `get-workflow`, `delete-workflow`, `save-template`,
`list-templates`, `list-runs` 为 superseded（代码注释），新 action 使用 v3 naming（`workflow.*`, `run.*`）。

---

### 验收标准（全勾选才 Done）

#### D0 Spike 闸门

- [ ] **`docs/spike-worker-shim.md` 存在**，记录：
  - 预烤 image 大小（MB）、**冷启时延**（VM 启动到 worker-shim 返回第一个字节，**不含首 token**）
  - 无 tool 纯对话一轮完成、返回正确 assistant text
  - string / object / schema-violation 三种输出均通过
  - 销毁+重启干净复跑成功
  - 并发 4 VM 不 OOM
  - secrets 注入在 VM 内可见
- [ ] **go/no-go 分条目判定**（每个门槛独立 go/no-go + 补偿动作）：

  | 门槛 | go 标准 | 不达标补偿 |
  |---|---|---|
  | Image 大小 | < 500MB | 从 base image 移除 nodejs（改用更精简 runtime），重试 |
  | 冷启时延 | ≤ 2s | 优化 image 层数/减小 shim 体积，重试 |
  | 并发 VM | ≥ 4 不 OOM | 降低 pool 默认值（设计 §10.2 default 4 → 2），重试 |
  | 输出链路 | 三种输出均通过 | 阻塞，无补偿方案 |
  | secrets 注入 | VM 内可见 | 阻塞，无补偿方案 |

  输出链路 / secrets 注入任一 no-go → **整个 spike no-go**，P1 不得开工。
  其余门槛有补偿动作，可重试一次后判定。

#### Scaffold（A + B + C + E）

- [ ] **依赖到位**：`ajv`, `ajv-formats` 已 pin 版本、`pnpm install` 通过；
      `@xyflow/react` 已移除（grep 验证无引用）
- [ ] **8 张 v3 新表加性迁移成功**：`drizzle-kit migrate` 通过，v2 表零改动零 ALTER；
      `v3_nodes` 唯一键 `(run_id, node_id_in_dag, iteration, fanout_index)` 生效
- [ ] **Agent 加载器**：`loadAgent("implementer")` 能正确解析 frontmatter 返回
      `{name, runtime, engine, model, tools, isolation, system_prompt}`
- [ ] **Engine 解析**：`resolveEngine("ai-sdk:openai")` 返回可调用对象（含 base_url/model_id）
- [ ] **DAG 验证器**：
  - 合法 4 节点模板 save 通过
  - 未知节点类型被拒、环被拒、`parallel_over` deps 不存在被拒
  - 无效 `guard` 表达式语法被拒
  - `loop.body` 引用节点不存在被拒
  - `output_schema` ajv compile 失败被拒
- [ ] **表达式解析器**：语法校验通过/失败各一个 fixture；
      含 `contains()`, `startsWith()`, `endsWith()`, `exists()`, `coalesce()` 全覆盖
- [ ] **插值渲染器 MVP 单测**：string/number/object/undefined 四种替换路径各一个 fixture
- [ ] **7 个基础 action 可 headless 调用**（`pnpm action <name> --args '...'`）：
  - `workflow.save` 保存模板 → `workflow.get` 返回一致
  - `workflow.list` 返回已存模板
  - `workflow.delete` 删除后 get 404
  - `workflow.run` 创建 run 行（status=pending, dag_version=1, inputs 一致）
  - `runs.list` 返回刚创建的 run
  - `run.state` 返回 pending 状态
- [ ] **MCP 工具验证**：CC 可发现并调用 `workflow.save`, `spawn.once` 等 v3 action
- [ ] **Scaffold go/no-go**：spike go + 所有 scaffold 验收勾选 → P0 Done

---

**风险**：
- Postgres 迁移：当前模板用 LibSQL，v3 切 Postgres → framework `postgres` 包已存在，
  表名加 `v3_` 前缀避免冲突（已在 B 中解决）
- Worker shim 复杂度：agent loop + tool execution 的 shim 层约 300-500 LOC，spike 只做无 tool 对话
- microsandbox v0.5.x beta 不稳定 → pin 版本 + spike 闸门
- 表达式解析器边界 case：~50 LOC 的递归下降求值器容易遗漏运算符优先级/短路逻辑 → 以单测矩阵兜底
- v2 现有 runtime 代码（`server/runtime/` 约 30 文件）：已有 microVM runtime 实现，P0 不冲突（spike 独立脚本），
  P1 需评估复用 vs 重写
