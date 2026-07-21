<callout color="blue_bg">
	**本章设计思路**：Orchestrator 是引擎室——人平时不需要进来，但一旦进来（观察、诊断、干预、调流程），每个界面都必须把"发生了什么、为什么、证据在哪、我能做什么"一次讲清。因此执行域页面的统一基调是：图优先于表（DAG 真实可见）、证据优先于结论（每个状态徽标点开都有出处）、干预动作永远伴随边界说明（什么能改、什么不能改、为什么）。本章逐一补齐现状五个缺口：运行无图、可视化编辑器孤儿、智能体页是静态假页、无健康页、双引擎死重。组件定义见 01 章，流程语义见 02 章。
</callout>

## 0. 信息架构与导航

```text
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

清理决策：v2 遗留路由与组件（board、run-console、旧 workflow 表）退役；`workflow-canvas/*` 组件复活为第 5 节编辑器的底座；action 别名收敛为 camelCase 一套，旧名保留为兼容别名但不再出现在文档与 UI。

## 1. 驾驶舱（`/`）

**这页回答**：30 秒内——系统健康吗、在跑什么、有什么等我。首页不再是链接网格；brain 对话入口保留在侧栏线程区与 `/brain`。

```text
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

信息优先级自上而下递减：健康条永远第一（健康门是一切派发的前提）；等待人工的 human_gate 卡片用 warning 描边突出——它们是全系统唯一"在等人"的东西。

## 2. 运行列表（`/runs`）

**这页回答**：最近的运行都是谁发起的、进行到哪、结局如何。

ListGrid，行 = StatusRing + 模板名与版本 + run id（mono）+ **DagMiniMap 实时着色** + 来源徽标（tags：tracker 项、brain 线程、手动）+ 进度（done/total 节点）+ 计时器或耗时 + token + 行操作（暂停、取消、fork，hover 原地替换）。筛选：状态、模板、来源、时间；支持按 tags 查询（如 `item_id:PAY-12`）。批量操作：取消、归档、提优先级。DagMiniMap 让"跑到哪一步"不点进详情就能扫出来——这是列表与详情之间最重要的信息密度升级。

## 3. 运行详情（`/runs/:id`）— 执行域核心页

**这页回答**：这个 run 的完整真相——图（结构与进度）、事件（过程）、证据（产出）、干预（我能做什么）。

```text
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

**DagCanvas**（对现状最大的补缺——现状是拓扑排序的垂直卡片列表，边、分支、fanout、loop 全部不可见）：分层有向图布局，依赖边真实渲染；fanout 以叠片卡加乘数徽标表达，loop 以回边加迭代计数表达；human_gate 节点 warning 描边醒目；活跃节点 border-beam 光带；右下小地图与缩放控件。

**NodeInspector**（点击节点，右栏 `--panel` 表面）：

- 头：节点 id + 类型图标 + agent 名 + 模型与引擎徽标 + StatusRing + attempt 计数。
- **Attempt 时间线**：每次 spawn 一行（状态环、耗时、token、errorClass 徽标）；展开为 TimelineCollapse 渲染 spawn_events——工具调用折叠、思考折叠、最终输出外露、密钥已脱敏。
- 产物：输出 ArtifactCard（schema 校验徽标：通过、纠偏 1 次、失败；截断时给 full_content 链接）。
- 渲染后 prompt：折叠查看——这是 brief 隔离红线的抽查入口，载荷白名单徽标直接可见。
- 操作：`重试`（可选「从上次成功产物续跑」，即检查点重试）· `跳过` · `编辑后重试`（改 prompt 或模型走 patch）· human_gate 节点上的 `批准/驳回`（与 tracker 收件箱等价、双向同步）。

**干预语义**（"Patch 未来、Fork 过去"）：

<Mermaid id="run-intervene" source={"flowchart LR\n DC[DagCanvas] -- 点击节点 --> NI[NodeInspector]\n NI -- 重试 · 检查点续跑 --> SP[新 spawn attempt+1]\n PT[Patch 面板] -- 只改未执行节点 --> DC\n FK[Fork] -- 从历史节点分叉 --> NR[新 run 带父链引用]\n TL[时间线 tab] -. 记录谁改了什么 .-> PT\n TL -. fork 树 .-> FK"} />

- Patch 面板只允许 frontier 之前未执行的节点（pending 与 ready）；DagCanvas 上可编辑区亮色、已执行区锁定灰显；提交走乐观并发（expectedDagVersion），冲突时提示刷新。
- Fork 从任一历史节点分叉新 run，保留父链引用，运行列表显示 fork 树标记。时间线 tab 展示 patch 与 fork 的完整历史：谁、何时、改了什么、dagVersion 前后 diff。

## 4. 工作流库（`/workflows`）

**这页回答**：系统会用哪些流程干活、每套流程长什么样、演化到了第几版。这是"工作流即数据"原则的 UI 化——改流程在这里，不在代码里。

- 卡片网格（替换现状裸表）：每卡 = 名称 + 最新版本徽标 + 描述 + **DAG 缩略图** + 适用场景标签（类型映射）+ 近 30 天统计（run 数、成功率）+ hover 操作（查看、新建 run、复制为新模板）。
- 种子模板带「内置」徽标；九套模板 = sdlc 族 5 套（issue-pipeline、verify、audit、promote、ui-build）+ 轻量族 4 套（quick-task、hotfix、docs-task、spike-research），sdlc 族分组置顶（详见 02 章）。
- 详情（`/workflows/:name`）：版本链——每版含 DAG 预览 diff、保存者、时间、该版 run 统计；任意两版图级 diff（新增、删除、修改节点着色）。

## 5. 工作流编辑器（复活 workflow-canvas）

**这页回答**：不写 JSON 怎么改一套流程。现状仓库里已有完整的可视化 DAG builder 组件却未挂载任何路由，本设计把它复活为编辑器底座。

- 三区：**Palette**（五种节点类型——四种既有 + 新增 `action` 确定性节点（02 章登记）+ 常用 agent 预设卡，拖入画布）· **画布**（DagCanvas 可编辑态：拖节点、连边即 deps、成环即时拒绝）· **Inspector**（选中节点的表单：agent、prompt 模板（`{{deps.*}}` 插值自动补全）、guard 表达式（ConditionBuilder）、output_schema（JSON 编辑器 + 校验）、retry、timeout、model_override、fanout 与 loop 参数——失控上限字段在此显式暴露）。
- **JSON 双向**：右上切换画布与 JSON 视图，双向同步；保存前跑 dag-validator 全量校验，错误定位到节点与字段。
- `试运行`：RunOnceDialog——按 inputSchema 生成 inputs 表单，附沙箱 tags，直接起 run 并跳转详情。
- 保存即 workflowSave 自动增版 + 变更说明（版本链里可读）。

## 6. Brain 控制台（`/brain`）

**这页回答**：编排大脑在想什么、做了什么、健康与纪律如何。现状 brain 页已是最完整页面，重设计在其上收敛与增强。

- **左轨**（线程列表，`--panel` 表面）：保留搜索、状态 pills、归档；行增加引擎徽标（CC、SDK、ACP）与绑定 run 状态环；排队线程显示队列位。
- **turn 终态判定契约（v2.2.1，SDLC-060）**：终态以交付信号优先——最终 assistant 交付摘要已落库的 turn，收尾竞态异常不得把线程覆盖为 error，此时终态 = done 加「收尾异常」徽标（可点开原始 error 事件）；error 仅在无交付摘要时成立；监控唤醒与自动重试以此为准（防"交付成功却被当失败重跑"，B5 实测）。
- **主区 transcript**：改用与运行详情一致的 TimelineCollapse 语汇（过程折叠、结论外露）；顶部固定任务上下文条（绑定 tags：工作项、repo、baseBranch、run 深链）。
- **右栏**（`--panel` 表面）：引擎与模型卡（当前引擎 + 健康点 + 模型切换、tier 门控，附兜底引擎状态一行）· 上下文表盘（contextUsed 与 contextWindow 环形量表 + lastUsage）· **纪律指标卡** · 并发槽（全局 brain_tasks 槽位 + 本线程状态）· 监控节奏（monitorIntervalSec 行内编辑，0 为纯事件驱动）。
- **composer**：保留 repo 与 baseBranch 附加字段、Cmd+Enter 发送；新增模板快捷 chips（「按 issue-pipeline 处理」「只分析不动代码」）。

<callout color="red_bg">
	**Brain 纪律（红线的可观察化）**：CC 订阅只属于 brain，任何 worker 节点禁用；brain 的全部代码变更必须经 workflowRun 走 DAG（vLLM develop 节点），禁止用 Bash 或直改文件绕过。右栏纪律指标卡就是这条红线的仪表：workflowRun 调用次数、vLLM 工人 token 增量、直改文件告警数——告警数应恒为 0，非 0 即视为违规证据。
</callout>

## 7. Brain 引擎注册表（`/brain/engines`）— 新页面

**这页回答**：现在有哪些可用的"大脑"、各自健康吗、默认用谁、降级规则是什么。这是 02 章"brain 可替换"架构的 UI 落点。

- 引擎卡片列表：引擎名 + kind 徽标（cli-resume、sdk、acp）+ 健康点（hover 出探测详情：登录态、端点、延迟）。
- 能力矩阵行：resume、usage 上报、上下文上报的勾叉环。
- 默认模型与 tier 限制（行内改）；`设为默认` 与 `健康检查` 操作。
- CC 引擎卡内嵌登录状态与 connect、disconnect（迁移自设置页，设置页保留入口）。
- 底部说明卡：当前生效的选择与降级规则——默认引擎不健康时新任务落到兜底引擎并明示，附最近降级事件时间线。
- **模型注册表区（v2.2，SDLC-054）**：登记每个可用模型的**真名**（权重身份）、别名映射表、档位与服务端点；spawn 与线程遥测一律按别名反查真名归因。注册校验拒绝假名（非 Claude 权重禁止登记 claude-\* 名）；同端点别名增减产生变更事件——别名漂移曾致应用内 chat 404。
- **降级显式化不变量（v2.2，SDLC-049）**：任何"声明开启的能力初始化失败"（如 harness 包缺失）必须表现为本页与健康页红卡、受影响线程 transcript 顶部 CapabilityBanner、线程行 degraded 徽标。**静默降级本身定性为缺陷**。

## 8. 智能体（`/agents`、`/agents/:name`）— 接真

**这页回答**：有哪些工人、各自用什么模型、干得怎么样。现状此页是硬编码的静态假页；本设计接真实 agent 定义（`.claude/agents/*.md` 解析）加 spawn 统计聚合。

- **列表**（multica 花名册式 ListGrid）：ActorAvatar（agent 紫）+ 名称 + 描述 + runtime 徽标（none、acp、microvm）+ engine + 模型（mono）+ 近 30 天 spawn 数、成功率、中位耗时 + 最近使用。
- **详情**两栏：左 Inspector——名称、描述、runtime、engine、模型（vLLM 端点可用模型下拉）、maxSummaryTokens、tools 多选，PropRow 点击即改，写回 agent md frontmatter（受 self-modifying-code 技能约束）；右 tabs——`系统提示`（markdown 编辑器 + 脏守卫 + git 版本历史）· `运行记录`（该 agent 的 spawns ListGrid）· `用量`（token、耗时、错误分类分布小图）。
- 新建 agent：对话框按 名称、runtime、engine、模型、提示模板预填 的顺序引导，落盘为新 md 文件。

## 9. Spawns（`/spawns`）与工作区（`/workspaces`）

- **Spawns**：保留可展开行，统一为 TimelineCollapse 渲染；筛选加 errorClass 与 agent；行内 `取消` 与 `重跑为新 spawn`。
- **工作区列表**：state 环 + repo 与 branch（mono）+ 关联 run 或线程 + 磁盘占用 + 销毁（带确认）。
- **工作区详情**：文件树 + DiffViewer + 提交历史 + **密钥扫描结果条**（最近一次 commit 扫描的通过与拦截明细——安全红线的 UI 呈现）+ PR 状态卡。

## 10. 健康页（`/health`）— 新页面

**这页回答**：健康前置门现在放行吗、不放行是因为什么、容量还剩多少。这是健康门的单一真相页——tracker 队列页显示的健康状态就来自这里。

- **四健康卡**：vLLM（端点、模型列表、延迟探测、最近失败）· Claude Code（登录态、账号 usage、订阅红线提示：仅供 brain，不可高频轮询）· Brain 槽（并发、占用、排队）· 调度器（reconciler tick 心跳、最近恢复统计——"上次恢复复原 N 个 run"）。
- **遥测可信卡（v2.2）**：用量采集契约的当前状态——suspect 标记的 spawn 计数（超物理速率、input 为 0）、别名漂移事件数、R9 传导修正次数；任一非零即黄卡。**配置生效一致性（v2.2.1，SDLC-057）**：声明配置与实际生效值不一致（如 maxOutputTokens 被框架钳制）必须产生告警事件并计入本卡——"声明了但没生效"与静默降级同性质，定性为缺陷。度量与洞察页对 suspect 数据显示"不可信"水印而不是照常聚合（A18 修订）。采集契约本体：tokens 只取流终 usage 事件（禁止按 chunk 累加——平方级膨胀根因，SDLC-051）、input 必填、经模型注册表反查真名归因。
- **门事件时间线**：最近的派发拒绝（原因、时间、来源工作项深链）、降级事件、恢复事件。
- **容量区**（合并现状 pool 页）：spawn 并发上限（滑杆，写 `setConcurrency`）、dispatch queue 表（按 waiting_for 分组）；microVM 区仅在 ORCH_FORCE_MICROVM 启用时显示，避免在纯 Docker 部署下展示不生效的概念。

## 11. 洞察（`/insights`）— 新页面

**这页回答**：执行质量在变好还是变坏、失败主要坏在哪一层、改哪个模板最值。借 homerail scorecard 思路，把"每个 run 自动评分 + 失败归因"变成常设仪表。

- KpiCard 行：run 成功率 · 中位 run 时长 · token/run · 纠偏率（schema 重询占比）· 评审平均轮数。
- **失败归因面板**：失败 run 按 prompt、tool、engine、template、harness 五层归因堆叠图 + 每类 top 案例列表（点开即 run 深链 + next_steps 建议）。
- **模板质量表**：每套工作流模板的 run 数、成功率、超限率、平均节点重试——回答"改哪个模板最值"。
- **模型对比**：vLLM 与 sonnet 在 dev、reviewer 节点的通过率与耗时对比——devModel 按仓切换的决策依据。

## 12. 设置（`/settings`）

三 tab 保留并收敛：`Claude`（登录卡 + tier，与 `/brain/engines` 互链）· `模型端点`（runtime_configs 增删改与测试）· `凭证`（存在性展示，不显示值）。并发滑杆迁往健康页容量区，设置页留只读读数与深链。

**框架 Agent 页（`/agent`）复用决策**：上游 `8e6f022fa` 新增全页 Agent 工作区 `AgentTabsPage`（Context/Files/Connections/Jobs/Access 五 tab，见 `agent-page` 技能）。审查结论：

- **直接挂载**，承接的是"影响本应用内置默认聊天 agent"这一层（Files/Connections/Access），不与本章已规划的执行域页面冲突。
- **§7 引擎注册表 / §8 智能体 / §10 健康页 / 本节设置均维持独立，不折叠进 Agent 页**：它们是 orchestrator 自有的多引擎/DAG worker/执行健康对象，Agent 页 tab 语义是"本应用唯一默认 agent 能调用什么、谁能连它"，不是"orchestrator 编排了哪些下游执行引擎"——语义不同。§7 的 Claude Code 登录卡是出站（orchestrator 登录 Claude Code 账号去跑 DAG 节点），Access tab 的 Claude Code 连接引导是入站（外部客户端连进本应用调用 action）；两处都保留，标签要写清楚避免混同。
- **Context tab 价值有限，不要当成 brain 会话可观测性的答案**：它读的是 `production-agent.ts`/context-xray manifest，只覆盖 `server/plugins/agent-chat.ts` 挂的那一个默认聊天 agent；brain 线程与 DAG spawn 走 `v3-dispatcher.ts`/`agent-loader.ts` 自有的 `runAgentLoop` 调用路径，不经过这条 manifest。它不能替代 §6 Brain 控制台已有的按线程 token/上下文表盘，也不能替代 §10 健康页的遥测可信卡；只是给用得较少的默认助手对话补上系统提示 provenance/治理层级透明度。
- **Jobs tab** 只是 recurring jobs/automations 的既有 UI 通路，不直接解决 T-D（无 automations，状态迁移靠 4s 轮询）——机制要先建成后才有得展示。

## 13. 数据模型与 action 增量（orchestrator 侧汇总）

<table header-row="true">
<tr>
<td>对象</td>
<td>增量</td>
<td>用途</td>
</tr>
<tr>
<td>brain_engines（新表或配置）</td>
<td>id、kind、modelRef、tier、healthProbe、isDefault</td>
<td>引擎注册表</td>
</tr>
<tr>
<td>brain_threads</td>
<td>加 engineId</td>
<td>线程级引擎选择</td>
</tr>
<tr>
<td>v3_runs</td>
<td>加 `score(pass|needs-attention)`、`failureClass(prompt|tool|engine|template|harness)`、forkOf</td>
<td>scorecard 与 fork 树</td>
</tr>
<tr>
<td>v3_workflow_templates</td>
<td>加 meta（JSON：适用标签、变更说明、内置标记）</td>
<td>工作流库卡片</td>
</tr>
<tr>
<td>v3_spawns</td>
<td>加 parentSpawnId</td>
<td>检查点重试父链</td>
</tr>
<tr>
<td>种子</td>
<td>九套工作流模板 JSON（sdlc 族 5 套 + 轻量族 4 套）随应用发布（首启 upsert，带「内置」标）</td>
<td>解决库中无种子模板</td>
</tr>
<tr>
<td>dag-validator</td>
<td>新增 `action` 节点类型（引用 action 名 + inputs 映射，reconciler 直接执行、无 spawn）</td>
<td>确定性节点承载（02 章）</td>
</tr>
<tr>
<td>能力原语</td>
<td>ciWatch（GitHub REST + 临时 token）、mergePr（顺序锁 + merge-base 断言，无 force 参数）</td>
<td>承 v1.1 M3 既定交付</td>
</tr>
<tr>
<td>tracker-client（新模块）</td>
<td>run 终态回调 tracker 的 advance 与 create-work-item；身份取 run tags</td>
<td>回写通道主链路</td>
</tr>
</table>

action 增量：`workspaceCreate` 增 readOnly 档（tracker 规划技能深读代码用，配套 workspaceFiles 与 workspaceRead 的 A2A 暴露）、`spawnOnce` 的 A2A 暴露（对抗评审轮）、`brainEngineList/Set/Probe`、`nodeRetryFrom(spawnId)`、`workflowDiff(name, v1, v2)`、`insightsSummary`、`healthStatus`（聚合门状态）、`workspaceScanReport`；命名收敛为 camelCase 唯一一套（含 `brainSend`、`getActivity`、`queueStatus`、`setConcurrency` 等的旧 kebab 名转别名），v2 action 标记 deprecated 并从目录 UI 隐藏。

## 14. 技能与提示（orchestrator 侧）

- `orchestrating-v3` 技能升级：模板族选择表（02 章）+「禁止绕过 DAG 直改代码」红线 + 唤醒后行为（review、汇报、必要时 fork 修复节点）。
- BRAIN_PROMPT 收敛为单一出处（brain-prompt.ts），按引擎 kind 拼装差异段；修正 stale 的 workspaceCommitPush 唤醒文案。
- worker agent md（dev、qa、reviewer、gatekeeper）按 v1.1 §3.9 移植 agentic-engineering 纪律原文：TDD 红测试先行、双工件零重叠、只审 diff、真实运行强制、证据 schema。
