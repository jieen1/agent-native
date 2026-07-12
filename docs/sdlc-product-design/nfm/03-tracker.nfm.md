<callout color="blue_bg">
	**本章设计思路**：Tracker 是四个应用里人停留时间最长的一个。人在这里只做三类事——**说清楚**（规划工作台里的访谈与评审）、**裁决**（收件箱里的签核与例外）、**观察**（看板、驾驶舱、度量）。因此页面设计的第一原则是：每一页都明确服务其中一类时刻，把该时刻需要的信息一屏给足，把不属于该时刻的操作收起来。所有页面按统一微结构描述：这页回答什么、布局、关键交互、状态与空态、agent 对等面（统一收敛在 0 节导航状态与 11 节 action 增量，不逐页重复）。组件定义见 01 章，流程语义见 02 章。
</callout>

## 0. 信息架构与导航

侧栏采用 Foundry 外壳（01 章 §5），主导航按"时刻"组织：观察类（看板、Sprint、度量）、裁决类（收件箱）、执行类（队列）、配置类（项目）。

```text
Sidebar（Foundry 外壳）
├─ 问 Tracker            /            （chat home，框架 AgentChatSurface）
├─ 收件箱                /inbox       （审批 + 升级 + 失败 + 通知，未处理数角标）
├─ 看板                  /board       （看板/列表/泳道三视图）
├─ Sprint                /sprints     （列表 → 驾驶舱 → 规划工作台）
├─ 队列                  /queue       （依赖感知调度）
├─ 度量                  /metrics
├─ 项目（动态区）         /projects, /projects/:id
├─ ────────────
├─ Team / Extensions / 设置
```

<Mermaid id="tracker-ia" source={"flowchart TD\n  S[侧栏] --> H[问 Tracker /]\n  S --> I[收件箱 /inbox]\n  S --> B[看板 /board]\n  S --> SP[Sprint 列表 /sprints]\n  SP --> CK[Sprint 驾驶舱]\n  CK --> ST[规划工作台 studio]\n  S --> Q[队列 /queue]\n  S --> M[度量 /metrics]\n  S --> P[项目 /projects]\n  B --> W[工作项详情 /items/:id]\n  I --> W\n  W -.深链.-> R[orchestrator 运行详情]\n  ST -.内嵌.-> D[design 应用 Present 视图]"} />

路由收敛：删除重复的 `/new-work-item`（保留 `/items/new`）；`navigation` 应用状态补齐 `sprints`、`sprint`、`studio`、`queue`、`inbox`、`metrics`、`new-item` 视图——现状缺失导致 agent 对这些页面失明；`view-screen` 相应返回各页焦点对象（sprint、审批项、队列位）。

全局交互：`⌘K` 命令面板（跨工作项、Sprint、审批、页面搜索 + 快捷动作）；`C` 新建工作项；`G+B` 看板、`G+S` Sprint。

## 1. 问 Tracker（`/`）

**这页回答**：现在整体什么状态、有什么等我，以及"用一句话把事交给系统"。

保持 chat-first 首页（框架 AgentChatSurface + AgentComposerFrame），在其上增强三点：

- **今日概览条**（composer 上方，一行四枚 mono 数字 chip）：进行中 sprint 相位 · 运行中与排队工作项 · 待我处理（审批与裁决）· 今日交付。各 chip 点击深链对应页面；待处理大于 0 时 chip 呼吸描边。
- **建议动作 chips**：按当前状态生成（例如「有 2 个审批待处理」「Sprint 3 verify 失败，看 from-audit 单」），点击即把预置 prompt 填入 composer。
- 快捷入口卡片行：打开看板 · 当前 Sprint 驾驶舱 · 新建工作项。

## 2. 收件箱（`/inbox`）— 新页面

**这页回答**：哪些事必须由我裁决，以及裁决所需的全部上下文。设计目标是让人被打断的次数最少、每次打断处理得最快——所有需要人的事项只在这一处出现。

**布局**：两栏 list 加 detail（multica inbox 范式，左 360px 列表可拖宽，`--panel` 表面色与内容区分层）。

**左列表**按事项性质分四组，行 = ActorAvatar + 标题 + 摘要 + 相对时间 + 状态环：

- **签核**：plan-signoff、ui-signoff、design-signoff 待批。
- **裁决**：escalation（评审 3 次超限、gate BLOCKED）、audit-deferral（审计 3 轮超限）、accept-defer（story 主打能力未实证）。
- **失败路由**：run permanent 失败的工作项。
- **评审请求（v2.2）**：处于「待人工评审」的 agent 交付——run 终态且分支已推送后由回写通道生成，是 done 的唯一人工入口。
- **通知**（只读）：sprint 相位推进、verify GREEN 或 RED、promote 完成。

**右详情**按类型渲染专用卡：

- 签核：**GateBanner**——判据 checklist 逐条勾叉、缺失原因、关联产物 ArtifactCard 内嵌预览、批准与驳回（驳回必填理由；判据未齐时批准禁用并明示缺什么）。
- escalation：上下文卡（工作项 + run 深链 + 最近失败的 TimelineCollapse 摘要 + 评审累计发现清单）+ 三个动作：批准继续、驳回终止、打开运行详情。
- 失败路由：错误分类徽标 + 最后错误 EvidenceCard + `重派`（新 run）、`回退阶段`、`升级` 三按钮。
- 评审请求（v2.2）：**评审卡**——分支名（mono）、diff 统计（增删行与文件数）、测试执行证据 EvidenceCard（命令、输出、退出码）、审查三问 checklist（设计遵循、边界处理、证据可信，锚定 set-artifact-review）、**结构化核对清单（v2.2.1，SDLC-061/062）**——按工作项 nature 自动装配的硬核对项，与三问同锚点持久化，内置必查：schema 变更→「新表/新列↔迁移数组逐一对账」加「迁移冒烟证据在场」（B5 实测 vLLM 与 brain 双双漏检）、多表级联写→「事务包裹」（B2 实测 spec 作者盲区）；核对项可机器预填（diff 静态比对 schema 表名与迁移 SQL），未全部确认时批准合并置灰、按文件折叠的 diff 查看器；操作：`批准合并`（记 PASSED verdict → done）与 `驳回返工`（CHANGES_REQUESTED 加意见清单 → 重派 dev fix 模式）。这是自举中"人工评审全程走 SSH"的页面化答案。

**关键交互**：处理完成的项乐观滑出列表，可切「已处理」过滤回看。**状态与空态**：全部处理完显示安静的空态（「没有需要你的事」+ 最近处理记录入口），不放营销性插画。

<callout color="yellow_bg">
	**批准即回调**：签核批准后立即重估 advance 判据；escalation 批准经 gateRef 回调 orchestrator 的 `nodeResolveGate` 解锁挂起的 DAG（30 秒内生效）。收件箱不是"留言板"，每个批准都直接驱动流程前进——这是它与通知中心的本质区别。
</callout>

## 3. 看板（`/board`）

**这页回答**：所有工作项现在各在哪个阶段、谁在动、哪里卡住了。修复现状三缺陷：只读列、无拖拽、阶段机与派发两张皮。

**布局**：工具栏（视图切换 看板/列表/泳道 + Sprint、类型、优先级、风险、负责人筛选 + 拼音搜索 + 列显隐，筛选状态入 URL 可分享）+ 七列看板（七阶段）。

**BoardCard**（组件解剖见 01 章）：类型徽标 + PriorityBars + key（mono）+ 标题 + 标签 + 底部 StageStepper 微缩条 + ActorAvatar + **运行信号**——绑定 run 非终态时显示 breathe spinner 与当前节点名（「dev 运行中」，点击深链 run 详情）；等待人工门时显示 hand-stop 徽标。失败项用低饱和 destructive 底色 tint 加描边，附错误一行摘要（不用左侧竖条）。列头 = StatusRing + 阶段名 + mono 计数；实施列头额外显示「运行中 x · 排队 y」。

<callout color="yellow_bg">
	**拖拽有门**：相位派生的阶段（待办~设计、验收~交付）单卡没有独立前进语义——向前拖等于发起 **sprint 相位推进请求**（弹 GateBanner 说明作用于整个 sprint 并列出判据，如「缺 design-signoff」），不满足即弹回；向后拖等于回退，绑定活跃 run 时先弹 runCancel 确认。实施/测试列之间不可手拖（回写通道或「人工完成」专属）。看板因此既保留拖卡的直觉，又不给
</callout>

<callout color="red_bg">
	**实施与测试列之间禁止手拖**：这两个阶段只由回写通道推进（run 终态驱动），拖动时显示禁止光标与提示。人不能替系统宣称"实施完成"——完成必须有 run 证据。
</callout>

其余视图：**列表视图** = ListGrid（列：key、标题、阶段、优先级、风险、Sprint、负责人、运行状态、更新时间），多选出批量操作浮条（改 Sprint、改优先级、入队）；**泳道视图** = 行为 Sprint 或负责人、列为阶段，多 sprint 并行时的总览。实时性：useDbSync 轮询 + 乐观更新，卡片移动带 FLIP 动画。空态与无匹配态分文案呈现（「还没有工作项」带新建 CTA、「没有匹配项」带清除筛选）。

## 4. 工作项详情（`/items/:id`）

**这页回答**：这个工作项现在处于什么状态、系统为它做过什么（附证据）、卡住时我能做什么。

**布局**：两栏——内容流（自适应）+ InspectorPanel（320px，`--panel` 表面）。头部：面包屑（项目 / Sprint）+ key（mono）+ 类型徽标 + StatusRing + 标题（InlineEdit）+ 主操作区：`派发`（按工作流选择器预选模板，可展开覆盖模板、模型档、参数）· 失败时三操作（重派、回退、升级）· 三点菜单（复制、删除带确认）。

**内容流**自上而下六段：

1. **StageStepper**：全宽，plannedStages 子集感知（缺陷类只渲染 实施、测试 两节点）；每个门位可点开 GateBanner 弹层看判据。
2. **需求区**：description（markdown 渲染 + 编辑）；UI 类工作项附 ui-spec 对应屏摘要卡（屏名 + 原型深链缩略图）。
3. **执行记录**（multica ExecutionLogSection 范式，融合现状两条时间线为一条）：本工作项全部 run——active 置顶（DagMiniMap + 当前节点 + 计时器），历史折叠为「历史运行 (N)」；行 hover 原地替换出 `重试节点`、`打开运行`、`查看转录`；转录以 TimelineCollapse 全屏 Dialog 呈现（含复制全文）。交付横幅以 EvidenceCard 形式给出 PR 链接、分支、合入状态。
4. **产物区**：本工作项产物（brief、测试证据、报告）ArtifactCard 列表 + 版本链入口。产物卡带「在 content 打开」深链（human 富呈现页），卡内预览与签核判据锚定 tracker 纯文本版（P11 双表征）。
5. **依赖关系**：mini 依赖图（本项正负一度邻居，blocked-by 未解除的边红色高亮）+ 添加链接（组合框搜索工作项，7 种链接类型）。
6. **活动与评论**：统一时间线（本地活动、回写事件、评论混排，actorKind 徽标区分；回写事件标注来源 reconciler 或轮询）。评论用 TiptapComposer。

**InspectorPanel**（PropRow 点击即改、乐观更新）：状态（v2.2：点击开**受守卫流转对话框**——只列守卫表允许当前用户走的目标状态，强制填 reason，缺证据的迁移给缺口提示；未派发项在此关闭；全部写审计）· 优先级（PriorityBars 选择器）· 风险 · 类型 · 性质 · Sprint · 负责人（真实成员列表 + agent 选项，修复现状假下拉）· 仓库（项目 repos 下拉）· 分支（mono，自动派生可改）· 标签 · 工作流模板（覆盖选择器）· 关联 run 与线程深链 · 创建与更新时间。配套修复：`get-work-item` 必须返回 owner、nature 等全部字段。

## 5. Sprint 列表与驾驶舱

### 5.1 列表（`/sprints`）

统计卡行（进行中、待发布、活跃工作项、待我处理）+ 卡片网格。卡片 = 名称 + 相位徽标（八相位 StatusRing 色）+ 目标一行 + 分支（mono）+ 迷你相位进度条（planning 至 done 八段）+ 已交付 x/y + 主按钮随相位变化：`进入工作台`、`查看驾驶舱`、`发布`。发布按钮接真：状态置为已发布 + changelog 联动，幂等。

### 5.2 Sprint 驾驶舱（`/sprints/:id`）— 核心页

**这页回答**：这个 sprint 现在推进到哪、当下最要紧的是什么、下一步门槛还差什么。它是一个 sprint 从规划到交付的单页指挥部——相位面板随相位切换内容，保证任何时刻页面的第一屏都是"当下的事"。

```text
┌ 头部：名称 + phase 时间线（八相位 Stepper，当前相位呼吸）────────────┐
│  planning → designing → executing → verifying → auditing →          │
│  promoting → storytelling → done      [进入规划工作台] [推进相位▸]   │
├──────────────────────────── 两栏 ────────────────────────────────────┤
│ 左（自适应）                         │ 右（320px Inspector）          │
│ ① 相位面板（随 phase 切换内容）       │ 目标/分支/起止（PropRow）      │
│ ② 工作项表（ListGrid：key/标题/      │ 签核状态卡（三道门迷你         │
│    阶段/运行信号/PR）                │   GateBanner，点开详情）       │
│ ③ 产物库（分组 ArtifactCard +        │ 健康门状态（vLLM/CC/槽）       │
│    版本链 + human/agent 徽标 + diff） │ lead 线程深链（brain）         │
│ ④ 审批记录（历史签核/裁决时间线）      │ 度量摘要（燃尽微图+耗时）      │
└──────────────────────────────────────┴──────────────────────────────┘
```

**相位面板**随相位呈现当下最重要的事：

- planning 与 designing：进入规划工作台的分步进度卡（各步状态环）。
- executing：派发看板（队列中、运行中、已合入三列微缩卡，依赖等待标注「等待 R2」）+ 实时合入流（sprint 分支 git 时间线）。
- verifying：verify run 进度 + 场景 PASS/FAIL 表（每行附 EvidenceCard）+ from-audit 回环卡（自动建单、修复、重跑的闭环可视化）。
- auditing：`audit-report:{n}` 轮次卡（verdict + blocking 清单 + 证据抽查）。
- promoting：逐仓晋升进度（拓扑序列表 + merge-commit sha）。
- storytelling 与 done：story 产物 + 发布按钮 + recap 摘要。

**右栏 Goal 卡（v2.1）**：目标一句话 + 指标清单（M 编号），每条带 MET/PARTIAL/UNMET/待审计状态环——数据由 gap-analysis 轮次产物回填。这是 sprint 的 definition-of-done 常驻视图：任何相位都能一眼看到「完成的定义」与当前判定状态。产物库每卡带「content 富呈现」与「agent 视图」双入口及渲染状态微标（P11）。

**推进相位按钮**始终显示下一相位与判据满足度（例如「推进到 executing · 判据 3/4」），点击执行 sprint 级 advance；未满足时禁用并以 GateBanner 弹层列出缺项。判据永远可见——人不需要猜"为什么点不动"。

## 6. Sprint 规划工作台（`/sprints/:id/studio`）— 全新核心页

**这页回答**：把一个 sprint "说清楚"还差哪几步、每步的产物长什么样、现在轮到我回答什么。它把 02 章的规划技能链变成结构化工作台，是 planning 与 designing 两相位的主战场，也是本设计中人机协作密度最高的一页。

**三栏协作逻辑**：三栏各司一职——**步骤轨**管进度与门（我在哪、还差什么）、**产物区**管文档与质量（产出是否够好）、**会话区**管对话（系统正在问我什么）。人的注意力从右到左流动：在会话区回答问题，产物在中栏渐次成形，步骤轨的状态环随定稿逐一点亮，最终在签核区落章。三栏不是三个功能的并列，而是"访谈驱动产物、产物满足门槛"这条流水线的空间化。

```text
┌ 步骤轨(220px) ─┬─ 产物区(自适应) ──────────────┬─ 会话区(400px，可收) ─┐
│ ① 头脑风暴(可选)✓│ 当前步骤的产物文档：            │ AgentComposerFrame     │
│ ② Sprint 规划 ✓ │  · markdown 渲染 + 版本链      │ 驱动当前步骤技能：       │
│ ▶③ 测试计划 ◐   │  · human/agent 徽标           │  InterviewCard 流       │
│ ④ UI 设计 ○     │  · 与上版 diff 切换           │  （一次一问 + 推荐       │
│ ⑤ 技术设计 ○    │  · 质量门 checklist 条         │   答案 chip + 已答       │
│ ⑥ 对抗评审 ○    │ （步骤为访谈时：HolisticReveal │   摘要可回溯改答）       │
│ ⑦ Briefs ○     │   整块揭示 + 采纳按钮）        │ 定稿时揭示→左区         │
│ ── 签核区 ──    │                               │                        │
│ plan-signoff ✓  │                               │                        │
│ ui-signoff ○    │                               │                        │
│ design-signoff ○│                               │                        │
└────────────────┴───────────────────────────────┴────────────────────────┘
```

**产物区工具行**（每步统一）：手工导入（P12：粘贴或上传现成文档直接定稿）、agent 视图（P11：看 agent 实际读到的纯文本）、在 content 打开（human 富呈现页）、版本链、与上版对比。

**步骤轨**：七步加三门。每步 StatusRing（未开始、进行中、已定稿）；条件步骤（④ UI 设计仅含 UI 面的 sprint 激活）不适用时显示「不适用」并可手动激活；**可选步骤（① 头脑风暴）标「可选」、一键跳过**；步骤可非线性回访——回访已定稿步骤等于查看产物并可发起新版本。

**低摩擦保底（P12）**：每步产物区都有「手工导入」入口——直接粘贴或上传现成文档定稿为产物（producedByKind=human），不强制走访谈；整个工作台也可绕过：驾驶舱直接建产物、发起签核，系统只校验判据不强制路径。原来在纯 markdown 时代容易做的事，进了系统必须仍然容易。

**观察问题池泳道（v2.2）**：工作台底部可展开「问题池」——项目 backlog 中未挂 sprint 的观察与系统问题项，按优先级排列；拖入当前 sprint 即挂载，沉淀"发现的问题→下个 sprint 的输入"这条自举回路。

**规模告警与拆分入口（v2.2）**：Briefs 步骤结果卡对每个 brief 显示预估触达文件数；超过 6 个文件或跨生命周期协同的 brief 标规模告警徽标加「拆分为子任务」按钮——超标项不放行派发（02 章拆分契约）。

**会话区**：一次一问、**每问先给推荐答案**（chip 预填可改，另附备选 chips 与自由输入）；已回答的问题折叠为「问 · 答」摘要行，可回溯改答；步骤定稿时以 HolisticReveal 在产物区整块揭示（全文 + 与上版 diff 摘要 + 采纳按钮），而不是流式零散生成——人审的是完整文档，不是碎片。

**产物区**按步骤呈现专用视图：

- ② Sprint 规划：sprint-doc 渲染 + **质量门条**，两类来源分开呈现（P4）：**确定性校验**（Out-of-Scope 非空、无文件路径、指标带 M 编号——门判据 JSON 附加校验项，action 执行，勾叉不可覆盖）与**技能自评**（可证伪性等主观判据，gates[] 带 verdict 与 evidence，UI 标「自评」徽标，签核人可覆盖、覆盖记录在审批历史）。
- ③ 测试计划：场景卡片栈（每场景：Why、Steps、Expected、**Pass-fail 信号**徽标、执行工具徽标），场景可单独标记「需修改」发回会话区。**富呈现由 content 承载**（发布管道渲染成表格加折叠加审查清单的场景卡页，见 05 章第 5 节）——呈现围绕审查三问组织（覆盖矩阵、旅程图、逐场景三问勾选，见 05 章 5.3）。**勾选是 tracker 侧数据**（审查记录，锚定 artifactId+version；content/工作台只是渲染面），经 `set-artifact-review` 回流为 plan-signoff 判据；产物出新版本时勾选确定性重置。签核判据仍锚定 tracker 纯文本版本。
- ④ UI 设计：ui-spec 屏卡片 + `生成原型`（触发 sdlc-ui-build，进度内嵌）；原型就绪后切**评审模式**——内嵌 design 应用 Present 视图 iframe（多屏切换与屏 Tab 双向同步；tracker 不复制原型，只叠加批注层）+ 右侧批注列表（锚定屏与区域，状态 open 或 resolved）+ `请求修改`（批注集驱动 ui-spec 修订与定点重生成）与 `发起 ui-signoff`。详见 05 章。
- ⑤ 技术设计：technical-design 全文渲染（§4 每工作项锚点导航、§7 文件变更矩阵表格化）+ 引用完整性徽标（文件路径存在性、ui-spec 屏引用检查）。
- ⑥ 对抗评审：轮次报告表（轮、模型、发现、修订）+ 每轮发现列表（置信徽标）+ 版本链 diff；`再跑一轮` 按钮。
- ⑦ Briefs：extract-briefs 结果卡（briefs 数、缺失项、依赖清单，Wave 1 与 Wave 2 实施顺序图）+ 每 brief 预览。

**签核区**：三道 GateBanner 迷你卡，判据满足即亮 `发起签核`；批准动作可直接在此完成（与收件箱等价、双向同步）。Epic 拆解入口放在 ⑦ 步旁：`拆解 Epic` 打开第 7 节的拆解表单。

## 7. Epic 拆解与依赖图（`/items/:id`，type=epic 专属视图）

**这页回答**：这个大需求怎么拆、子项之间谁挡谁、拆得健康不健康。

- **拆解表单**：行式录入子项标题、仓库、依赖（多选兄弟行）、touches（可选路径 chips）；`校验` 按钮跑依赖图校验——成环为错误，链深大于 3、全线性、孤儿为警告，逐条列出并定位；`创建子项` 批量落库（幂等，同名跳过）。
- **依赖图视图**：DagCanvas 渲染子项依赖（节点 = 子项卡：key、标题、阶段环；边 = blocked-by），拓扑分层布局；环检测失败时问题边红色高亮；图上直接拖边即添加依赖，松手即校验，成环立即拒绝并动画回弹。
- **子项表**：ListGrid + 完成度汇总；全部子项到达终阶段时 epic 状态徽标自动置完成，活动流记录闭合事件。

<callout color="red_bg">
	**人拆解红线**：表单区不存在任何「AI 自动拆解」入口——拆解边界由人画，系统只做格式与依赖图校验。这是产品立场（判断权留给人），不是技术限制，模型能力再强也不改。
</callout>

## 8. 队列与调度（`/queue`）— 全面接真

**这页回答**：接下来系统会按什么顺序做什么、谁在等待什么、调度现在健康吗。现状此页几乎全是桩（假暂停、假排序、假审批），本设计全部接真。

- 头部：调度器开关（全局暂停与恢复，真实持久化；暂停时全页 warning 横幅）+ 并发与节流的真实配置读数（来自 orchestrator `queueStatus`，只读展示 + 深链设置）。
- 统计卡：排队 · 运行中 · 等待依赖 · 等待健康门 · 今日完成 · 失败。
- **队列表**分组呈现：运行中（行 = key、标题、当前节点、计时器、DagMiniMap）；可派发（按优先级，拖拽排序**持久化**，支持置顶）；等待依赖（行尾「等待 R2 · 实施中」徽标，依赖解除自动上移并带动画）；等待健康门（显示不健康原因如「vLLM 不可达」，恢复后自动派发）。
- 每行操作：出队 · 立即派发（过门检查）· 打开工作项。
- 健康门状态条：vLLM、CC 登录、brain 槽位三枚健康点 + 最近一次拒绝记录。

## 9. 项目页（`/projects`、`/projects/:id`）

**这页回答**：这个项目的流程怎么配置——仓库、门槛、工作流映射都在这里改，改配置零代码。

列表保持卡片网格（增加相位中 sprint 徽标）。项目设置页扩展为四个 tab：

<table header-row="true">
<tr>
<td>tab</td>
<td>内容</td>
</tr>
<tr>
<td>基本</td>
<td>key、名称、描述</td>
</tr>
<tr>
<td>仓库</td>
<td>project_repos 管理表：gitRemote、baseBranch、testCmdUnit、testCmdFull、e2e 路径、buildTool、`ciMode(github|none)`、`gateMode(stack|tests-only|none)`、devModel 覆盖；行内编辑 + 连通性测试按钮（clone 探测）</td>
</tr>
<tr>
<td>流程</td>
<td>阶段门判据 JSON 的表单化编辑（每相位一张判据卡：所需产物 docKey 多选 + 所需签核 + 附加校验开关）；类型到工作流模板的映射表；模板参数覆盖（评审轮数、模型档）</td>
</tr>
<tr>
<td>成员</td>
<td>负责人候选与通知设置</td>
</tr>
</table>

## 10. 度量（`/metrics`）

**这页回答**：流程快不快、质量稳不稳、人到底花了多少时间在哪。

时间范围分段（Sprint 维度 + 1d、7d、30d）+ 项目筛选，四个区：

- **Sprint 状态**：每工作项 dev、qa、review、gate 各环节耗时条形（自 orchestrator spawns 派生，秒级误差）+ 汇总（均值、最慢环节、瓶颈标注）。
- **燃尽**：按工作项到达终阶段时间的燃尽线 + 相位推进时间线。数据来源是活动流中的阶段迁移回写记录（`tracker_activities` 的状态变更事件，含 from、to 与时间戳）——阶段每次推进都留痕，无需新表。
- **质量**：verify 首次通过率、from-audit 单数与修复时长、评审发现数分布、审计轮次分布。
- **人工介入 recap**：时间线列出该 sprint 全部人工动作（签核、裁决、重派、回退、评论），量化"人花在哪"；与 approvals 表和活动流一一对应，无编造条目。

图表遵循 01 章图表阶梯色；KpiCard + Recharts。

## 11. 数据模型与 action 增量（tracker 侧汇总）

<callout color="blue_bg">
	v2.2 增量：`transition-work-item`（受守卫人工流转与关闭的唯一写入口——守卫表、强制 reason、写审计；也是收件箱评审卡「批准合并/驳回返工」的底层）；work_items.item_key 改为**项目级序列器单点分配**（撞号即分配失败出声，SDLC-038 两次复发的机制性了结）。
</callout>

v1.1 §3.3 的增量全部保留（project_repos、tracker_sprint_artifacts、tracker_approvals、work_items 加列、sprints 加列 phase 与 executorThreadId），v2.0 追加：

<table header-row="true">
<tr>
<td>对象</td>
<td>增量</td>
<td>用途</td>
</tr>
<tr>
<td>tracker_sprint_artifacts</td>
<td>docKey 新增 `ui-spec`、`ui-prototype`、`brainstorm-notes`、`spike-report`；contentRef 支持 `design:<id>`、`content:<id>` 外链</td>
<td>UI track 与跨应用产物</td>
</tr>
<tr>
<td>tracker_artifact_comments（新表）</td>
<td>artifactId、anchor（JSON：screen 与 region）、body、`status(open|resolved)`、authorKind</td>
<td>原型批注与产物评审意见</td>
</tr>
<tr>
<td>tracker_approvals</td>
<td>gateKey 新增 `ui-signoff`、`accept-defer`</td>
<td>三道签核 + story 裁决</td>
</tr>
<tr>
<td>exec_queue</td>
<td>加 position（人工排序持久化）、waitingOn（JSON：deps 或 health）、healthCheckLog</td>
<td>调度器接真</td>
</tr>
<tr>
<td>projects</td>
<td>加 gateConfig（JSON）、workflowMapping（JSON）</td>
<td>流程 tab 配置</td>
</tr>
<tr>
<td>work_items</td>
<td>加 workflowTemplate（nullable 覆盖）</td>
<td>工作流选择器</td>
</tr>
<tr>
<td>navigation 应用状态</td>
<td>视图枚举补齐 + 各页焦点对象</td>
<td>agent context 修复</td>
</tr>
</table>

action 增量（与页面一一对应）：`list-inbox`、`resolve-inbox-item`、`reorder-queue`、`pause-scheduler`、`create-artifact-comment`、`resolve-artifact-comment`、`set-artifact-review`（三问勾选，锚定 artifactId+version）、`request-ui-build`（触发 sdlc-ui-build 并回填产物）、`publish-artifact-to-content`（发布管道，05 章 5.1）、`create-sprint-artifact`（承 v1.1 M1）、`get-sprint-metrics`、`update-gate-config`；以及既有缺陷修复：`get-work-item` 返回全字段、既有 `trigger-stage`、`complete-stage`、`rollback-stage` 收敛为 02 章定义的 `advance-stage`（幂等加前置断言）与 `rollback-stage` 两个入口并接入回写通道（旧名保留为兼容别名）、priority 常量统一（1 为最高）、发布 sprint 接真、`list-sprints` 去 Postgres 专有 SQL。

## 12. 技能清单（tracker `.agents/skills/`）

新增：`brainstorm`、`sprint-plan`、`sprint-test-plan`、`ui-spec`、`sprint-design`、`sprint-review`、`draft-fix-issue`、`sprint-story`、`sprint-recap`（产物模板与质量门按 02 章）；`orchestrating-dispatch`（派发协议：载荷白名单、tags 身份、模板选择）。

清理：残留的 form-* 技能移除；AGENTS.md 按本章导航与类型枚举重写（类型统一为 需求、任务、缺陷、测试、生产问题，并补全样式映射）。
