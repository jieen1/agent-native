# 03 · Tracker 流程域：逐页面设计

> Tracker 是人使用时间最长的应用：规划、审批、观察、裁决都发生在这里。
> 本章按页面逐一给出：目标 / 布局 / 区域与组件 / 交互 / 状态 / agent 对等面。
> 组件名引用 01 章 §4；流程语义引用 02 章。

## 0. 信息架构与导航

```
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

路由收敛：删除重复的 `/new-work-item`（保留 `/items/new`）；
`navigation` 应用状态补齐 `sprints / sprint / studio / queue / inbox /
metrics / new-item` 视图（现状缺失导致 agent 对这些页面失明）；
`view-screen` 相应返回各页焦点对象（sprint、审批项、队列位）。

全局：⌘K 命令面板（跨工作项/Sprint/审批/页面 + 快捷动作）；`C` 新建工作项。

**框架 Agent 页（`/agent`）复用决策**：上游 `8e6f022fa` 新增全页 Agent 工作区
`AgentTabsPage`（Context/Files/Connections/Jobs/Access 五 tab，见 `agent-page`
技能）。审查结论：

- **直接挂载**：tracker 目前没有 app 级设置页（上面导航图的"设置"落不到实体
  路由，只有 `AgentSidebar` 内置设置浮层），挂 `/agent` 零成本拿到
  Files/Access 两个界面，不必另起设置页。
- **§9 项目设置维持独立**：project 级仓库/流程/成员配置与 Agent 页（app 级、
  关于"本应用默认 agent 能被谁连、能连谁"）作用域不同，不下沉为 Agent 页
  tab。
- **Connections tab 价值有限，不要过度承诺**：tracker↔orchestrator 生产链路
  是刻意做成的确定性 MCP `tools/call`（`agent-native.json` 的
  `a2a.connections` 已注明"非 A2A NL loop"），走共享 `A2A_SECRET` 签的 JWT，
  不经过 Connections tab 管理的 `AgentsSection` 远程 agent 登记；挂载后只是
  新增一条 `@提及` 自然语言委托的平行通道，对现有回写链路没有治理或替代
  作用。
- **Jobs tab 不解决 T-D**：T-D（无 automations、状态迁移靠 4s 轮询 +
  `get-activity` 内联写回）缺的是 event-bus/automations 后端接线本身；
  Jobs tab 只是既有机制的 UI 通路，机制建成前无东西可展示，且 T-D 在
  《对齐审查》里定性为工程卫生并行项，不在 R1–R5 主线上。

## 1. 问 Tracker（`/`）

保持 chat-first 首页（框架 AgentChatSurface + AgentComposerFrame），增强三点：

1. **今日概览条**（composer 上方，一行四枚 mono 数字 chip）：
   进行中 sprint phase · 运行中/排队工作项 · 待我处理（审批+裁决）·
   今日交付。各 chip 点击深链对应页面。待处理>0 时 chip 呼吸描边。
2. **建议动作 chips**：按当前状态生成（"有 2 个审批待处理""Sprint 3
   verify 失败，看 from-audit 单"），点击即把预置 prompt 入 composer。
3. 快捷入口卡片行：打开看板 / 当前 Sprint 驾驶舱 / 新建工作项。

## 2. 收件箱（`/inbox`）— 新页面

**目标**：人被打断的唯一入口。所有需要人裁决的事项一处处理完。

布局：两栏 list+detail（multica inbox 范式，左 360px 列表可拖）。

左列表：分组眉题 + 行（ActorAvatar + 标题 + 摘要 + 相对时间 + 状态环）：

- **签核**：plan-signoff / ui-signoff / design-signoff 待批
- **评审请求**（v2.2 新增，自举簇六）：处于「待人工评审」的 agent 交付
  ——run 终态且分支已推送后由回写通道生成（02 §8 迁移表），
  是 done 的唯一人工入口
- **裁决**：escalation（评审 3 次超限、gate BLOCKED）、audit-deferral
  （审计 3 轮超限）、accept-defer（story 主打能力未实证）
- **失败路由**：run permanent 失败的工作项（重派/回退/升级三操作）
- **通知**（只读）：sprint phase 推进、verify GREEN/RED、promote 完成

右详情：按类型渲染专用卡：

- 签核 → **GateBanner**（判据 checklist 逐条勾叉 + 缺失原因 + 关联产物
  ArtifactCard 内嵌预览 + 批准/驳回）。
- escalation → 上下文卡（工作项 + run 深链 + 最近失败 TimelineCollapse
  摘要 + 评审累计发现清单）+ 操作：批准继续 / 驳回终止 / 打开运行详情。
- 失败路由 → 错误分类徽标 + 最后错误 EvidenceCard + `重派`（新 run）/
  `回退阶段` / `升级` 三按钮。
- 评审请求 → **评审卡**：分支名(mono) + diff 统计（±行/文件数）+
  测试执行证据 EvidenceCard（命令/输出/退出码）+ 审查三问 checklist
  （设计遵循/边界处理/证据可信，锚定 set-artifact-review）+
  **结构化核对清单（v2.2.1，SDLC-061/062）**：按工作项 nature 自动
  装配的硬核对项，与三问同锚点持久化——内置必查项：schema 变更 →
  「新表/新列 ↔ db.ts 迁移数组逐一对账」+「迁移冒烟证据在场」
  （B5 实测 vLLM 与 brain 双双漏检，测试自建表掩盖缺失）；多表级联写 →
  「事务包裹」（B2 实测为 spec 作者盲区）；核对项可机器预填
  （diff 静态比对 schema 表名 vs 迁移 SQL），未全部确认时`批准合并`
  置灰 + diff 查看器（按文件折叠，TimelineCollapse 语汇）+ 操作：
  `批准合并`（触发 merge 节点/记 PASSED verdict → done）/ `驳回返工`
  （CHANGES_REQUESTED + 意见清单 → 重派 dev fix 模式）。这是自举中
  "人工评审全程走 SSH/MCP"的页面化答案。
- 处理完成的项自动滑出列表（乐观），可切"已处理"过滤回看。

批准即回调：签核批准 → advance 判据重估；escalation 批准 → 经 gateRef
回调 orchestrator `nodeResolveGate` 解锁 DAG（≤30s 生效，v1.1 M4-S9 语义）。

## 3. 看板（`/board`）

**目标**：全项目工作项的实时作战图。修复现状"只读列 + 无拖拽 + 状态两张皮"。

- 工具栏：视图切换（看板/列表/泳道）+ Sprint/类型/优先级/风险/负责人筛选 +
  搜索（拼音）+ 列显隐。筛选状态入 URL（可分享）。
- **看板视图**：7 列 = 七阶段。BoardCard（01 §4.1）：类型徽标 +
  PriorityBars + key(mono) + 标题 + 标签 + 底部 StageStepper 微缩 +
  ActorAvatar + **运行信号**（绑定 run 非终态时：breathe spinner +
  当前节点名"dev 运行中"，点击深链 run；awaiting-gate 时 hand-stop 徽标）。
  失败项用低饱和 destructive 底色 tint + 描边 + 错误一行摘要（不用左侧竖条）。
  - **拖拽语义（有门的移动）**：相位派生的阶段（待办~设计、验收~交付）
    单卡**没有独立前进语义**——向前拖=发起 **sprint 相位推进请求**（弹
    GateBanner 说明作用于整个 sprint 并列出判据，如"缺 design-signoff"），
    不满足即弹回；向后拖=回退（绑定活跃 run 时先弹 runCancel 确认）。
    实施/测试列之间不可手拖（回写通道或「人工完成」专属），拖动时显示
    禁止光标与提示。
  - 列头：StatusRing + 阶段名 + mono 计数；实施列头额外显示
    "运行中 x / 排队 y"。
- **列表视图**：ListGrid，列=key/标题/阶段/优先级/风险/Sprint/负责人/
  运行状态/更新时间，支持批量操作浮条（改 Sprint、改优先级、入队）。
- **泳道视图**：行=Sprint（或负责人），列=阶段——多 sprint 并行时的总览。
- 实时：useDbSync 轮询 + 乐观更新；卡片位置变化带 FLIP 动画。

## 4. 工作项详情（`/items/:id`）

两栏：内容流（自适应）+ InspectorPanel(320px)。

**头部**：面包屑（项目 / Sprint）+ key(mono) + 类型徽标 + StatusRing +
标题（InlineEdit）+ 主操作区：
`派发`（按工作流选择器预选模板，可展开覆盖：模板/模型档/参数）·
失败时三操作（重派/回退/升级）· 三点菜单（复制/**人工完成**（P12：
强制附 PR/commit 证据推进实施→测试，见 02 §1.3）/删除带确认）。

**内容流（上→下）**：

1. **StageStepper**（全宽，plannedStages 子集感知；每个门位可点开
   GateBanner 弹层看判据）。
2. **需求区**：description（markdown 渲染 + 编辑）；UI 项附
   ui-spec 对应屏摘要卡（屏名 + 原型深链缩略图）。
3. **执行记录 ExecutionLog**（multica ExecutionLogSection 范式，融合现状
   两条时间线为一条）：本工作项全部 run——active 置顶（DagMiniMap +
   当前节点 + 计时器），past 折叠"历史运行 (N)"；每行 hover 原地替换出
   `重试节点` `打开运行` `查看转录` 按钮；`查看转录` 开 TimelineCollapse
   全屏 Dialog（含复制全文）。
   交付横幅：PR 链接 + 分支 + 合入状态（EvidenceCard 形）。
4. **产物区**：本工作项产物（brief、测试证据、报告）ArtifactCard 列表 +
   版本链入口。产物卡带「在 content 打开」深链（human 富呈现页），
   卡内预览与签核判据锚定 tracker 纯文本版（P11 双表征）。
5. **依赖关系**：mini 依赖图（本项 ± 1 度邻居，blocked-by 红边高亮未解除者）
   - 添加链接（组合框搜索工作项，7 种链接类型）。
6. **活动与评论**：统一时间线（本地活动 + 回写事件 + 评论混排，
   actorKind 徽标区分；回写事件标注来源 reconciler/轮询）。评论用
   TiptapComposer。

**InspectorPanel（PropRow 点击即改）**：状态（v2.2：点击=**受守卫流转
对话框**——只列 02 §8 守卫表允许当前用户走的目标状态，强制填 reason，
缺证据的迁移给出缺口提示而非静默失败；未派发项在此关闭；全部写审计）·
优先级（PriorityBars 选择器）·
风险 · 类型 · 性质 · Sprint · 负责人（真实成员列表 + agent 选项，修复
现状假下拉）· 仓库（项目 repos 下拉）· 分支（mono，自动派生可改）·
标签 · 工作流模板（覆盖选择器）· 关联 run/线程深链 · 创建/更新时间。
（修复：get-work-item 必须返回 owner/nature 等全部字段。）

## 5. Sprint 列表（`/sprints`）与驾驶舱（`/sprints/:id`）

### 5.1 列表

统计卡行（进行中/待发布/活跃工作项/待我处理）+ 卡片网格：
卡片 = 名称 + phase 徽标（八相位 StatusRing 色）+ 目标一行 + 分支(mono) +
迷你相位进度条（planning→done 八段）+ 已交付 x/y + 主按钮
（按相位变化：`进入工作台` / `查看驾驶舱` / `发布`——发布按钮接真：
status→已发布 + changelog 联动，幂等）。

### 5.2 Sprint 驾驶舱（重设计核心页之一）

**目标**：一个 sprint 从规划到交付的单页指挥部。

```
┌ 头部：名称 + phase 时间线（八相位 Stepper，当前相位呼吸）────────────┐
│  planning → designing → executing → verifying → auditing →          │
│  promoting → storytelling → done      [进入规划工作台] [推进相位▸]   │
├──────────────────────────── 两栏 ────────────────────────────────────┤
│ 左（自适应）                         │ 右（320px Inspector）          │
│ ① 相位面板（随 phase 切换内容）       │ Goal 卡（目标一句话+指标清单， │
│                                      │   每条 M 编号+MET/PARTIAL/     │
│                                      │   UNMET/待审计状态环──────────│
│                                      │   gap-analysis 轮次产物回填；  │
│                                      │   sprint 的 DoD 常驻视图）     │
│                                      │ 分支/起止（PropRow）           │
│ ② 工作项表（ListGrid：key/标题/      │ 签核状态卡（三道门迷你         │
│    阶段/运行信号/PR）                │   GateBanner，点开详情）       │
│ ③ 产物库（分组 ArtifactCard +        │ 健康门状态（vLLM/CC/槽）       │
│    版本链 + human/agent 徽标 + diff + │                                │
│    「content」富呈现与「agent 视图」  │                                │
│    双入口 + 渲染状态微标）            │ lead 线程深链（brain）         │
│ ④ 审批记录（历史签核/裁决时间线）      │ 度量摘要（燃尽微图+耗时）      │
└──────────────────────────────────────┴──────────────────────────────┘
```

**相位面板**（①）随 phase 呈现当下最重要的事：

- planning/designing：进入规划工作台的分步进度卡（六步各自状态环）。
- executing：派发看板（队列中/运行中/已合入 三列微缩卡 + 依赖等待
  标注"等待 R2"）+ 实时合入流（sprint 分支 git 时间线）。
- verifying：verify run 进度 + 场景 PASS/FAIL 表（每行 EvidenceCard）+
  from-audit 回环卡（自动建单→修复→重跑的闭环可视化）。
- auditing：audit-report:{n} 轮次卡（verdict + blocking 清单 + 证据抽查）。
- promoting：逐仓晋升进度（拓扑序列表 + merge-commit sha）。
- storytelling/done：story 产物 + 发布按钮 + recap 摘要。

**推进相位按钮**：始终显示下一相位与判据满足度（如
`推进到 executing（判据 3/4）`），点击执行 advance-stage(sprint)；
未满足时禁用并列出缺项（GateBanner 弹层）。

## 6. Sprint 规划工作台（`/sprints/:id/studio`）— 全新核心页

**目标**：把 02 章 §2 的技能链变成结构化工作台。人在这里完成全部
"说清楚"的工作。planning + designing 两相位的主战场。

**三栏布局**：

```
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

- **步骤轨**：七步 + 三门。每步 StatusRing（未开始/进行中/已定稿）；
  条件步骤（④UI 设计仅含 UI 的 sprint 激活）不适用时显示"不适用"并可
  手动激活；**可选步骤（①头脑风暴）标"可选"，一键跳过**。步骤可非线性
  回访（回访已定稿步骤=看产物+可发起新版本）。
- **低摩擦保底（P12）**：每步产物区都有「手工导入」入口——直接粘贴/上传
  现成文档定稿为产物（producedByKind=human），不强制走访谈；整个工作台
  也可绕过：驾驶舱直接建产物 + 发起签核，系统只校验判据不强制路径。
- **观察问题池泳道（v2.2，自举簇六）**：工作台底部可展开「问题池」——
  项目 backlog 中未挂 sprint 的观察/系统问题项，按优先级排列；拖入
  当前 sprint 即挂载（写 sprintId + 活动流），沉淀"发现的问题→下个
  sprint 的输入"这条自举回路，不再依赖 SSH。
- **规模告警与拆分入口（v2.2，自举簇九）**：⑦ Briefs 步骤的结果卡对
  每个 brief 显示预估触达文件数；>6 文件或跨生命周期协同的 brief 标
  规模告警徽标 + 「拆分为子任务」按钮（预填拆分建议），承 02 §3.10
  拆分契约——超标项不放行派发。
- **产物区工具行**（每步统一）：`手工导入`（P12：粘贴/上传现成文档直接
  定稿）· `agent 视图`（P11：看 agent 实际读到的纯文本）· `在 content 打开`
  （human 富呈现页）· 版本链 · 与上版对比。
- **产物区**按步骤呈现专用视图：
  - ② Sprint 规划：sprint-doc 渲染 + **质量门条**，两类来源分开呈现（P4）：
    **确定性校验**（Out-of-Scope 非空、无文件路径、指标带 M 编号——门判据
    JSON 的附加校验项，action 执行，勾叉不可覆盖）与**技能自评**（可证伪性
    等主观判据，gates[]{key,label,verdict,evidence,overridable}，UI 标
    「自评」徽标，签核人可覆盖、覆盖记录在审批历史）。
  - ③ 测试计划：场景卡片栈（每场景：Why/Steps/Expected/**Pass-fail 信号**
    徽标/执行工具徽标），场景可单独标记"需修改"发回会话区。**富呈现由
    content 承载**（发布管道渲染成表格+折叠+审查清单的场景卡页，见 05 章
    §5）——呈现围绕审查三问组织（覆盖矩阵、旅程图、逐场景三问勾选——见 05 §5.3）。
    **勾选是 tracker 侧数据**（审查记录，锚定 artifactId+version；content/
    工作台只是渲染面），经 `set-artifact-review` 回流为 plan-signoff 判据；
    产物出新版本时勾选确定性重置。签核判据仍锚定 tracker 纯文本版本。
  - ④ UI 设计：ui-spec 屏卡片 + `生成原型`（触发 sdlc-ui-build，进度内嵌）
    - 原型就绪后切**评审模式**：内嵌 design 应用 present 视图 iframe
      （多屏 data-screen 切换）+ 右侧批注列表（锚定屏+区域，批注状态
      open/resolved）+ `请求修改`（批注集→ui-spec 修订→重生成）/
      `发起 ui-signoff`。详见 05 章 §3。
  - ⑤ 技术设计：technical-design §1–§9 渲染（§4 每工作项锚点导航、
    §7 矩阵表格化）+ 引用完整性徽标（文件路径存在性、ui-spec 屏引用）。
  - ⑥ 对抗评审：轮次报告表（轮/模型/发现/修订）+ 每轮发现列表
    （置信徽标）+ 版本链 diff；`再跑一轮` 按钮。
  - ⑦ Briefs：extract-briefs 结果卡（N briefs/缺失项/依赖清单，
    Wave 1/Wave 2 实施顺序图）+ 每 brief 预览。
- **签核区**：三道 GateBanner 迷你卡，判据满足即亮 `发起签核`；
  批准动作也可直接在此完成（等价于收件箱）。
- Epic 拆解入口在 ⑦ 步旁：`拆解 Epic`（打开 §7 的拆解表单）。

## 7. Epic 拆解与依赖图（`/items/:id` type=epic 专属视图）

- **拆解表单**（人写清单红线）：行式录入 子项标题 / 仓库 / 依赖(多选
  兄弟行) / touches(可选路径 chips)；`校验` 按钮跑依赖图校验（环=错误，
  链深>3 / 全线性 / 孤儿=警告，逐条列出+定位）；`创建子项` 批量落库
  （幂等：同名跳过）。表单区**不存在任何 AI 自动拆解入口**。
- **依赖图视图**：DagCanvas 渲染子项依赖（节点=子项卡：key+标题+阶段环；
  边=blocked-by），拓扑分层布局；环检测失败时问题边红色高亮。
  图上直接拖边=添加依赖（松手即校验，成环立即拒绝并动画回弹）。
- 子项表：ListGrid + 完成度汇总；全部到终阶段时 epic 状态徽标自动变
  完成（活动流记录闭合事件）。

## 8. 队列与调度（`/queue`）— 全面接真

- 头部：调度器开关（全局暂停/恢复——真实持久化状态，暂停时全页
  warning 横幅）+ 并发与节流的**真实配置读数**（来自 orchestrator
  queue-status，只读展示 + 深链设置）。
- 统计卡：排队 / 运行中 / 等待依赖 / 等待健康门 / 今日完成 / 失败。
- **队列表**（分组）：
  - 运行中：行=key+标题+当前节点+计时器+DagMiniMap。
  - 可派发（按优先级）：拖拽排序（**持久化**）+ 置顶操作。
  - 等待依赖：行尾"等待 R2（实施中）"徽标，依赖解除自动上移（动画）。
  - 等待健康门：显示不健康原因（"vLLM 不可达"），恢复后自动派发。
- 每行操作：出队 / 立即派发（过门检查）/ 打开工作项。
- 健康门状态条：vLLM · CC 登录 · brain 槽位 三枚健康点 + 最近一次
  拒绝记录。

## 9. 项目页（`/projects`, `/projects/:id`）

列表保持卡片网格（加：phase 中 sprint 徽标）。项目设置页扩展为 tab：

| tab  | 内容                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ | ---------- | ------------------------------------------------------------------ |
| 基本 | key/名称/描述                                                                                                                                                |
| 仓库 | project_repos 管理表（gitRemote/baseBranch/testCmdUnit/testCmdFull/e2e 路径/buildTool/\*\*ciMode(github                                                      | none)**/**gateMode(stack | tests-only | none)\*\*/devModel 覆盖）；行内编辑 + 连通性测试按钮（clone 探测） |
| 流程 | 阶段门判据 JSON 的**表单化编辑**（每相位一张判据卡：所需产物 docKey 多选 + 所需签核 + 附加校验开关）；类型→工作流模板映射表；模板参数覆盖（评审轮数/模型档） |
| 成员 | 负责人候选与通知设置                                                                                                                                         |

## 10. 度量（`/metrics`）

时间范围分段（Sprint 维度 + 1d/7d/30d）+ 项目筛选。四区：

1. **Sprint 状态页**：每工作项 dev/qa/reviewer/gatekeeper 各环节耗时条形
   （自 orchestrator spawns 派生，误差秒级）+ 汇总（均值/最慢环节/
   瓶颈标注）。
2. **燃尽**：按工作项到达终阶段时间的燃尽线 + phase 推进时间线（数据源=
   活动流中的阶段迁移回写记录，含 from/to/时间戳，无需新表）。
3. **质量**：verify 首次通过率、from-audit 单数/修复时长、评审发现数
   分布、审计轮次分布。
4. **人工介入 recap**：时间线列出该 sprint 全部人工动作（签核/裁决/
   重派/回退/评论），量化"人花在哪"（与 approvals/活动流一一对应，
   无编造条目）。

图表遵循 01 章图表阶梯色；KpiCard + Recharts。

## 11. 数据模型与 action 增量（tracker 侧汇总）

v1.1 §3.3 的增量全部保留（project_repos / tracker_sprint_artifacts /
tracker_approvals / work_items 加列 / sprints 加列 phase+executorThreadId），
v2.0 追加：

| 对象                              | 增量                                                                                                                                                 | 用途                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------- |
| tracker_sprint_artifacts          | docKey 新增 `ui-spec` / `ui-prototype` / `brainstorm-notes` / `spike-report` / `briefs-index`；`contentRef` 支持 `design:<id>` / `content:<id>` 外链 | UI track 与跨应用产物                          |
| tracker_artifact_comments（新表） | artifactId / anchor(JSON: screen/region) / body / status(open                                                                                        | resolved) / authorKind                         | 原型批注与产物评审意见 |
| tracker_approvals                 | gateKey 新增 `ui-signoff` / `accept-defer`                                                                                                           | 三道签核 + story 裁决                          |
| exec_queue                        | + position（人工排序持久化）+ waitingOn(JSON: deps                                                                                                   | health) + healthCheckLog                       | 调度器接真             |
| projects                          | + gateConfig(JSON) + workflowMapping(JSON)                                                                                                           | 流程 tab 配置                                  |
| work_items                        | + workflowTemplate(nullable 覆盖)                                                                                                                    | 工作流选择器                                   |
| work_items.item_key               | **项目级序列器单点分配**（DB 序列/advisory lock，create 时分配，调用方不报数；撞号=分配失败出声）                                                    | 标识权威（02 §8，SDLC-038 两次复发的机制性了结 |
| navigation 应用状态               | 视图枚举补齐 + 各页焦点对象                                                                                                                          | agent context 修复                             |

action 增量（对齐页面）：`list-inbox` / `resolve-inbox-item`、
`reorder-queue` / `pause-scheduler`、`create-artifact-comment` /
`resolve-artifact-comment`、`set-artifact-review`（三问勾选，锚定
artifactId+version）、`request-ui-build`（触发 sdlc-ui-build 并
回填产物）、`publish-artifact-to-content`（发布管道，05 §5.1）、
`create-sprint-artifact`（承 v1.1 M1）、`get-sprint-metrics`、`update-gate-config`、
`transition-work-item`（v2.2：受守卫人工流转/关闭的唯一写入口，
02 §8 守卫表 + 强制 reason + 审计；也是收件箱评审卡「批准合并/驳回
返工」的底层）、
以及既有缺陷修复（get-work-item 返回全字段、trigger/complete/rollback-stage
收敛为 advance-stage + rollback-stage 两入口并接入回写（旧名留兼容别名）、
priority 常量统一、发布 sprint 接真、list-sprints 去 Postgres-only SQL）。

## 12. 技能清单（tracker `.agents/skills/`）

新增：`brainstorm` / `sprint-plan` / `sprint-test-plan` / `ui-spec` /
`sprint-design` / `sprint-review` / `draft-fix-issue` / `sprint-story` /
`sprint-recap`（产物模板与质量门按 02 章 §2）；
`orchestrating-dispatch`（派发协议：载荷白名单、tags 身份、模板选择）。
清理：残留的 form-\* 技能移除；AGENTS.md 按本章导航与类型枚举重写
（类型统一为 需求/任务/缺陷/测试/生产问题 并补全样式映射）。
