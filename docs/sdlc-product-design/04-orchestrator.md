# 04 · Orchestrator 执行域：逐页面设计

> Orchestrator 是引擎室：人平时不需要进来，但一旦进来（观察、诊断、裁决、
> 调流程），每个界面都必须把"发生了什么、为什么、证据在哪"讲清楚。
> 组件引用 01 章；流程语义引用 02 章。现状缺口清单见调研（无图、builder
> 孤儿、agents 假页、无健康页、双引擎死重）——本章逐一补齐。

## 0. 信息架构与导航

```
Sidebar
├─ 驾驶舱               /            （健康+活跃运行+队列一屏）
├─ 运行                 /runs, /runs/:id
├─ 工作流               /workflows, /workflows/:name
├─ Brain                /brain（控制台）, /brain/engines（引擎注册表）
├─ 智能体               /agents, /agents/:name
├─ Spawns               /spawns
├─ 工作区               /workspaces, /workspaces/:id
├─ 健康                 /health
├─ 洞察                 /insights
├─ ────────────
├─ 线程动态区（活跃 brain 线程，运行中带呼吸点）
├─ Team / Extensions / 设置 /settings
```

清理决策：v2 遗留路由与组件（board/run-console/旧 workflow 表）退役；
`workflow-canvas/*` 组件复活为 §5 编辑器的底座；action 别名收敛为
camelCase 一套（旧名保留为兼容别名但不再出现在文档与 UI）。

## 1. 驾驶舱（`/`）

**目标**：30 秒回答"系统健康吗？在跑什么？有什么等我？"

```
┌ 健康条：vLLM ● · Claude Code ● · Brain 槽 2/2 · 调度器 ●  [详情→/health] ┐
├──────────────────────────────────────────────────────────────────────────┤
│ 活跃运行（卡片行，≤6）：每卡 = 模板名 + run id(mono) + DagMiniMap +      │
│   当前节点 + 计时器 + tags 来源徽标（tracker:PAY-12）    [全部→/runs]    │
├──────────────────────────────────────────────────────────────────────────┤
│ 等待人工（human_gate 节点卡，warning 描边）：一键去解决（深链收件箱/运行）│
├───────────────────────────┬──────────────────────────────────────────────┤
│ 队列与容量：排队 run/spawn │ 今日：完成 run · 合入 PR · token 用量 ·       │
│ 等待原因分布（vm/deps/…） │ 失败归因迷你图（→/insights）                  │
└───────────────────────────┴──────────────────────────────────────────────┘
```

首页不再是链接网格；brain 对话入口保留在侧栏线程区与 `/brain`。

## 2. 运行列表（`/runs`）

ListGrid：行 = StatusRing + 模板名@版本 + run id(mono) + **DagMiniMap
（实时着色）** + 来源徽标（tags：tracker 项 / brain 线程 / 手动）+
进度（done/total 节点）+ 计时器/耗时 + token + 操作（暂停/取消/fork，
hover 原地替换）。筛选：状态/模板/来源/时间；支持按 tags 查询
（`item_id:PAY-12`）。批量：取消、归档、提优先级。

## 3. 运行详情（`/runs/:id`）— 执行域核心页

**目标**：一个 run 的完整真相：图、事件、证据、干预。

```
┌ 头部：模板@版本 + run id + StatusRing + 计时器 + DAG v{n} 徽标            │
│   tags 深链（工作项/线程/PR）+ 操作：暂停 · 取消 · Fork · Patch          │
├───────────────────────── 主区（左右可拖） ────────────────────────────────┤
│ 左：DagCanvas（默认 60%）              │ 右：检查器 tabs                   │
│  · 分层布局真实渲染依赖边               │ ① 节点（NodeInspector）          │
│  · fanout 叠片×N / loop 回边+计数      │ ② 事件流（实时，级别筛选）        │
│  · human_gate warning 醒目             │ ③ 时间线（patch/fork 历史）      │
│  · 活跃节点 border-beam                │ ④ 输入与产物（run inputs +       │
│  · 小地图 + 缩放 + 适应视图             │    最终 outputs EvidenceCard）   │
└────────────────────────────────────────┴──────────────────────────────────┘
```

**NodeInspector**（点击节点）：
- 头：节点 id + 类型图标 + agent 名 + 模型/引擎徽标 + StatusRing +
  attempt 计数。
- **Attempt 时间线**：每次 spawn 一行（状态环 + 耗时 + token +
  errorClass 徽标）；展开 = TimelineCollapse 渲染 spawn_events
  （工具调用折叠、思考折叠、最终输出外露、密钥已脱敏）。
- 产物：输出 ArtifactCard（schema 校验徽标：通过/纠偏 1 次/失败；
  truncated 时给 full_content 链接）。
- 渲染后 prompt：折叠查看（brief 隔离抽查入口——红线 C2 的 UI 落点）。
- 操作：`重试`（可选"从上次成功产物续跑"= R4 检查点重试）· `跳过` ·
  `编辑后重试`（改 prompt/模型开 patch）· human_gate 节点：`批准/驳回`
  （等价 tracker 收件箱，双向同步）。

**Patch/Fork**：
- Patch 面板：只允许 frontier 之前未执行的节点（pending/ready），
  DagCanvas 上可编辑区亮色、已执行区锁定灰显；提交=乐观并发
  （expectedDagVersion），冲突时提示刷新。
- Fork：从任一历史节点 fork 新 run（保留父链引用，运行列表中显示
  fork 树标记）。时间线 tab 展示 patch/fork 完整历史（谁/何时/改了什么，
  dagVersion 前后 diff）。

## 4. 工作流库（`/workflows`）

**目标**：工作流族（02 章 §3 九模板）的家。工作流即数据的 UI 化。

- 卡片网格（非裸表）：每卡 = 名称 + 最新版本徽标 + 描述 + **DAG 缩略图**
  + 适用场景标签（类型映射）+ 统计（近 30 天 run 数/成功率）+ 操作
  （查看/新建 run/复制为新模板）。
- 种子模板带 `内置` 徽标；`sdlc-*` 族分组置顶。
- 详情（`/workflows/:name`）：版本链（每版：DAG 预览 diff + 保存者 +
  时间 + 该版 run 统计）；任意两版图级 diff（新增/删除/修改节点着色）。

## 5. 工作流编辑器（复活 workflow-canvas）

- 三区：**Palette**（五种节点类型——四种既有 + 新增 `action` 确定性节点（02 §3 登记）+ 常用 agent 预设卡拖入）·
  **画布**（DagCanvas 可编辑态：拖节点、连边即 deps、成环即时拒绝）·
  **Inspector**（选中节点的表单：agent/prompt 模板（带 `{{deps.*}}`
  插值自动补全）/guard 表达式（ConditionBuilder）/output_schema
  （JSON editor + 校验）/retry/timeout/model_override/fanout/loop 参数
  ——R6 失控上限字段在此显式暴露）。
- **JSON 双向**：右上切换 `画布 / JSON` 视图，双向同步；保存前跑
  dag-validator 全量校验，错误定位到节点/字段。
- `试运行`：RunOnceDialog——填 inputs（按 inputSchema 生成表单）+
  沙箱 tags，直接起 run 并跳转详情。
- 保存 = workflowSave 自动增版 + 变更说明（版本链里可读）。

## 6. Brain 控制台（`/brain`）

现状 brain.tsx 已是最完整页面，重设计在其上收敛与增强：

- 左轨（线程列表）：保留搜索/状态 pills/归档；行增加**引擎徽标**
  （CC/SDK/ACP）与绑定 run 状态环；排队线程显示队列位。
- **turn 终态判定契约（v2.2.1，SDLC-060）**：线程终态以交付信号优先——
  最终 assistant 交付摘要已落库的 turn，收尾阶段的竞态异常
  （error_during_execution 与摘要同秒并存）**不得**把线程覆盖为
  error；此时终态 = done + `收尾异常`徽标（可点开看原始 error 事件）。
  error 仅在无交付摘要时成立。监控唤醒与自动重试以该契约为准——
  防止"交付成功却被当失败重跑"（B5 实测）。
- 主区 transcript：改用统一 TimelineCollapse 语汇（与 run 详情一致）；
  顶部固定**任务上下文条**（绑定的 tags：工作项/repo/baseBranch/run 深链）。
- 右栏（UsagePanel 扩展）：
  - 引擎与模型：当前引擎卡（健康点）+ 模型切换（tier 门控）；
  - 上下文表盘：contextUsed/contextWindow 环形量表 + lastUsage；
  - **纪律指标**（memory 红线可观察化）：本线程 workflowRun 次数 ·
    vLLM 工人 token 增量 · 直改文件告警数——"brain 必须经 DAG 干活"
    的证据仪表；
  - 并发槽：全局槽位占用（brain_tasks）+ 本线程槽状态；
  - 监控节奏：monitorIntervalSec 行内编辑（0=纯事件驱动）。
- composer：保留 repo/baseBranch 附加字段 + Cmd+Enter；新增模板快捷
  chips（"按 issue-pipeline 处理""只分析不动代码"）。

## 7. Brain 引擎注册表（`/brain/engines`）— 新页面

02 章 §5 的 UI 落点。卡片列表，每卡：

- 引擎名 + kind 徽标（cli-resume/sdk/acp）+ 健康点（探测详情 hover：
  登录态/端点/延迟）；
- 能力矩阵行（resume/usage 上报/上下文上报 的勾叉环）；
- 默认模型与 tier 限制（行内改）；
- `设为默认` `健康检查` 操作；CC 引擎卡内嵌登录状态与
  connect/disconnect（迁移自设置页，设置页保留入口）。
- 底部说明卡：当前生效的选择与降级规则（默认引擎不健康 → 兜底引擎，
  最近一次降级事件时间线）。
- **模型注册表区（v2.2，自举簇四/SDLC-054）**：登记每个可用模型的
  **真名**（权重身份）+ 别名映射表 + 档位 + 服务端点；spawn/线程遥测
  一律按别名反查真名归因。注册校验：非 Claude 权重禁止登记 claude-*
  名（假名即拒绝）；同端点新增/移除别名产生变更事件（别名漂移可见——
  曾致应用内 chat 404）。
- **降级显式化不变量（v2.2，SDLC-049）**：任何"声明开启的能力初始化
  失败"（如 ORCH_BRAIN_HARNESS=1 但 ACP 包缺失）必须表现为：本页与
  健康页红卡 + 受影响线程 transcript 顶部 CapabilityBanner + 线程行
  degraded 徽标。**静默降级本身定性为缺陷**；"以兜底引擎运行"的提示
  同理适用于 harness 回退。

## 8. 智能体（`/agents`, `/agents/:name`）— 接真

- 列表（multica 花名册式 ListGrid）：ActorAvatar(agent 紫) + 名称 +
  描述 + runtime 徽标（none/acp/microvm）+ engine + 模型(mono) +
  近 30 天 spawn 数/成功率/中位耗时 + 最近使用。数据源=真实
  `.claude/agents/*.md` 解析 + spawn 统计聚合。
- 详情两栏（Inspector 范式）：
  - 左 Inspector：名称/描述/runtime/engine/**model**（vLLM 端点可用
    模型下拉）/maxSummaryTokens/tools 多选——PropRow 点击即改，写回
    agent md frontmatter（self-modifying-code 技能约束下）。
  - 右 tabs：`系统提示`（markdown 编辑器 + 脏守卫 + 版本历史=git）·
    `运行记录`（该 agent 的 spawns ListGrid）· `用量`（token/耗时/
    错误分类分布小图）。
- 新建 agent：对话框（名称→runtime→engine→模型→提示模板预填），
  落盘为新 md 文件。

## 9. Spawns（`/spawns`）与工作区（`/workspaces`）

- Spawns：保留现有可展开行，统一为 TimelineCollapse 渲染；筛选加
  errorClass 与 agent；行内 `取消` `重跑为新 spawn`。
- 工作区列表：state 环 + repo/branch(mono) + 关联 run/线程 + 磁盘占用 +
  操作（销毁带确认）。详情：文件树 + **DiffViewer**（保留）+
  提交历史 + **密钥扫描结果条**（最近一次 commit 扫描：通过/拦截明细
  ——安全红线的 UI 呈现）+ PR 状态卡。

## 10. 健康页（`/health`）— 新页面

**目标**：健康前置门（02 章 §6）的单一真相页。

- 四健康卡：**vLLM**（端点/模型列表/延迟探测/最近失败）· **Claude Code**
  （登录态/账号 usage/订阅红线提示：不可用于高频轮询）· **Brain 槽**
  （并发/占用/排队）· **调度器**（reconciler tick 心跳/最近恢复统计
  ——R2 的"上次恢复复原 N run"）。
- **遥测可信卡（v2.2，自举簇四）**：用量采集契约（§13）的当前状态——
  suspect 标记的 spawn 计数（超物理速率/input=0）、别名漂移事件数、
  R9 传导修正次数；任一非零即黄卡，点开看逐条。度量/洞察页对 suspect
  数据显示"不可信"水印而不是照常聚合（A18 修订）。
  **配置生效一致性（v2.2.1，SDLC-057）**：声明的配置值与实际生效值
  不一致（如 maxOutputTokens 被框架钳制、env 覆盖被忽略）必须产生
  告警事件并计入本卡——"声明了但没生效"与"静默降级"同性质，
  都定性为缺陷而非正常行为。
- 门事件时间线：最近的派发拒绝（原因+时间+来源工作项深链）、降级事件、
  恢复事件。
- 容量区（合并现 pool 页）：spawn 并发上限（滑杆，写 set-concurrency）、
  dispatch queue 表（waiting_for 分组）、microVM 区仅在
  ORCH_FORCE_MICROVM 启用时显示（避免 inert 概念干扰）。

## 11. 洞察（`/insights`）— 新页面（scorecard 归因）

- KpiCard 行：run 成功率 · 中位 run 时长 · token/run · 纠偏率
  （schema 重询占比）· 评审平均轮数。
- **失败归因面板**（homerail scorecard 范式）：失败 run 按
  prompt/tool/engine/template/harness 五层归因堆叠图 + 每类 top 案例
  列表（点开=run 深链 + next_steps 建议）。
- 模板质量表：每工作流模板的 run 数/成功率/超限率/平均节点重试——
  "改哪个模板最值"。
- 模型对比：vLLM vs sonnet 在 dev/reviewer 节点的通过率与耗时对比
  （devModel 决策依据）。

## 12. 设置（`/settings`）

三 tab 保留并收敛：`Claude`（登录卡 + tier —— 与 /brain/engines 互链）·
`模型端点`（runtime_configs CRUD + 测试）· `凭证`（存在性展示）。
并发滑杆迁往 /health 容量区（设置页留只读读数 + 深链）。

## 13. 数据模型与 action 增量（orchestrator 侧汇总）

| 对象 | 增量 | 用途 |
|---|---|---|
| brain_engines（新表或配置） | id/kind/modelRef/tier/healthProbe/isDefault | 引擎注册表 |
| brain_threads | + engineId | 线程级引擎选择 |
| v3_runs | + score(pass|needs-attention) + failureClass(prompt|tool|engine|template|harness) + forkOf | scorecard 与 fork 树 |
| v3_workflow_templates | + meta(JSON: 适用标签/变更说明/内置标记) | 工作流库卡片 |
| v3_spawns | + parentSpawnId + lastHeartbeatAt | R4 检查点重试父链；R1 孤儿降级心跳 |
| v3_spawns 用量采集契约（v2.2） | tokens_input/output **只取流终 usage 事件**（禁止按 chunk 累加——SDLC-051 的平方级膨胀根因）；input 必填；`modelRealName`（经注册表反查）与 `usageSuspect` 布尔（超物理速率/input=0 即置位，不入度量） | 遥测单一事实源（04 §7/§10） |
| model_registry（新表或配置） | realName/aliases[]/tier/endpoint/服务商；校验拒绝假名 claude-* | 模型身份权威（SDLC-054） |
| 种子 | 九套工作流模板 JSON（sdlc 族 5 套 + 轻量族 4 套）随应用发布（首启 upsert，带 `内置` 标） | 解决库中无种子 |
| dag-validator | + `action` 节点类型（引用 action 名 + inputs 映射，reconciler 直接执行无 spawn） | 确定性节点承载（02 §3） |
| 能力原语 | ciWatch（GitHub REST + 临时 token）、mergePr（顺序锁 + merge-base 断言，无 force 参数） | 承 v1.1 M3 既定交付 |
| tracker-client（新模块） | run 终态回调 tracker advance/create-work-item；身份取 tags | 回写通道主链路 |

action 增量：`brainEngineList/Set/Probe`、`nodeRetryFrom(spawnId)`、
`workspaceCreate` 增 readOnly 档（供 tracker 规划技能深读代码，配套
workspaceFiles/Read 的 A2A 暴露）、`spawnOnce` 的 A2A 暴露（对抗评审轮）、
`workflowDiff(name, v1, v2)`、`insightsSummary`、`healthStatus`（聚合门状态）、
`workspaceScanReport`；收敛别名（camelCase 唯一命名），v2 action 标记
deprecated 不再出现在目录 UI。

## 14. 技能与提示（orchestrator 侧）

- `orchestrating-v3` 技能升级：模板族选择表（02 §3.10）+ "禁止绕过 DAG
  直改代码"红线 + 唤醒后行为（review→汇报→必要时 fork 修复节点）。
- BRAIN_PROMPT 单一出处（brain-prompt.ts），按引擎 kind 拼装；
  修正 stale 的 workspaceCommitPush 文案。
- worker agent md（dev/qa/reviewer/gatekeeper）按 v1.1 §3.9 移植
  agentic-engineering 纪律原文（TDD 红先行、双工件、只审 diff、
  真实运行、证据 schema）。
