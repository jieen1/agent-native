# Orchestrator v3 — 分阶段实施规划 P0（修订版）

> 配套设计文档：[v3-DESIGN.md](./v3-DESIGN.md)
> 差异分析：[v3-GAP_ANALYSIS.md](./v3-GAP_ANALYSIS.md)
>
> **修订说明**：基于最新分支代码重新评估。现有 V2 runtime/engine 已实现 V3 设计 ~65% 的能力。
> P0 从"从零搭建"调整为"验证+对接"。

---

## P0 — Spike 验证 + 双数据库 + V3 数据模型 + 表达式引擎

**目标**：验证 V3 channel contract 在现有 runtime 上可行；建立双数据库 + V3 表；搭建 V3 表达式引擎。

**前置依赖**：无。

### 执行顺序

```
D0 (spike 闸门, ~0.5天)
   │ go?
   ├─ yes → A → B → C+E (scaffold, ~1-2天)
   │          (C 与 E 可并行)
   └─ no  → 详见下方 Fallback 策略
```

**依赖关系**：A 先（双数据库是基础设施）→ B 依赖 A（V3 表需要 Postgres 连接）→ E 依赖 B（action 读写 V3 表）。C 独立，可与任何阶段并行。

**Fallback 策略**（Spike 失败时）：
- 若 NodeRunner 输入格式不兼容 → 在 NodeRunner 前方加 adapter 层，将 V3 4 输入转换为 NodeRunner 期望的 `node/deps/item` 格式
- 若输出 3 路径无法验证 → 先实现 schema-violation 路径，string/object 走现有 `unknown` 类型
- 若 `max_summary_tokens` 不存在 → 先不加截断，P1 时在 dispatcher 层实现
- Spike 失败不等于放弃，只是需要 adapter 层而非直接复用

---

### 工作内容

#### D0. V3 Channel Contract Spike（设计 §0, §6.2）

验证现有 NodeRunner 能否执行 V3 的 4 输入 + string/object 输出约束。

1. 用现有 `RoutingNodeExecutor` + `NodeRunner` 跑一个 microvm 节点
2. 验证 spawn 输入：V3 要求 4 项（system_prompt, rendered_prompt, tools, workspace），现有 NodeRunner 接受 `node/deps/item`。**若格式不匹配，在 NodeRunner 前加 adapter 层做转换**
3. 验证三种输出路径：string / object(schema 验证) / schema-violation。现有 `NodeRunnerResult.output` 是 `unknown` 类型，需确认 `engine-loop.ts` 的 `output_schema` 是否验证
4. 验证 `max_summary_tokens` 截断是否已有；若没有，记录为 P1 dispatcher 层实现
5. 验证方式：写一个测试脚本，构造 V3 格式输入 → 调 NodeRunner → 检查输出是否符合 3 路径

**无需重建**：worker-shim、VM provision、exec/spawn、tools — 已有。只需验证 channel contract 适配性。

#### A. 双数据库策略（设计 §3）

V2 用 LibSQL，V3 切 Postgres。双库共存，不替换。

- `server/db/v3.ts` — 新增 `getV3Db()`，返回 Postgres 连接的 drizzle 实例
- V2 的 `getDb()` 不变，V3 action 调用 `getV3Db()`
- 环境变量 `DATABASE_URL_PG` 配置 Postgres 连接串
- 依赖：`postgres` 客户端 + `drizzle-kit` pg 支持
- **双迁移配置**：使用 `drizzle-kit` 的 `schema` 参数区分 V2/V3 迁移目标。V3 迁移指向 `server/db/v3-schema.ts`
- **连接池**：使用 `postgres` 客户端默认连接池（默认 pool=10），通过 `DATABASE_URL_PG` 的 `?pool=` 参数可调整
- **现有 `server/db/index.ts` 不变**：只在 V3 文件新增，不修改 V2 db 模块

#### B. V3 数据模型（设计 §3）

8 张 `v3_*` 前缀表，全部加性。

| v3 表 | 复用 V2 表？ | 说明 |
|---|---|---|
| `v3_workflow_templates` | 不，V2 表名不同 | 版本化 DAG + input_schema |
| `v3_runs` | 不，V2 用 workflow_runs | 执行实例，含 DAG 快照 + tags + dag_version |
| `v3_nodes` | 不，V2 用 node_runs | DAG 节点，含 fanout_index/iteration |
| `v3_spawns` | 无对应 | 最小 worker 调用，可为 ad-hoc |
| `v3_artifacts` | 不，V2 artifacts schema 不同 | spawn 输出 |
| `v3_workspaces` | 无对应 | 长生命周期 VM + git checkout |
| `v3_patches` | 无对应 | CAS DAG mutation |
| `v3_events` | 无对应 | 事件日志 + seq_num |

- 所有表用 `ownableColumns()`
- `v3_spawns` 含 `log_ref`（spawn 日志文件路径）+ `rendered_prompt TEXT NOT NULL`
- `v3_events` 含 `seq_num`（per-run 递增，由 reconciler 计数而非 DB auto-increment）
- `v3_nodes` 有 UNIQUE `(run_id, node_id_in_dag, iteration, fanout_index)` 约束
- 完整列清单见 [v3-IMPLEMENTATION-P0.md](./v3-IMPLEMENTATION-P0.md) 原版

#### C. Agent 目录 + 模型解析（设计 §7.1, §7.2）

**可复用**：framework `resolveAgentHarness()` + `resolveEngine()` 已有。

- 验证 `loadAgent("implementer")` 解析 .md frontmatter
- 验证 `resolveEngine("ai-sdk:openai")` 返回可调用对象
- 建立 starter agent 模板（`implementer.md`）

#### E. V3 Actions + 表达式解析器 + 插值渲染器

**Action 骨架**（读写 V3 数据库，不接引擎）：
- `workflow.list/get/save/delete` — 模板 CRUD
- `workflow.run` — stub：验证 inputs、插入 run/nodes 行
- `runs.list`, `run.state` — 观察者

**DAG 验证器**（`workflow.save` 内）：
- 节点类型 `agent | parallel_over | loop | human_gate`
- deps 引用存在 + 无环
- guard/until/items_from 表达式语法合法
- output_schema ajv compile 不抛

**表达式解析器**（设计 §5.2）：
- **路径表达式**（核心能力，不能省略）：
  - `inputs.X` — 输入值
  - `deps.NODE.output[.path]` — 依赖节点输出
  - `item` — 当前循环项
  - `iteration` — 当前迭代计数
  - `deps.NODE.previous_iteration.output[.path]` — 上一次迭代输出
  - `deps.NODE.history[i].NODE2.output[.path]` — 历史迭代输出
- 运算符：`== != > >= < <= && || !`
- 函数：`len()`, `contains()`, `startsWith()`, `endsWith()`, `exists()`, `coalesce()`
- 完整实现，不做 MVP 子集。~100 LOC tokenizer + 递归下降求值器

**插值渲染器**（设计 §5.1, §6.4）：
- `{{ ... }}` 占位 → context 路径查找替换
- string→verbatim, number→literal, object→JSON.stringify, undefined→render fail
- P0 阶段独立单测验证，不接入实际 dispatch

---

### 验收标准

- [ ] **D0 Spike**：测试脚本通过 — V3 格式输入 → NodeRunner → 输出符合 3 路径。若格式不匹配，adapter 层方案已确定
- [ ] **双数据库**：`getV3Db()` 连接 Postgres，`getDb()` 仍用 LibSQL，两者互不干扰。`drizzle-kit migrate` 分别作用于 pg 和 libsql
- [ ] **8 张 V3 表**：`drizzle-kit migrate --schema server/db/v3-schema.ts` 通过，V2 表零改动，UNIQUE 约束生效
- [ ] **Agent 加载**：`loadAgent("implementer")` 正确返回 frontmatter
- [ ] **Engine 解析**：`resolveEngine("ai-sdk:openai")` 返回可调用对象
- [ ] **DAG 验证**：合法 4 节点模板通过；未知类型被拒；环检测被拒；parallel_over 无 deps 被拒
- [ ] **表达式解析器**：路径表达式（inputs/deps/item/iteration/history）、运算符、函数全覆盖。`deps.review.output.verdict == "pass"` 类型的表达式可求值
- [ ] **插值渲染器**：string/number/object/undefined 四种路径。单元测试覆盖
- [ ] **7 个 action 可 headless 调用**：workflow.list/get/save/delete, workflow.run, runs.list, run.state
- [ ] **MCP 工具验证**：CC 可发现并调用 v3 action
- [ ] **测试框架**：vitest（与项目现有 `backpressure.spec.ts` 一致）
- [ ] **移除 `@xyflow/react`**：grep 确认无引用（V3 不做视觉编辑器，设计 §19）
- [ ] **Legacy action 标记**：~70 个 V2 action 标注 `@deprecated` + superseded-by 注释

---

**与原版 P0 相比的变化**：
- 去掉 worker-shim 从零搭建（复用 NodeRunner + acting-bridge）
- 去掉 VM provision/teardown（复用 MicrosandboxRuntime）
- 去掉 tools 实现（复用 existing tool surface）
- Spike 从"搭建+验证"缩为"纯验证 channel contract"
- 工作量从 ~3 天缩为 ~1-2 天
