# 01 · Foundry 设计系统

> 适用范围：tracker、orchestrator 两个应用的全部界面，design 应用中承载的
> 全部 SDLC 原型，以及未来任何加入这条流水线的 mini-app。
> 蓝本：multica 的 OKLCH 语义 token 体系与 Linear 级信息密度；
> 图标体系按本仓库红线替换为 **Tabler Icons**（任何地方不得使用 emoji
> 或文字符号充当图标，包括原型与设计稿）。
>
> 落地位置：本文档是规范；design 应用中注册同名设计系统 **Foundry**
> （`create-design-system`），tokens 与 customCSS 与本文一致；全部原型
> 链接该设计系统并把 tokens 烘焙进各屏 `:root`。
> **活体规范页**：`design-system/foundry-components.html` 按本章顺序渲染
> 每个组件的全部变体与状态，是本规范的可运行参照——文字规范与活体页
> 冲突时，先修活体页再修文档，两处必须同步。

## 1. 性格与立场

Foundry 是一个**工程驾驶舱**设计系统：

- **密**：正文 12–14px，行高紧凑，表格与列表是主角。屏幕上的每一寸都在
  回答"现在什么在跑、卡在哪、下一步是什么"。
- **静**：低饱和中性底色，颜色只用于语义（状态、优先级、品牌动作）。
  界面默认安静，只有"正在发生的事"允许动。
- **诚**：状态永远可见且可追溯——每个徽标可点开看证据；失败态低调而明确
  （内联提示 + 可折叠原始错误），不用大红横幅制造恐慌。
- **双主题**：light / dark 全量支持，token 层完成切换，组件不感知主题。

## 2. Foundations（基础）

### 2.1 颜色（OKLCH）

基础中性（zinc 系，hue ≈ 286）与品牌/语义色（brand hue = 255，工程蓝）：

```css
:root {
  /* 中性 */
  --background: oklch(1 0 0);
  --foreground: oklch(0.141 0.005 285.82);
  --card: oklch(1 0 0);
  --panel: oklch(0.972 0.002 286.35); /* 次级面板表面（列表栏/检查器/轨道） */
  --sidebar: oklch(0.985 0.001 286.38); /* 应用侧边栏表面 */
  --muted: oklch(0.967 0.001 286.38);
  --muted-foreground: oklch(0.552 0.016 285.94);
  --border: oklch(0.945 0.003 286.32);
  --input: oklch(0.92 0.004 286.32);
  --ring: oklch(0.705 0.015 286.07);
  --primary: oklch(0.21 0.006 285.89); /* 近黑，主按钮 */
  --primary-foreground: oklch(0.985 0 0);

  /* 品牌与语义 */
  --brand: oklch(0.55 0.16 255); /* 工程蓝：品牌动作、选中、链接 */
  --brand-foreground: oklch(0.985 0 0);
  --success: oklch(0.55 0.16 145); /* 绿：done/passed/approved */
  --warning: oklch(0.75 0.16 85); /* 琥珀：queued/awaiting/degraded */
  --info: oklch(0.55 0.18 250); /* 蓝：running/info */
  --destructive: oklch(0.577 0.245 27.33); /* 红：failed/rejected/blocked */

  /* 特有语义（Foundry 扩展） */
  --agent: oklch(0.55 0.14 300); /* 紫：agent 行为者（区别于人） */
  --human: oklch(0.55 0.16 255); /* 人＝品牌蓝 */
  --evidence: oklch(0.48 0.1 180); /* 青：证据/审计引用 */

  /* 图表阶梯：沿 hue 255 的明度梯（chart-1 锚定品牌） */
  --chart-1: oklch(0.55 0.16 255);
  --chart-2: oklch(0.65 0.13 255);
  --chart-3: oklch(0.75 0.1 255);
  --chart-4: oklch(0.84 0.07 255);
  --chart-5: oklch(0.92 0.04 255);

  --radius: 0.625rem; /* 10px */
}

.dark {
  --background: oklch(0.18 0.005 285.82);
  --foreground: oklch(0.985 0 0);
  --card: oklch(0.21 0.006 285.89);
  --panel: oklch(0.215 0.006 285.9);
  --sidebar: oklch(0.16 0.005 285.82);
  --muted: oklch(0.274 0.006 286.03);
  --muted-foreground: oklch(0.705 0.015 286.07);
  --border: oklch(1 0 0 / 8%);
  --input: oklch(1 0 0 / 15%);
  --brand: oklch(0.65 0.16 255);
  --success: oklch(0.65 0.14 145);
  --warning: oklch(0.8 0.14 85);
  --info: oklch(0.65 0.16 250);
  --destructive: oklch(0.66 0.2 27);
  --agent: oklch(0.68 0.13 300);
  --evidence: oklch(0.62 0.09 180);
  --chart-1: oklch(0.72 0.14 255);
  --chart-2: oklch(0.62 0.13 255);
  --chart-3: oklch(0.52 0.11 255);
  --chart-4: oklch(0.42 0.09 255);
  --chart-5: oklch(0.32 0.06 255);
}
```

**铁律**：组件与页面**严禁硬编码颜色**，一律使用语义 token
（`bg-success/15 text-success`、`text-brand`、`border-destructive/30`）。
状态底色统一用 `color-mix(in oklch, var(--语义色) 15%, transparent)`
（Tailwind 写法 `<语义色>/15`），保证双主题成立。

### 2.2 表面层级（四级表面模型）

界面纵深只允许四级表面，每级绑定一个 token；**靠表面色分层，不靠阴影**：

| 层级        | token                             | 用途                                     | 边界                  |
| ----------- | --------------------------------- | ---------------------------------------- | --------------------- |
| L0 页面背景 | `--background`                    | 内容区底                                 | —                     |
| L1 次级面板 | `--panel`（侧边栏用 `--sidebar`） | 列表栏、检查器、线程轨、会话轨、抽屉内衬 | 1px `--border`        |
| L2 卡片     | `--card`                          | 卡片、输入框、弹出菜单的表面             | 1px `--border` + 圆角 |
| L3 浮层     | `--card` + `shadow-lg`            | Dialog、Popover、Toast、Tooltip          | 阴影仅此层允许        |

规则：

- **同级表面不叠加**：卡片内不得再放完整卡片（见 §6 禁则），面板内的分组用
  分隔线与眉题，不用嵌套面板。
- L1 面板与 L0 背景**必须有可感知的色差**（`--panel` ≠ `--background`），
  不允许同色仅靠 1px 线分隔。
- L2 卡片放在 L1 面板上时保持 `--card` 表面（light 下即白卡浮在灰面板上，
  dark 下 `--card` 比 `--panel` 略亮）。

### 2.3 半径 / 间距 / 阴影

```
--radius-sm = 6px    徽标、chip、kbd、小按钮
--radius-md = 8px    输入框、按钮、菜单项、小卡
--radius    = 10px   卡片、弹窗、面板
--radius-xl = 14px   大卡、模态、抽屉

间距阶梯（4px 基数）：4 / 6 / 8 / 12 / 16 / 24 / 32
  控件内 gap 4–8；卡片内边距 14–16；页面左右 24；分区间 24–32。
阴影克制：仅 L3 浮层用 shadow-lg；卡片靠 border 而非阴影分层。
滚动条 6px thin，thumb: oklch(0 0 0/12%)（dark: oklch(1 0 0/14%)）。
```

### 2.4 字体

| 角色 | 字体栈                                                           | 用途                                       |
| ---- | ---------------------------------------------------------------- | ------------------------------------------ |
| Sans | `Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif` | 全部 UI 正文                               |
| Mono | `"JetBrains Mono", ui-monospace, "SF Mono", monospace`           | 代码、id、key、数字（`tabular-nums`）、kbd |

字号阶梯（密度优先，全部字号只从此表取）：

| 档位     | 字号/字重                                     | 用途                          |
| -------- | --------------------------------------------- | ----------------------------- |
| 页面标题 | 16–18 / 600                                   | PageHeader h1                 |
| 分区标题 | 13 / 600                                      | 卡片标题、section-title       |
| 分组眉题 | 10 / 600 / uppercase / tracking .08em / muted | group-label、表头、侧栏分组   |
| 正文     | 13 / 400                                      | 列表、表格、表单              |
| 辅助     | 12 / 400 / muted                              | 说明、时间戳、次要元信息      |
| 微标     | 11 / 500                                      | badge、chip 内文字            |
| 数据     | mono 11–12                                    | id、key、计数、耗时、token 数 |

- 中文排版启用 `text-autospace: ideograph-alpha ideograph-numeric`
  （中英/中数间自动间距）。
- 输入法保护：Enter 提交前必须判断 `isImeComposing`。

### 2.5 图标（Tabler Icons）

- 统一 **Tabler Icons**（outline 为主，filled 仅用于选中态）；
  尺寸 16（行内）/ 18（导航）/ 20（页头）；stroke-width 1.75；
  原型中用 webfont：`<i class="ti ti-xxx"></i>`，行内对齐 `vertical-align:-2px`。
- **禁止** emoji、文字符号（＋ ↗ ✓ → 等）充当图标——包括原型与设计稿。
- 核心图标映射（组件库常量，全局唯一出处）：

| 语义      | Tabler 图标        | 语义       | Tabler 图标          |
| --------- | ------------------ | ---------- | -------------------- |
| 项目      | `folder`           | Brain      | `brain`              |
| Sprint    | `run`              | 工作流     | `topology-star-3`    |
| 工作项    | `clipboard-list`   | 运行       | `player-play`        |
| Epic      | `sitemap`          | 节点/Spawn | `cpu`                |
| 看板      | `layout-kanban`    | 工作区     | `git-branch`         |
| 队列      | `list-numbers`     | 健康       | `heart-rate-monitor` |
| 审批/签核 | `rubber-stamp`     | 洞察/度量  | `chart-dots`         |
| 产物      | `file-text`        | 证据       | `certificate`        |
| 依赖      | `arrow-ramp-right` | 人工门     | `hand-stop`          |
| 收件箱    | `inbox`            | 设置       | `settings`           |
| 人        | `user`             | 智能体     | `robot`              |
| UI 设计   | `layout-2`         | 文档       | `book`               |
| 守门      | `shield-check`     | 确定性动作 | `list-check`         |

### 2.6 动效

- **Token 体系**：全部动效走 `--fm-*` token，禁止裸写时长/曲线。一次性时长 `--fm-dur-1: 120ms` / `--fm-dur-2: 240ms` / `--fm-dur-3: 400ms` / `--fm-dur-4: 700ms`；氛围循环时长 `--fm-ambient-1: 1600ms` / `--fm-ambient-2: 2500ms` / `--fm-ambient-3: 3200ms`。曲线：`--fm-ease-standard: cubic-bezier(0.4,0,0.2,1)` 及对应 enter/exit 变体；回弹曲线 `--fm-ease-bounce: cubic-bezier(0.5,1.5,0.4,1)` 仅限完成/庆祝时刻使用。
- **五个标准模式**：`fm-thinking`（文字扫光，agent 运行态专用，替代传统 spinner）、`fm-live`（活跃脉动，只动色彩与阴影，不产生位移）、`fm-complete`（两段式完成：徽章回弹 → 打勾描边）、`fm-nav-progress`（导航扫条，1.4s，路由切换时触发）、`fmCountTo`（数值计数动画）。
- **红线**：高频操作面禁入场表演动效；`overflow` 容器内禁位移类动效；拖拽/手势进行中禁用 `transition`；全量 `prefers-reduced-motion` 降级，无例外。
- **实证出处**：参照 multica.ai（同品类开源 agent 协作平台）源码级动效语言校准。完整规范与活体演示见《Foundry·组件规范》§2.6 动效章。

## 3. 状态语汇（Foundry 的核心资产）

### 3.1 状态环 StatusRing（CSS 绘制，仅限"进行中"语义）

16px（列表内 14px）圆环，纯 CSS 几何绘制（border + conic-gradient），
只承担**非终态**语义：

| 状态                     | 图形                       | 颜色             |
| ------------------------ | -------------------------- | ---------------- |
| 待办 / pending           | 虚线空环                   | muted-foreground |
| 排队 / queued            | 空环 + 中心点              | warning          |
| 进行中 / running         | 半饼（180°填充）+ 呼吸动画 | info             |
| 评审中 / review          | 3/4 饼                     | info             |
| 门前等待 / awaiting-gate | 空环 + 竖条（暂停形）      | warning          |
| 已跳过 / skipped         | 空环 + 斜线                | muted-foreground |
| 已驳回 / rejected        | 禁止符（环 + 斜杠）        | destructive      |

使用规则：非终态的图形一律复用状态环同一实现；**完成/失败等带字形的终态
必须用 3.1a 的 StatusIcon**，禁止用伪元素手绘勾叉——绝对定位像素微调
（`left:3.2px;top:3.8px` 一类）在不同 DPI/缩放下必然偏心，这正是历史上
"对号忽偏忽正"的根因。

### 3.1a 状态图标 StatusIcon（st-icon，终态与判定语义）

实心圆底 + Tabler 字形的统一小组件。结构：`inline-flex` 容器双轴居中 +
`<i class="ti ti-*">` 字形，字形尺寸 ≈ 容器 70%，`line-height:1`，
`vertical-align:-2px` 与正文 x 高对齐——居中由布局引擎保证，永不漂移。

| 变体 | 底色             | 默认字形            | 语义                   |
| ---- | ---------------- | ------------------- | ---------------------- |
| ok   | success          | ti-check            | 完成 / 通过 / 签核有效 |
| err  | destructive      | ti-x                | 失败 / 驳回 / 判据未过 |
| warn | warning          | ti-exclamation-mark | 需注意 / 部分通过      |
| inf  | info             | ti-arrow-right      | 流转 / 进入下一步      |
| mut  | muted-foreground | ti-minus            | 中性 / 不适用          |

尺寸三档：`sm` 12px / 默认 14px / `lg` 18px；嵌套语境用组件级选择器缩放
（如 `.runbadge .st-icon`），**禁止逐处内联 width/height 微调**，禁止用
✓ ✗ × 等文本字符充当图标。

### 3.2 七阶段步进条 StageStepper

工作项与 sprint 的阶段可视化：水平节点条
`待办 → 分析 → 设计 → 实施 → 测试 → 验收 → 交付`，每节点一个 StatusRing +
标签；节点间连线按完成度着色（done=success，active 之后=border）。
带门的位置在连线上叠加一枚小的 `rubber-stamp` 图标（签核门）或
`hand-stop`（人工门），hover 显示门名称与状态。plannedStages 子集
（如 from-audit 单只有 实施→测试）时，未激活阶段直接不渲染而非置灰。
**微缩形态 `mini-step`**：看板卡内 4px 高的分段条，仅用颜色表达进度，
hover tooltip 显示全量阶段。

### 3.3 优先级信号条 PriorityBars

P0–P3 用 4 格阶梯信号条（P0=4 格全亮 destructive，P1=3 格 warning，
P2=2 格 info，P3=1 格 muted）。**全系统 priority 语义统一为 1=P0 … 4=P3**
（修复现状的倒挂），建单表单、看板、接口三处共用同一常量与组件。

### 3.4 行为者头像 ActorAvatar

人 / agent / brain 三形态统一组件：人=圆形照片或姓名首字（20px，品牌蓝底）；
agent=方圆角(6px) + `robot` 图标 + `--agent` 紫描边；brain=方圆角 + `brain`
图标 + 品牌蓝描边。在线/运行态右下角状态点（success 呼吸 / muted）。
看板卡、运行行、时间线、评论、审批卡全部复用。
**形状即语义：圆=人，方圆角=机器。不得混用。**

### 3.5 状态→语义色总映射（唯一出处）

| 域         | 状态                           | 色                              | 环               |
| ---------- | ------------------------------ | ------------------------------- | ---------------- |
| run        | pending/queued                 | warning                         | 空环+点          |
| run        | running                        | info                            | 半饼呼吸         |
| run        | paused                         | warning                         | 暂停形           |
| run        | done                           | success                         | 实心勾           |
| run        | failed                         | destructive                     | 实心叉           |
| run        | cancelled                      | muted                           | 斜线             |
| node       | awaiting-approval              | warning                         | 暂停形+hand-stop |
| stage      | 已驳回                         | destructive                     | 禁止符           |
| approval   | pending / approved / rejected  | warning / success / destructive | —                |
| 健康       | ok / degraded / down           | success / warning / destructive | 圆点 hdot        |
| errorClass | transient / schema / permanent | warning / info / destructive    | —                |
| 行为者     | agent / human / brain          | agent紫 / 品牌蓝 / 品牌蓝       | —                |
| 溯源       | from-audit / 证据引用          | evidence（青）                  | —                |

## 4. 组件规范

以下是两个应用共享的完整组件层（shadcn 基元之上）。每个组件给出结构、
变体、状态与使用规则；页面章节（03/04）直接引用组件名不再重复定义。
**每个组件的可运行样例见 `design-system/foundry-components.html` 同名小节。**

### 4.1 动作类

#### Button 按钮

- **结构**：`[图标?] 文字`，图标 16px 在左；高 28px（md）/ 24px（sm）；
  圆角 `--radius-md`；字号 12.5/12。
- **变体**：
  | 变体 | 表面 | 用途 |
  |---|---|---|
  | primary | `--primary` 近黑实底 | 每屏至多一个的主动作 |
  | brand | `--brand` 蓝实底 | 派发/运行等"启动执行"类动作 |
  | outline | `--card` + `--border` | 次级动作（最常用） |
  | ghost | 透明，hover 上 `--muted` | 行内/工具栏轻动作 |
  | danger | `--destructive` 实底 | 不可逆破坏动作，必须配确认 |
- **状态**：hover（实底变 90% 透明度 / outline 变 muted 底）、focus-visible
  （2px `--ring` 外描边）、disabled（45% 透明度 + not-allowed，**不隐藏**）、
  loading（左侧 breathe spinner 替换图标，文字保留，宽度不跳）。
- **规则**：一屏一个 primary；破坏动作不用 primary 而用 danger；按钮文字是
  动词；禁纯图标按钮无 tooltip。

#### IconButton 图标按钮

24×24 或 28×28，ghost 表面，必须有 tooltip；仅用于高频通用动作
（关闭、复制、刷新、更多）。"更多" 一律 `dots`（横三点）开 DropdownMenu。

#### SegmentedControl 分段控件

互斥小选项集（2–4 个），`--muted` 底轨道 + 选中项 `--card` 白片浮起；
用于视图切换（列表/看板）、时间窗（24h/7d/30d）。超过 4 项改用 Select。

#### TabBarUnderline 下划线 Tab

页面级内容分区；`border-b-2` 激活线（brand），文字 13/500，未激活 muted。
配置类 tab 必须实现**脏守卫**（未保存切换弹 AlertDialog）。
Tab 数 ≤6；溢出用"更多"下拉，不横向滚动。

#### CommandPalette（⌘K）

跨实体搜索（工作项/Sprint/运行/工作流/线程/页面）+ 快捷动作
（新建工作项、派发、切主题、跳转）+ 拼音匹配。全局快捷键：`C` 新建工作项、
`G+B` 看板、`G+S` Sprint、`⌘F` 页内查找（CSS Highlight API）、
`⌘Enter` 提交 composer。

### 4.2 输入类

#### Input / Textarea

高 28px（表单内 32px），`--card` 表面 + 1px `--input` 边；focus 时
`--ring` 描边（2px box-shadow 形式，不改布局）；错误态边框
`--destructive` + 下方 12px 红字错误说明；disabled 45% 透明度。
placeholder 用 muted-foreground，不得当 label 用。

#### Select

同 Input 外观 + 右侧 `chevron-down` 16px；菜单为 L3 浮层
（shadcn DropdownMenu/Select，禁手搓绝对定位）。选项行高 28px，
选中项左侧 `check` 图标 + brand 文字。

#### SearchBox 搜索框

工具栏内 200–280px，左侧 `search` 图标，支持拼音匹配；
`/` 聚焦快捷键；有值时右侧浮现清除 IconButton。

#### Checkbox / Radio / Switch

- Checkbox：14px 方圆角(4px)，选中 brand 实底白勾；多选场景。
- Radio：14px 圆，选中 brand 环 + 中心点；一次一个的互斥选择（≤5 项，
  更多用 Select）。
- Switch：28×16 胶囊，开=brand，关=`--input`；**即时生效**的开关
  （不需要保存按钮的设置）。需要提交的表单里用 Checkbox 不用 Switch。

#### FilterChip 筛选片

工具栏内的可开合筛选：`chip` 外形，激活时 brand 12% 底 + brand 文字 +
右侧计数；点击开 Popover 选择器。已应用筛选常显，未应用收进"筛选"入口。

#### 表单布局

- label 在上（12px/500），控件在下，说明文字 12/muted 再下；错误替换说明行。
- 双列栅格仅用于短字段（日期/数字）；长文本字段独占整行。
- 提交行右对齐：`[取消(ghost)] [提交(primary)]`；破坏确认按钮右置 danger。
- 校验在 blur 与提交时；不在输入中途打断。

#### Composer 提示词输入（AgentComposerFrame 语汇）

一切 prompt 输入使用共享 composer 栈（`AgentComposerFrame` /
`PromptComposer` / `TiptapComposer`，框架红线）。视觉解剖：
L2 卡片容器 = 多行 textarea（min 2 行，自动增高）+ 底部工具行
（左：上下文 chips（项目/分支/模板），右：快捷模板 chips + 麦克风 +
发送按钮）；`⌘Enter` 发送、Enter 换行；IME 组合中不提交。

### 4.3 展示类

#### Badge 徽标

`--radius-sm` 圆角，11px/500，语义底色 12–16% + 语义前景色。变体：
`b-success / b-warning / b-info / b-destructive / b-agent / b-brand /
b-evidence / b-muted`。徽标是**名词**（状态、类型、模型名），不可点击的
用 Badge，可点击/可删除的用 Chip。同一行徽标 ≤3 个，多余收进 `+N`。

#### Chip 片

999px 胶囊，`--card` 底 + `--border` 边，可含 16px 图标/头像/关闭钮；
用于筛选、上下文引用、快捷模板、可移除标签。

#### kbd 键位

mono 10px，`--muted` 底 + 底边 2px 的按键拟物；只用于真实快捷键提示。

#### RunBadge 运行徽标

工作项↔运行的关联徽标：`[StatusRing] run-id(mono 截断) [耗时?]`，
chip 外形；点击深链 orchestrator 运行详情。运行中的 RunBadge 状态环呼吸。

#### StatusPill 状态胶囊

页头/卡头的当前状态总结：`[StatusRing] 状态文案`，语义色 10% 底胶囊。
与 Badge 的区别：StatusPill 是对象的**主状态**（一处一个），Badge 是
附加属性（可多个）。

#### ActorAvatar / 在线点

见 §3.4。堆叠头像（AvatarStack）最多露 3 个 + `+N`，重叠 6px，白描边。

#### KpiCard 指标卡 / MetricRow 指标行

- KpiCard：L2 卡片，`分组眉题 + mono 大数字(20/600) + 环比小字`；
  一行 3–5 张；点击下钻到明细列表。
- MetricRow：面板内的紧凑指标行 `label … mono 值`，用于检查器/侧栏。

#### GoalCard Goal 卡

Sprint 驾驶舱顶部的完成判据卡：L2 卡片 = Goal 语句（13/600）+ M 编号
指标列表（每行：`M1` mono 徽标 + 指标语句 + 实测值/状态 Badge）+
底部推进按钮（"推进到 verifying · 判据 2/5"）。指标状态：
待测=muted、达标=success、未达=destructive、进行中=info。

#### ContextGauge 上下文量表

Brain 控制台的上下文占用：横向条（`--muted` 轨 + brand 填充 + mono
百分比），>80% 填充转 warning，>95% 转 destructive；旁附模型徽标与
窗口大小 mono 小字。

#### Card / Panel

见 §2.2 表面层级。卡片 = `--card` 底 + 1px `--border` + `--radius` +
14–16px 内边距；卡头 = `section-title`（13/600 + 可选图标）+ 右侧动作区；
**卡片内部分组用 `divider` + `group-label`，禁止嵌套第二层完整卡片**。

#### Table 表格（table.fd）

表头 = 分组眉题样式（10.5 uppercase muted）+ 底边线；行高 36–40px，
行 hover 2–3% 前景色 tint；数字列右对齐 mono；行操作 hover 浮现
（原地替换次要列，不新增空间）。空表显示 EmptyState 不显示表头骨架。

#### ListGrid 列表

Linear 式虚拟化列表（行高 56–64px，双行主格局：首行=标题+关键徽标，
次行=次要元信息）；hover 浮现行内 checkbox 与行操作；多选出现
**居中批量操作浮条**（L3 浮层）；空/错/无匹配三态分别有专门文案与 CTA；
搜索支持拼音。

#### BoardColumn / BoardCard 看板

- 列：`--panel` 底轨道；列头 = StatusRing + 名称 + mono 计数 + 加号
  IconButton；列体卡片间距 8px。
- 卡：L2 卡片 = 首行（类型徽标 + PriorityBars + key mono）+ 标题（13，
  两行截断）+ 标签 chips + 底部行（mini-step 阶段微条 + ActorAvatar +
  RunBadge/运行信号）。选中 = brand 描边 + 2% tint（**不用左侧色条**）。
  拖拽中冻结本地副本，drop 后乐观更新+失败回滚，目标列显示 drop-hint 虚线槽。

#### PropRow + InlinePicker / InspectorPanel 检查器

- InspectorPanel：320px 右栏，`--panel` 表面（窄屏变 Sheet side=right），
  承载 PropRow 组，分组间 `group-label` + `divider`。
- PropRow：`label(12/muted 固定 88px) 值(13)`，可编辑行 hover 现编辑态，
  点击即开 InlinePicker（L3 Popover 选择器），选择即乐观提交；失败只回滚
  该字段并 toast。

#### EmptyState 空态

垂直居中：40px 圆形 `--muted` 底图标 + 一句话说明（13/muted）+
一个 CTA（outline 按钮）。空态文案说"接下来做什么"，不说"没有数据"。

#### Skeleton / Progress / Spinner

- Skeleton：`--muted` 底 + shimmer 扫光，形状贴近真实内容（行/卡/头像）；
  仅首屏加载用，局部刷新用原位数据不闪骨架。
- Progress：2–4px 圆角条，brand 填充；顶部路由进度条 2px。
- Spinner：14px 环形，仅按钮内 loading 与小区域用；**全屏 spinner 禁止**
  （用骨架或乐观 UI）。

### 4.4 反馈类

#### Dialog / AlertDialog

L3 浮层，宽 400–480px（表单 560px），`--radius-xl`；结构 = 标题(15/600) +
正文 + 右对齐动作行。AlertDialog 用于确认：破坏动作红按钮 + 明确后果
描述，必要时输入名称确认。**禁浏览器 alert/confirm/prompt。**

#### Drawer / Sheet

右侧滑出 400–520px，用于"查看详情但不离开列表"（工作项速览、节点检查器
窄屏形态）；内衬 `--panel`，头部同 Dialog。

#### Popover / Tooltip

- Popover：L3 小浮层，承载 InlinePicker、筛选器、日期选择。
- Tooltip：max 260px，深底白字（dark 反转），仅一句话；IconButton 必配；
  延迟 300ms，不遮挡指针路径。

#### Toast

右下角堆叠，L3 卡片 = 语义图标 + 一句话 + 可选动作链接；4s 自动消失，
错误 toast 常驻带关闭钮。**变更类操作的成功确认优先用原位状态更新，
toast 只兜底异步/跨页结果。**

#### CapabilityBanner 能力横幅

无权限/不可用时的解释横幅（`--muted` 底，不用红），控件降级只读而非隐藏；
文案给出获取权限的路径。

### 4.5 流程与证据类

#### GateBanner 签核卡

审批门的标准呈现：L2 卡片 = 门名称 + 判据 checklist（逐条：通过=success
勾环，缺失=destructive 叉环 + 缺失原因文字）+ 请求人/时间 +
`批准`（brand）`驳回`（outline，驳回必填理由）。判据未齐时批准按钮
disabled 并解释缺什么。签核失效（锚定产物出新版本）时卡片转 warning
底 + "重确认"动作。

#### EvidenceCard 证据卡

证据的标准呈现：类型图标（PR/文件/运行输出/截图/absence-of）、
`--evidence` 青色类型徽标、mono 引用（`repo:file:line`、`PR #12`）、
一键打开原文。任何"完成/通过"徽标点开都必须落到 EvidenceCard。

#### TimelineCollapse 过程时间线

运行过程时间线（multica buildTimeline 范式）：中间过程折叠为 `N 步`
Collapsible（collapse-head 显示步数与耗时），行内 ToolCallRow
（工具名+智能摘要，展开看入参）/ ToolResultRow（120 字预览，展开看全文）/
ThinkingRow / ErrorRow；**最终结论在折叠外全尺寸展示**；底部
"耗时 · 复制全文"。密钥经统一 redact 后才渲染。

#### ArtifactCard / VersionChain 产物卡

产物卡：docKey 徽标（mono）、版本号、human/agent 行为者徽标、
supersedes 链；版本链视图支持任意两版 diff。产物行（art-row）紧凑形态
用于驾驶舱侧栏。

#### AttemptRow 尝试行

节点的多次尝试呈现：`attempt N` mono + StatusRing + 失败原因
（errorClass 徽标）+ 耗时；当前尝试高亮，历史尝试 muted。点击切换
检查器到该次尝试的转录。

#### InterviewCard 访谈卡

规划技能的"一次一问"UI 化：问题文本（13/600）+ **推荐答案 chip
（`sparkles` 图标 + brand tint，预填可改）** + 备选 chips（圆图标 +
outline）+ 自由输入；已回答的问题折叠为"问题→答案"摘要行，可回溯改答。

#### StepsRail 步骤轨

规划工作台左轨：垂直步骤列表（StatusRing + 步骤名 + 状态小字），
当前步 brand tint 底；`--panel` 表面。

#### ThreadRail / Transcript 线程轨与转录

- ThreadRail：`--panel` 左轨，线程行 = 状态点 + 标题(截断) + 时间 mono；
  活跃线程 brand tint。
- Transcript：用户消息右对齐 brand 10% 底胶囊卡；assistant 消息左对齐
  无底色，工具步骤折叠为 steps-group（TimelineCollapse 微缩形态）。

### 4.6 DAG 可视化

#### DagCanvas / DagNodeCard

分层有向图（dagre 式布局），节点 = 200px 宽 L2 卡片：

| 节点类型         | 图标                          | 视觉编码                                                     |
| ---------------- | ----------------------------- | ------------------------------------------------------------ |
| agent            | `cpu`（vllm）/`robot`（cc）   | 行1=图标+名+StatusRing；行2=引擎徽标(b-agent)+模型徽标(mono) |
| action（确定性） | `list-check`                  | 行2=`b-evidence 确定性` 徽标，无模型徽标                     |
| gate 签核门      | `shield-check`/`rubber-stamp` | warning 描边常态，通过后转常规                               |
| human 人工门     | `hand-stop`                   | warning 描边 + ActorAvatar(人)                               |
| fanout 扇出      | `cpu` + 叠片                  | 叠片卡效果 + `×N` mono 徽标                                  |

- 状态：pending=muted 边；running=info 边 + border-beam 光带；done=success
  边 2%tint；failed=destructive 边 + 错误行；selected=brand 2px 描边
  （与状态描边叠加时外扩 2px）。
- 边：正交折线（真实渲染依赖边），流转中的边虚线流动动画；边标签
  （`{{deps.x.output}}` 载荷名）mono 11 悬浮于折点。
- loop 以环形回边 + 迭代计数徽标表示。
- 画布：缩放/平移/小地图（DagMiniMap 64px 高微缩条，同一布局算法，
  也用于列表行内）；点击节点开 NodeInspector（右栏 `--panel`，
  tabs=转录/入参/产物/尝试）。

### 4.7 导航与外壳

#### 应用外壳

两个应用共用同一外壳形制（multica inset sidebar 范式）：

```
┌─ Sidebar(232px, 可折叠) ─┬────────── SidebarInset ───────────────┐
│ 应用切换/OrgSwitcher      │ NavigationProgress(2px)                │
│ ⌘K 搜索触发               │ ┌─ PageHeader ─────────────────────┐ │
│ 主导航（分组眉题）          │ │ 图标+标题+mono计数+说明+主操作     │ │
│ …                        │ └──────────────────────────────────┘ │
│ 动态区（项目/线程）         │ Toolbar（筛选/搜索/视图切换/列显隐）    │
│ ──────────────           │ 内容区（ListGrid/Board/详情两栏…）      │
│ Team/设置/主题             │                                       │
└──────────────────────────┴───────────────────────────────────────┘
```

- Sidebar：`--sidebar` 表面；导航项 28px 行高，激活 = brand 12% 底 +
  brand 文字与图标（**不用左侧竖条**）；分组眉题 group-label；
  计数 mono 右置，徽标数用 dot-badge（brand 胶囊）。
- PageHeader：30px 图标位 + h1(16/600) + mono 计数 + 说明 + 右侧动作区。
- Toolbar：页头下 1px 线以上，装 FilterChip / SearchBox / SegmentedControl /
  列显隐；高 40px。
- Breadcrumb：`上级 / 当前`，13px，上级 muted 可点，仅两级（更深层级
  靠侧栏与 ⌘K，不堆面包屑）。
- 详情页统一**两栏**：内容(自适应) + InspectorPanel(320px)；可拖分栏且
  宽度持久化。
- 全应用 agent 侧栏（agent-native 框架侧栏）保持在最右，与业务 UI 并存；
  业务页面的"问一下"入口一律唤起框架侧栏而非自建聊天框。

## 5. 组件 ↔ 场景对照表

| 界面                | 主要组件                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| 看板（s1）          | BoardColumn/BoardCard、mini-step、PriorityBars、RunBadge、FilterChip、SegmentedControl、Toast      |
| 规划工作台（s2）    | StepsRail、InterviewCard、Composer、ArtifactCard、GateBanner(签核行)、quality 徽标                 |
| UI 评审（s3）       | 嵌入 design 应用 + GateBanner、EvidenceCard                                                        |
| 工作项（s4）        | StageStepper、PropRow/InspectorPanel、TimelineCollapse、EvidenceCard、RunBadge、AttemptRow         |
| 收件箱（s5）        | ListGrid、GateBanner、escalation 卡（GateBanner 变体）、TabBarUnderline                            |
| Sprint 驾驶舱（s6） | GoalCard、miniboard(BoardCard 微缩)、phase-bar(StageStepper 变体)、ArtifactCard、gate-row、KpiCard |
| 运行详情（s7）      | DagCanvas/DagNodeCard、NodeInspector、AttemptRow、TimelineCollapse、RunBadge、StatusPill           |
| 工作流库（s8）      | Card 网格、Badge(模板域)、DagMiniMap、Table                                                        |
| Brain 控制台（s9）  | ThreadRail、Transcript、ContextGauge、Composer、MetricRow、StatusPill、engine chip                 |
| 健康与洞察（s10）   | KpiCard、hdot、Table、图表（chart-1..5）、CapabilityBanner                                         |

## 6. 禁则（全局红线）

1. **禁止在卡片/行左侧使用竖向强调色条**（failed 卡、选中行、证据卡一律
   不用 left-border accent）；状态与选中改用低饱和底色 tint + 描边 +
   状态环表达。
2. **禁止卡片嵌套卡片**：一个完整卡片（圆角+边框+背景三者齐备）内部
   不得再出现另一个完整卡片。卡内分组用 `divider` + `group-label` 的
   扁平分组；确需强调的内嵌块最多用 `--muted`/`--panel` 单一底色**或**
   单一边线，不得三者齐备形成第二层卡。侧栏/检查器（L1 面板）上放 L2
   卡片不算嵌套；L2 卡内再放卡才是违例。
3. 次级面板（列表栏、检查器、线程轨、会话轨）必须使用 `--panel` 表面色
   与内容区分层，不允许与页面背景同色仅靠 1px 分隔线。
4. **禁止 emoji 与文字符号（＋ ↗ ✓ → 等）充当图标**——包括原型、设计稿、
   演示数据；一律 Tabler Icons。
5. 禁止硬编码颜色；一律语义 token + `color-mix` 透明度形式。
6. 弹出层（菜单/选择器/确认/抽屉）一律用标准组件（shadcn 基元），
   禁止手搓绝对定位 + click-outside。禁浏览器 alert/confirm/prompt。
7. 除 L3 浮层外禁止阴影分层；卡片靠 border。
8. 全屏 loading spinner 禁止；用骨架屏或乐观 UI。
9. prompt 输入必须走共享 composer 栈，禁自建聊天输入框。
10. 动效必须带 `prefers-reduced-motion` 降级；静态数据不加动效。

## 7. 在 design 应用中的落地

### 7.1 设计系统实体

design 应用中创建设计系统 **Foundry**（`create-design-system`）：

```json
{
  "colors": {
    "primary": "#1c1c22",
    "secondary": "#52525b",
    "accent": "#2f6fde",
    "background": "#ffffff",
    "surface": "#f7f7f8",
    "text": "#18181b",
    "textMuted": "#71717a"
  },
  "typography": {
    "headingFont": "Inter",
    "bodyFont": "Inter",
    "headingWeight": "600",
    "bodyWeight": "400",
    "headingSizes": { "h1": "20px", "h2": "16px", "h3": "13px" }
  },
  "spacing": { "pagePadding": "24px", "elementGap": "16px" },
  "borders": { "radius": "10px", "accentWidth": "2px" },
  "defaults": { "background": "#f7f7f8", "labelStyle": "uppercase-tiny" }
}
```

（DesignSystemData 的 colors 是 hex 简化档；OKLCH 全量 token 放
`customCSS` 字段，即 2.1 节 CSS 原文，另加 `.fd-*` 工具类。）
`customInstructions` 写明：Tabler webfont、密度规范、状态环用法、
**禁 emoji/符号图标**、**禁卡中卡**、屏间导航只用 `data-screen`。

### 7.2 原型文件惯例

- 每个 sprint / 每个模块一个 design（`projectType: prototype`），
  多屏 = 多个自包含 HTML 文件；屏间跳转一律 `data-screen="xxx.html"`。
- 每屏 `<head>`：Tailwind v4 CDN + Alpine.js CDN + Tabler webfont CSS +
  Google Fonts(Inter/JetBrains Mono)；`:root` 内联 2.1 节 tokens
  （由设计系统烘焙，不引用外部 css 文件）。
- 原型按真实密度绘制（真实文案、真实数据形态、mono 数字），不用
  lorem ipsum；空态/失败态各出一屏或一个可切换状态。
- 组件用法拿不准时，以 `foundry-components.html` 对应小节为准。
