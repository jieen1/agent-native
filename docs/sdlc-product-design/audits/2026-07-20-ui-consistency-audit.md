# UI 设计一致性审查报告（Foundry 设计系统对齐）

- **工作项**：l7eumji9by
- **日期**：2026-07-20
- **审查对象**：近期新增页面 —— orchestrator `/brain`、`/health`、`/insights`、`/`（\_index）；tracker `/sprints`（SprintsPage）、`/sprints/:id`（SprintDetailPage）、`/sprints/:id/studio`（SprintStudioPage）及其组件闭包
- **依据**：`docs/sdlc-product-design/01-design-system.md`（§2.1 色彩 tokens / §2.2 四级表面模型 / §6 禁则）、`templates/{orchestrator,tracker}/app/global.css`、`templates/orchestrator/app/components/design-system.css`、原型 `docs/sdlc-product-design/prototypes/{s2,s6,s9,s10}-*.html`
- **证据复现**：`bash .design-audit/scripts/scan.sh`（只读扫描脚本，输出与本报告 C1/C2/C3/C4 各节一一对应）

---

## 1. 摘要（逐项结论）

| 检查                    | 结论                                                                                                                                                                                                                                                                                                                                                                                                                                   | 问题数                                                 | 严重度 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------ |
| **C1 语义 token**       | ❌ 未对齐。闭包内**无** `#hex`/`rgb(`/`hsl(` 裸字面量（仅 2 处 `hsl(var(--token))` 属合规写法），但存在 **77 处 Tailwind 裸调色板类**（`violet-*/amber-*/emerald-*/red-*/blue-*` 等），集中在 7 个文件；其中 **3 处缺 `dark:` 变体**，深色下对比度直接失效。已有语义 token（`--agent/--warning/--success/--destructive/--info/--evidence/--brand`）可覆盖绝大多数语义                                                                  | 77（确认 73 + 疑似 4）                                 | 高     |
| **C2 左侧强调竖条**     | ✅ 通过。全闭包仅 3 处 `border-l`，均为**纯分隔线**（`border-l border-border`，无宽度强调、无强调色），无 `::before/::after` 竖条                                                                                                                                                                                                                                                                                                      | 0 违规（3 处非违规命中）                               | —      |
| **C3 --panel 次级面板** | ❌ 未对齐。**根因：`--panel` token 未在任一应用落地**（两个 global.css、design-system.css、core 样式均无定义，grep 零命中），而规范 §2.2/§6.3 与原型（s2:193-194/234、s9:181/246）均要求 L1 面板用 `--panel`。现状 5 个 L1 面板以 `bg-muted/10~40` 近似（light 下尚可、dark 下偏暗），1 处检查器内嵌块用 `--background`                                                                                                                | 6 处不合规（5 面板 + 1 内嵌块）                        | 中     |
| **C4 双主题**           | ⚠️ 部分通过。**路 A（代码证据）**：两个 global.css 的 `.dark` 块对 `--background/--foreground/--panel 族/--border` 等关键 token 覆写完整，主题机制（next-themes class 策略 + `.dark` 选择器）成立；但交叉 C1 发现 3 处写死深色文字在 dark 下失效（SprintDetailPage 737/745/907）。**路 B（截图证据）**：4 屏 × 双主题原型截图真实有效（playwright file:// 直开，1440×904，与 baseline 同分辨率）；活页面截图**未验证**（见 §6.2 原因） | 路 A：3 处失效点；路 B：原型 8/8 有效，活页面 0/9 有效 | 中     |

**一句话**：竖条红线守住了，token 覆写机制也健全；主要欠账是 ① `--panel` 从未落地导致 L1 面板全线用替代色，② brain/SprintsPage/SprintDetailPage 三个文件把整套状态/角色配色写死在 Tailwind 调色板上（violet≈--agent、amber≈--warning、emerald/red≈--success/--destructive 均已有现成 token）。

---

## 2. 方法与工具

### 2.1 环境

- 单次 spawn、无网络安装：**未执行** `pnpm install`、**未启动**任何 dev server、未构建。
- 全部代码证据来自 `grep -nE` / 直接读文件；行号以审查时 HEAD（`400ce7fcc`）为准。
- 截图能力探测：仓库 `node_modules/.pnpm/playwright@1.61.1` 存在且 chromium 可用（此前已成功出图，见 §6.2）；本次复核未重新拉起浏览器（3 分钟时限策略：已有可信产物则复用并核验，不重复消耗）。

### 2.2 审查闭包（由路由 import 推导）

| 入口                                                             | 直接/间接纳入的组件                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `templates/orchestrator/app/routes/brain.tsx`                    | 仅 `@/components/ui/*`（shadcn 基元）+ hooks，无业务组件                                                                                                                                                                                                        |
| `templates/orchestrator/app/routes/health.tsx`                   | `components/board/DataTable.tsx`、`components/board/EmptyState.tsx`、`ui/*`                                                                                                                                                                                     |
| `templates/orchestrator/app/routes/insights.tsx`                 | `components/board/EmptyState.tsx`、`components/health/health-shared.tsx`、`ui/*`                                                                                                                                                                                |
| `templates/orchestrator/app/routes/_index.tsx`                   | `components/health/health-shared.tsx`、`ui/*`                                                                                                                                                                                                                   |
| `templates/tracker/app/routes/_app.sprints.$id_.studio.tsx`      | → `pages/SprintStudioPage.tsx` → `components/studio/{ArtifactToolRow,BriefsStepView,GenericArtifactContent,ProblemPoolDrawer,QualityGateBar,SignoffDialog,StepRail,StudioChatPanel,TestPlanScenarios}.tsx` + `pages/SprintDetailPage.tsx`（AdvancePhaseButton） |
| `templates/tracker/app/pages/{SprintsPage,SprintDetailPage}.tsx` | 根级 `components/{ActorAvatar,ArtifactBadge,InspectorSection,PriorityBars,RunEvidenceList,SprintPhaseStepper,StatusIcon,StatusRing}.tsx`、`components/tracker-format.ts`                                                                                        |

说明：`templates/orchestrator/app/components/brain/` 目录**不存在**（brain 页为单文件路由）；`components/board/` 在 orchestrator 下仅 DataTable/EmptyState 两文件，均已纳入。

### 2.3 grep 模式（C1/C2 判定口径）

- **C1**：`#[0-9a-fA-F]{3,8}\b`、`rgba?\(`、`hsla?\(`、Tailwind 裸色类 `(bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|accent|divide|decoration)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|white|black)-[0-9]`、任意值 `(bg|text|border|ring)-[#…/[rgb…/[hsl…]`。排除项：token 定义文件（global.css/design-system.css）自身；`hsl(var(--token))` 形式判为**合规**（值来自 token，仅书写形式不同）。
- **C2**：`border-left|borderLeft|border-l-|border-l\b` + `::before/::after`（含 Tailwind `before:/after:`）窄宽竖条模式。
- 判定三档：**确认违规**（语义明确且有现成 token 可替）、**疑似**（多色系列暂无对应 token 或代码自带 TODO 注释）、**非违规**（分隔线/合规 token 写法）。

---

## 3. C1 违规清单（裸色值 → 应改 token）

> 复现：`bash .design-audit/scripts/scan.sh`（C1-a / C1-b 两节）。全闭包 C1-a（字面量）**零违规**：唯一命中 `ActorAvatar.tsx:103-104` 为 `hsl(var(--muted))`/`hsl(var(--muted-foreground))`，属 token 引用，非裸值。以下为 C1-b（Tailwind 裸调色板类）共 **77 处**。

### 3.1 orchestrator/app/routes/brain.tsx（27 处）

| 行号             | 片段                                                                                             | 语义                   | 应改 token                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 218-220          | `severityBar`: `"bg-red-500"` / `"bg-amber-500"` / `"bg-emerald-500"`                            | 严重度条               | `bg-destructive` / `bg-warning` / `bg-success`                                                                                       |
| 814, 1026, 1102  | `IconBrain … text-violet-500`（含 `/60`）                                                        | 大脑=智能体色          | `text-agent`（global.css:52 `--agent: 264 38% 54%` 即紫）                                                                            |
| 859              | 状态筛选激活态 `bg-violet-500 text-white`                                                        | 智能体色实底           | `bg-agent text-white`                                                                                                                |
| 916              | `STATUS_DOT[t.status] ?? "bg-slate-400"`                                                         | 未知态兜底点           | `bg-muted-foreground/40`（对齐 health-shared:30 写法）                                                                               |
| 938              | 收尾异常 chip `bg-amber-500/15 … text-amber-700 dark:text-amber-400`                             | 告警                   | `bg-warning/15 text-warning`（token 自带双主题，可删 dark: 变体）                                                                    |
| 1187, 1384       | `hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400`                       | 智能体色 hover         | `hover:border-agent/60 hover:text-agent`                                                                                             |
| 1388             | `?? "bg-zinc-400"`                                                                               | 兜底点                 | `bg-muted-foreground/40`                                                                                                             |
| 1536             | 工具图标 `mcp ? "text-violet-500" : "text-sky-500"`                                              | MCP=智能体 / 内置=信息 | `text-agent` / `text-info`                                                                                                           |
| 1609             | 大脑消息图标 `isResult ? "text-emerald-500" : "text-violet-500"`                                 | 结果/智能体            | `text-success` / `text-agent`                                                                                                        |
| 1616             | 结果气泡 `border-emerald-500/30 bg-emerald-500/5`                                                | 成功 tint              | `border-success/30 bg-success/5`                                                                                                     |
| 1631, 1633       | 错误事件 `text-red-500`、`border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400`         | 错误                   | `text-destructive`、`border-destructive/30 bg-destructive/5 text-destructive`                                                        |
| 1732, 1813, 2044 | Badge `bg-violet-500/10 … text-violet-600 dark:text-violet-400`（tier / Claude 权重 / DAG 纪律） | 智能体 tint            | `bg-agent/10 text-agent`；**2044 处代码注释自述"evidence-ish tone, replace with shared token"，应改 `bg-evidence/10 text-evidence`** |
| 1771             | 别名变更按钮 `bg-amber-500/15 … text-amber-700 dark:text-amber-400`                              | 告警 tint              | `bg-warning/15 text-warning`                                                                                                         |
| 2052             | `IconCheck … text-emerald-500`                                                                   | 成功                   | `text-success`                                                                                                                       |
| 2252             | 槽位条 `i < used ? "bg-violet-500" : "bg-muted"`                                                 | 智能体色计量           | `bg-agent`                                                                                                                           |
| 2262-2267        | `HealthDot`: `bg-emerald-500`/`bg-amber-500`/`bg-red-500`/`bg-zinc-400`                          | 健康点                 | `bg-success`/`bg-warning`/`bg-destructive`/`bg-muted-foreground/40`                                                                  |

### 3.2 orchestrator/app/routes/health.tsx（10 处）

| 行号                    | 片段                                                                                                       | 应改 token                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 130-133                 | `WAITING_COLORS`: vm=`bg-blue-100 text-blue-800 dark:…`、acp=`purple-…`、deps=`amber-…`、approval=`pink-…` | **疑似**：等待类别四色系列，token 表无"类别色"定义。建议映射 vm→`info`、acp→`agent`、deps→`warning`、approval→`evidence`（或新增类别 token，需设计决策） |
| 303, 464, 557, 570, 583 | `text-amber-600 dark:text-amber-400`（阈值/遥测告警文案）                                                  | `text-warning`                                                                                                                                           |
| 396                     | `IconCheck … text-emerald-500`                                                                             | `text-success`                                                                                                                                           |

### 3.3 orchestrator/app/components/health/health-shared.tsx（2 处）

| 行号 | 片段                                | 应改 token   |
| ---- | ----------------------------------- | ------------ |
| 28   | `tone === "ok" && "bg-emerald-500"` | `bg-success` |
| 29   | `tone === "warn" && "bg-amber-500"` | `bg-warning` |

（同文件 30-31 行 `bg-muted-foreground/40` 为合规写法，正是 brain.tsx:916/1388/2267 兜底点应看齐的范式。）

### 3.4 tracker/app/pages/SprintsPage.tsx（13 处）

| 行号    | 片段                                                                                   | 应改 token                                 |
| ------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| 54, 77  | `sprintStatusColor`/`sprintPhaseColor`: 进行中 `bg-blue-500 text-white`                | `bg-info text-white`                       |
| 56, 79  | 已完成 `bg-emerald-500 text-white`                                                     | `bg-success text-white`                    |
| 58      | 已发布 `bg-emerald-600 text-white`                                                     | `bg-success text-white`（或 `success/90`） |
| 343-344 | StatCard 进行中 `bg-blue-100 dark:bg-blue-900/30` + `text-blue-600 dark:text-blue-400` | `bg-info/15 text-info`                     |
| 349-350 | 待发布 emerald 同构                                                                    | `bg-success/15 text-success`               |
| 355-356 | 活跃工作项 amber 同构                                                                  | `bg-warning/15 text-warning`               |
| 361-362 | 队列中 purple 同构                                                                     | `bg-agent/15 text-agent`                   |

### 3.5 tracker/app/pages/SprintDetailPage.tsx（21 处）

| 行号          | 片段                                                                                                                                                   | 应改 token                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 125           | ScaleBadge `bg-amber-100 … text-amber-800 dark:bg-amber-900/30 dark:text-amber-400`                                                                    | `bg-warning/15 text-warning`                                                                                                                             |
| 139, 141, 143 | `sprintStatusColor` 同 SprintsPage 54/56/58                                                                                                            | `bg-info` / `bg-success` / `bg-success`                                                                                                                  |
| 175-183       | `itemTypeColor`: 需求 indigo / 任务 slate / 缺陷 red / 测试 teal / 生产问题 rose（均 `-100/-700 + dark:-900/30/-400`）                                 | **疑似**：五类工作项类型色，token 表无类型色定义。缺陷→`destructive` 可直替；其余四类建议收敛为 `info/agent/evidence/muted` 或新增类型 token（设计决策） |
| 203-217       | `stageColors`: 待办 gray-300 / 分析 amber-400 / 设计 yellow-400 / 实施 blue-400 / 测试 purple-400 / 验收 indigo-400 / 交付 emerald-400 / 兜底 gray-300 | **疑似**：阶段泳道八色系列，确无 token 可用（与原型 s6 的 chart-1..5 系列色同类）。建议要么定义为 `--chart-*` 系列 token，要么收敛到语义五色             |
| 737           | 审批 Badge `bg-amber-400/20 text-amber-700`（**无 dark: 变体**）                                                                                       | `bg-warning/15 text-warning` —— ⚠️ 同时是 C4 失效点                                                                                                      |
| 745           | 已批准 Badge `bg-emerald-400/20 text-emerald-700`（**无 dark: 变体**）                                                                                 | `bg-success/15 text-success` —— ⚠️ C4 失效点                                                                                                             |
| 907           | 待审计数 Badge `bg-amber-400/20 text-amber-700`（**无 dark: 变体**）                                                                                   | `bg-warning/15 text-warning` —— ⚠️ C4 失效点                                                                                                             |
| 941           | 待审批卡 `border-amber-200 bg-amber-50/50 dark:border-amber-900/30 dark:bg-amber-950/20`                                                               | `border-warning/30 bg-warning/5`（token 双主题，删 dark: 变体）                                                                                          |

### 3.6 闭包延伸组件（4 处）

| 文件:行号                                                | 片段                                           | 判定                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `templates/tracker/app/components/ArtifactBadge.tsx:28`  | 人工 `bg-amber-100 text-amber-800 dark:…`      | 确认：`bg-warning/15 text-warning`                                                                                  |
| `templates/tracker/app/components/ArtifactBadge.tsx:29`  | 智能体 `bg-blue-100 text-blue-800 dark:…`      | 确认：`bg-agent/15 text-agent`（该组件注释称对齐原型 `.badge.b-agent`，而 b-agent 正是紫/agent 色，用 blue 属偏色） |
| `templates/tracker/app/components/tracker-format.ts:105` | `INBOX_KIND_CHIP["pending-approval"]` amber 系 | 确认：`bg-warning/15 text-warning`（文件注释已自述"尚未映射到 --warning/--evidence，集中在此待替换"）               |
| `templates/tracker/app/components/tracker-format.ts:106` | `INBOX_KIND_CHIP["review-request"]` violet 系  | 确认：`bg-evidence/10 text-evidence`（注释自述应映射 --evidence）                                                   |

### 3.7 C1 小结

- **确认违规 73 处**（有现成 token 可直接替换，无需设计决策）；**疑似 4 组**（health WAITING_COLORS、SprintDetail itemTypeColor/stageColors —— 多色系列确无对应 token，需设计侧补 token 或给出映射）。
- 重灾区：`brain.tsx`（27）、`SprintDetailPage.tsx`（21）、`SprintsPage.tsx`（13）。
- 正面发现：`StatusRing/StatusIcon/PriorityBars/ActorAvatar` 四件套（design-system.css + tracker 同名组件）**全程走 token**；`SprintDetailPage.PHASE_TONE`（153-162 行）已是 `bg-info/bg-warning/bg-agent/bg-success` 的合规范式——说明团队已有正确写法，裸色多为早期页面遗留。

---

## 4. C2 命中清单 + 判定（左侧强调竖条）

复现：`scan.sh` C2 节。全闭包命中 3 处，`::before/::after` 竖条模式命中 0 处（`ArtifactToolRow.tsx:26/259-260` 的 `before/after` 为 diff 数据变量名，非伪元素）。

| 文件:行号                                                        | 上下文                                                                                 | 判定                   | 理由                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `templates/orchestrator/app/routes/brain.tsx:1217`               | `<aside className="hidden w-80 … border-l bg-muted/10 p-3 xl:flex">`（右侧上下文面板） | **非违规**（纯分隔线） | 默认 1px、颜色为中性 `--border`，作用是面板与转录区的结构分界，非状态/选中强调；规范 §6.1 禁止的是"竖向**强调色**条"（left-border accent），此处无色条 |
| `templates/tracker/app/components/studio/StudioChatPanel.tsx:40` | 折叠态会话轨 `border-l border-border bg-muted/40`                                      | **非违规**（纯分隔线） | 显式 `border-border` 中性色、1px，结构分界                                                                                                             |
| `templates/tracker/app/components/studio/StudioChatPanel.tsx:57` | 展开态 400px 会话轨 `border-l border-border bg-muted/40`                               | **非违规**（纯分隔线） | 同上；与原型 s2 `.chat-rail{border-left:1px solid var(--border)}`（s2-sprint-studio.html:234）完全一致                                                 |

**结论：C2 零违规。** 失败卡/选中行/证据卡均未使用 left-border accent；brain 线程选中态用的是 `bg-accent`（brain.tsx:885），符合 §6.1"底色 tint 表达选中"的替代方案。

---

## 5. C3 面板合规表（--panel 核对）

### 5.1 前提：`--panel` 在应用侧未落地（根因）

- 规范定义：`01-design-system.md:40`（light `oklch(0.972 …)`）、`:77`（dark `oklch(0.215 …)`）；§2.2 表面模型（:108）与 §6 禁则 3（:634）均强制 L1 面板用 `--panel`。
- 落地核查（`scan.sh` C4-路A 第一节）：`grep -rn -- "--panel" templates/{orchestrator,tracker}/app`（css/tsx/ts）**零命中**；`packages/core/src/styles/agent-native.css` 亦无。即 **token 根本不存在，任何页面都无法 `var(--panel)`**。
- 原型侧已实现：`prototypes/s2-sprint-studio.html:28/44` 定义 `--panel` 双主题值，`:193-194`（.steps-rail）、`:234`（.chat-rail）消费；`s9-brain-console.html:181`（.thread-rail）、`:246`（.side-panel）消费。

### 5.2 逐面板核对

| 页面                      | 面板（位置·宽度）                      | 实际背景（文件:行号）                                                   | 规范要求                                           | 合规                                 |
| ------------------------- | -------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| /brain（s9）              | ThreadRail 线程轨（左 288px）          | `bg-muted/20`（brain.tsx:811）                                          | `--panel`（s9:181）                                | ❌ 替代色                            |
| /brain（s9）              | 右侧上下文面板（320px）                | `bg-muted/10`（brain.tsx:1217）                                         | `--panel`（s9:246 同为 320px side-panel）          | ❌ 替代色                            |
| /sprints/:id/studio（s2） | StepRail 步骤轨（左 220px）            | `bg-muted/40`（StepRail.tsx:63）                                        | `--panel`（s2:193-194）                            | ❌ 替代色                            |
| /sprints/:id/studio（s2） | StudioChatPanel 会话轨（右 400px）     | `bg-muted/40`（StudioChatPanel.tsx:57；折叠态 :40 同）                  | `--panel`（s2:234）                                | ❌ 替代色                            |
| /sprints/:id（s6）        | Inspector 右栏（lg 右栏）              | `bg-card`（SprintDetailPage.tsx:1459）                                  | `--panel`（§2.2 :108 检查器= L1）                  | ❌ 用了 --card                       |
| /sprints/:id（s6）        | 检查器内嵌块（评估上下文）             | `bg-background`（SprintDetailPage.tsx:321）                             | `--muted`/`--panel` 单一底色（§6.2 :631）          | ❌ 用了 --background                 |
| /sprints/:id/studio（s2） | ProblemPoolDrawer 问题池（内联折叠块） | 头 `bg-muted/40`（ProblemPoolDrawer.tsx:81）+ 体 `bg-card` 行卡（:114） | §6.2 允许 `--muted`/`--panel` 单一底色**或**单边线 | ✅（muted 头+border 体，未三者齐备） |
| /（\_index）              | HealthBar 健康条                       | `bg-card`（\_index.tsx:77）                                             | L2 卡片（浮于 L0）                                 | ✅                                   |
| /insights、/health        | KPI/四卡                               | `Card`=`--card`（insights.tsx:82 等；health.tsx HealthCard:154）        | L2 卡片网格                                        | ✅                                   |
| /sprints                  | 统计卡/冲刺卡                          | `bg-card`（SprintsPage.tsx:104, 134）                                   | L2 卡片                                            | ✅                                   |
| /sprints/:id              | 各内容卡                               | `bg-card`（SprintDetailPage.tsx:272/395/414/562/568/653/669/924）       | L2 卡片                                            | ✅                                   |

### 5.3 C3 小结

- **5 个 L1 面板全部未用 `--panel`**（token 不存在，以 `bg-muted/10~40` 近似）；`bg-muted/40` 在 light 下（约 97% 灰）与原型 `--panel` 视觉接近，但 **dark 下 `--muted` = `220 4% 10%` 比原型 `--panel` dark（约 21.5% L）明显更暗**，面板与背景层次被压缩——这是"token 未落地"的直接视觉代价。
- **2 处用错替代 token**：SprintDetailPage.tsx:1459（检查器用 `--card`）、:321（内嵌块用 `--background`）。
- 修复路径单一且收敛：在两个 global.css 补 `--panel`（值取 01-design-system.md:40/:77 的 oklch→HSL 换算，与现有 triplet 约定一致）+ `@theme` 映射，上述 5 个面板改 `bg-panel` 即可，不涉及业务逻辑。

---

## 6. C4 双主题

### 6.1 路 A：静态 token 覆写核对（必做，已完成）

**主题机制**：两应用 `root.tsx` 均引入 `next-themes`（orchestrator root.tsx:6、tracker root.tsx:14，class 策略 → `<html class="dark">`），CSS 侧以 `.dark` 选择器覆写；tracker 另有 `components/ThemeToggle.tsx`。原型主题按钮为 `document.documentElement.classList.toggle('dark')`（s9:430、s10:325），与应用机制等效。

**关键 token dark 覆写核对表**（orchestrator global.css `.dark` 89-129 行 / tracker 92-131 行）：

| token                                                 | light（:root）        | dark（.dark）                                                     | 覆写             |
| ----------------------------------------------------- | --------------------- | ----------------------------------------------------------------- | ---------------- |
| --background                                          | `0 0% 100%`           | `220 6% 6%`                                                       | ✅               |
| --foreground                                          | `220 10% 10%`         | `0 0% 90%`                                                        | ✅               |
| --card                                                | `0 0% 100%`           | `220 5% 6%`                                                       | ✅               |
| --popover                                             | `0 0% 100%`           | `220 5% 6%`                                                       | ✅               |
| --primary / --secondary / --muted / --accent          | 各自 light 值         | 全部覆写                                                          | ✅               |
| --muted-foreground                                    | `220 5% 45%`          | `220 4% 60%`                                                      | ✅               |
| --destructive                                         | `0 84% 60%`           | `0 63% 51%`                                                       | ✅               |
| --border / --input / --ring                           | light 值              | 全部覆写                                                          | ✅               |
| --sidebar-\*（8 项）                                  | light 值              | 全部覆写（orc 110-117 / trk 123-130）                             | ✅               |
| --success/--warning/--info/--agent/--evidence/--brand | Foundry §2.1 light 值 | dark 值全部覆写（orc 123-128 / trk 116-121）                      | ✅               |
| --brand-foreground                                    | `0 0% 98%`            | 未覆写（设计如此：近白字色双主题通用，注释见 global.css:119-122） | ✅ 有意为之      |
| --panel                                               | **未定义**            | **未定义**                                                        | ❌ 缺失（见 C3） |
| --fm-\* 动效 token                                    | 常量                  | 常量（规范明示不随主题变）                                        | ✅ 有意为之      |

**与 C1 交叉——"写死颜色导致深色失效"清单**（`scan.sh` C4 末节）：

| 文件:行号                                              | 写死内容                            | dark 下后果                                 |
| ------------------------------------------------------ | ----------------------------------- | ------------------------------------------- |
| `templates/tracker/app/pages/SprintDetailPage.tsx:737` | `text-amber-700`（无 dark: 变体）   | 深底上 700 级琥珀文字对比度不足，基本不可读 |
| `templates/tracker/app/pages/SprintDetailPage.tsx:745` | `text-emerald-700`（无 dark: 变体） | 同上                                        |
| `templates/tracker/app/pages/SprintDetailPage.tsx:907` | `text-amber-700`（无 dark: 变体）   | 同上                                        |

其余裸色命中均自带 `dark:` 变体（如 brain.tsx:938、SprintsPage.tsx:343-362）或为实底圆点/图标色（emerald-500 等在深底上仍可见），不构成硬性失效，但统一换 token 后 dark: 变体可整体删除（token 自带双主题值），维护面收敛。

**路 A 结论**：主题机制与 token 覆写**健全**；失效点 3 处，全部集中在 SprintDetailPage 审批 Badge，根因同 C1。

### 6.2 路 B：真实浏览器截图（尽力而为）

**能力探测结果**：playwright@1.61.1 + chromium 存在于仓库 `node_modules/.pnpm`（无需安装）。此前一轮（2026-07-20T04:41，脚本 `.design-audit/shoot.mjs`）已成功出图；本次复核对产物做了真实性校验（PNG 魔数、IHDR 尺寸、文件哈希），**未重新拉起浏览器**（已有可信产物即复用，遵守 3 分钟时限）。

**① 原型截图（file:// 直开，无需服务器）——8/8 有效**：

| 截图                                                                              | 主题 | 尺寸     | 校验                                                                              |
| --------------------------------------------------------------------------------- | ---- | -------- | --------------------------------------------------------------------------------- |
| `.design-audit/screenshots/prototype-s2-sprint-studio.light.png` / `.dark.png`    | 双   | 1440×904 | PNG 魔数 ✅，与 baseline `prototypes/screenshots/s2-*.png`（实测同 1440×904）可比 |
| `.design-audit/screenshots/prototype-s6-sprint-cockpit.light.png` / `.dark.png`   | 双   | 1440×904 | ✅                                                                                |
| `.design-audit/screenshots/prototype-s9-brain-console.light.png` / `.dark.png`    | 双   | 1440×904 | ✅                                                                                |
| `.design-audit/screenshots/prototype-s10-health-insights.light.png` / `.dark.png` | 双   | 1440×904 | ✅                                                                                |

主题切换方式：`document.documentElement.classList.add('dark')`（shoot.mjs:90-94），与原型自带主题按钮（s9:430）等效；manifest 见 `.design-audit/screenshot-manifest.json`。

**② 活页面截图——未验证，证据无效，不作数**：

- manifest 记录的 9 张应用截图（orchestrator index/brain/health/insights × 2 + tracker sprints × 2，时点 04:41）`httpStatus` 均为 **500**；本次复核发现其中 light 5 张哈希全同、dark 4 张哈希全同（`md5sum` 实测仅 2 个唯一值）——即截到的是**同一错误页**，不含任何 UI 信息。
- 本次 spawn 对常见端口（3000/3002/5173/3101/3102）`curl` 探测：**均无响应**，无现成运行中的服务。
- 按任务约束"**不启动 dev server**、绝不伪造截图"，活页面双主题**判定为未验证**；C4 结论以路 A 代码证据 + 原型截图为准。这些 500 截图保留在 `.design-audit/screenshots/` 内仅作"当时服务不可用"的如实记录，**不得**被当作 UI 证据引用。

---

## 7. 与 baseline 的对齐观察

baseline：`docs/sdlc-product-design/prototypes/screenshots/*.png`（实测 1440×904，与本次原型截图同分辨率，可并排比对）；对照方式：原型 HTML 结构 + 本次原型截图 + 代码静态比对（活页面不可用，见 §6.2）。

| 屏幕                                                                   | 几何/结构对齐                                                                                                                                                                                                | 表面与色彩对齐                                                                                                                                                                                      |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **s2 Sprint Studio** ↔ `SprintStudioPage`+`StepRail`+`StudioChatPanel` | ✅ 高：220px 步骤轨（s2:193 ↔ StepRail.tsx:63 `w-[220px]`）、400px 会话轨（s2:234 ↔ StudioChatPanel.tsx:57 `w-[400px]`）、`border-left:1px solid var(--border)` 分界（↔ `border-l border-border`）均逐值对应 | ❌ 面板底色：原型 `background:var(--panel)`（s2:194/234），代码 `bg-muted/40` —— light 下近似、dark 下偏暗（见 §5.3）                                                                               |
| **s9 Brain 控制台** ↔ `brain.tsx`                                      | ✅ 结构对齐：左线程轨 + 中转录 + 右 320px 上下文面板（s9:181/246 ↔ brain.tsx:811/1217）                                                                                                                      | ❌ 两处偏差：① 面板底色 `--panel` → `bg-muted/20`、`bg-muted/10`；② 原型智能体/大脑色走 `--agent`，代码用裸 `violet-500`（色相接近但非 token，dark 下不随 `--agent` 的 dark 值 `262 56% 69%` 调整） |
| **s10 健康/洞察** ↔ `health.tsx`/`insights.tsx`                        | ✅ KPI 卡网格、四卡布局与原型一致（s10:168 `.kpi{background:var(--card)}` ↔ 代码 `Card`）                                                                                                                    | ⚠️ 卡片层合规（`--card`）；偏差在卡内状态色：原型用 `var(--warning)` 等（s10:119/232），代码用裸 amber/emerald（health.tsx:303/396 等）                                                             |
| **s6 Sprint Cockpit** ↔ `SprintDetailPage`                             | ✅ 内容卡 + 右栏检查器结构与原型一致                                                                                                                                                                         | ❌ 检查器表面 `--panel`（规范 §2.2）→ 代码 `bg-card`（:1459）；阶段泳道色原型为 chart 系列色，代码为裸 Tailwind 八色（:203-217，疑似项）                                                            |

**总观察**：几何与组件结构移植忠实（宽度、边线、组件拆分逐值对应），**差距集中在"表面 token 与状态色 token"这一层**——恰是 C1/C3 的两项欠账，与 §8 修复优先级一致。

---

## 8. 修复建议（按优先级，文件级；本任务不实施）

### P0 — 深色下不可读（3 处，10 分钟）

1. `templates/tracker/app/pages/SprintDetailPage.tsx:737/745/907`：`text-amber-700`/`text-emerald-700` → `text-warning`/`text-success`（或先补 `dark:text-amber-400`/`dark:text-emerald-400` 作最小修复）。

### P1 — 落地 `--panel` token 并接通 5 个 L1 面板（C3 根因，1 个 token PR）

2. `templates/orchestrator/app/global.css` 与 `templates/tracker/app/global.css`：`:root`/`.dark` 增加 `--panel`（值按 01-design-system.md:40/:77 的 oklch 换算成现有 HSL triplet 约定），并在 `@theme` 块补 `--color-panel: hsl(var(--panel))`。
3. 面板接通：`brain.tsx:811`（`bg-muted/20`→`bg-panel`）、`brain.tsx:1217`（`bg-muted/10`→`bg-panel`）、`StepRail.tsx:63`、`StudioChatPanel.tsx:40/57`（`bg-muted/40`→`bg-panel`）、`SprintDetailPage.tsx:1459`（`bg-card`→`bg-panel`）、`SprintDetailPage.tsx:321`（`bg-background`→`bg-muted` 或 `bg-panel`）。

### P2 — 裸色收敛到语义 token（73 处确认项，按文件批改）

4. `templates/orchestrator/app/routes/brain.tsx`（27 处）：violet→`agent`、amber→`warning`、emerald→`success`、red→`destructive`、sky→`info`、slate/zinc 兜底→`muted-foreground/40`；`2044` 处按代码自带注释改 `evidence`。
5. `templates/tracker/app/pages/SprintsPage.tsx`（13 处）与 `SprintDetailPage.tsx`（125/139/141/143/941，共 5 处）：blue→`info`、emerald→`success`、amber→`warning`、purple→`agent`。
6. `templates/orchestrator/app/routes/health.tsx`（303/396/464/557/570/583，6 处）与 `components/health/health-shared.tsx`（28/29，2 处）：amber→`warning`、emerald→`success`。
7. `templates/tracker/app/components/ArtifactBadge.tsx:28-29`、`tracker-format.ts:105-106`（4 处）：按文件自带注释映射 `warning`/`agent`/`evidence`。
8. 替换后统一删除冗余 `dark:` 变体（token 自带双主题值），减少约 30 处 dark: 手写覆写。

### P3 — 需设计决策的多色系列（4 组疑似项）

9. `health.tsx:130-133`（WAITING_COLORS 四色）、`SprintDetailPage.tsx:175-183`（itemTypeColor 五色）、`:203-217`（stageColors 八色）：请设计侧在 Foundry token 表补充"类别色/图表系列色"定义（如 `--chart-1..n`），或给出到现有语义色的收敛映射后再改。

### 不建议

- 不建议为 C2 做任何改动（零违规）；brain 选中态 `bg-accent`、StudioChatPanel 的 `border-l border-border` 均为合规范式，保持现状。

---

## 附：证据索引

- 扫描脚本：`.design-audit/scripts/scan.sh`（可复现 C1/C2/C3/C4 全部代码证据）
- 截图脚本与清单：`.design-audit/shoot.mjs`、`.design-audit/screenshot-manifest.json`
- 有效截图（原型 ×8）：`.design-audit/screenshots/prototype-{s2-sprint-studio,s6-sprint-cockpit,s9-brain-console,s10-health-insights}.{light,dark}.png`
- 无效截图（应用 ×9，HTTP 500 错误页，仅留档不作证据）：`.design-audit/screenshots/{orchestrator-{index,brain,health,insights},tracker-sprints}.{light,dark}.png`
- baseline：`docs/sdlc-product-design/prototypes/screenshots/*.png`（1440×904）
- 规范：`docs/sdlc-product-design/01-design-system.md`（§2.1 :36-40、§2.2 :100-119、§6 :624-641）
- token 落地：`templates/orchestrator/app/global.css`（:root 10-77 / .dark 89-129）、`templates/tracker/app/global.css`（:root 10-80 / .dark 92-131）、`templates/orchestrator/app/components/design-system.css`（全文 token 化，合规）
