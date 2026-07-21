# 05 · UI 设计子流程与 Design / Content 协作

> 本章补上 SDLC 的最薄弱环节：从 sprint-plan（what/why）到
> sprint-design（where/how）之间的"用户会看到什么"。同时定义 design 与
> content 两个应用在流水线中的正式角色，以及跨应用 A2A 全景。

## 1. UI 设计子流程总览

```
sprint-doc(已签核)
   │  In Scope 标注 ui 面 → 激活 UI track
   ▼
/ui-spec 技能访谈（tracker 规划工作台 ④ 步）
   │  产物 ui-spec v1（human 主导定稿）
   ▼
sdlc-ui-build 工作流（orchestrator，02 §3.5）
   │  Foundry 设计系统 + 屏并行生成 + lint + 一致性评审
   ▼
design 应用：sprint 原型（一个 design，多屏，链接 Foundry）
   │  产物 ui-prototype（contentRef=design:<id>）
   ▼
UI 评审（tracker 工作台内嵌 present iframe + 锚点批注）
   │  批注 → ui-spec 修订 → 定点重生成（回环）
   ▼
ui-signoff 签核 → technical-design/test-plan/briefs 引用屏编号与深链
```

## 2. `/ui-spec` 技能与产物 schema

访谈流（InterviewCard，一次一问带推荐答案）：

1. 从 sprint-doc 的 In Scope 逐条确认"这条 outcome 用户在哪里看到？"
   （已有屏 / 新屏 / 无界面）——保证覆盖完整性；
2. 屏清单定稿（每屏：名称、一句话目标、入口）；
3. 逐屏访谈：主操作与次操作 / 关键信息与密度 / 数据状态
   （空/加载/错误/正常四态哪些需要专门设计）/ 复用哪些 Foundry 组件；
4. 屏间流程（谁跳到谁，data-screen 图）；
5. 非目标（明确不做的界面改动）。

产物 `ui-spec` 结构（markdown，机器可解析节，Ajv 校验其 front 区块）：

```
# UI Spec: Sprint {N}
## 屏清单            | # | 屏名 | 目标 | 入口 | 关联 outcome |
## Screen S1: {屏名}
   **目标** / **主操作** / **布局区域**（区域→内容→组件映射表）
   **数据状态**：空态文案 / 加载 / 错误 / 正常
   **组件**：Foundry 组件名列表（不存在的组件→标注"新组件"并给解剖）
   **验收信号**：本屏的可证伪信号（供 test-plan 引用）
## 流程图            （屏间跳转：S1 →(主操作)→ S2 …）
## 非目标
```

质量门：每条 ui 面 outcome 至少映射一屏或显式"无界面"；每屏必有
主操作与验收信号；新组件必须给解剖描述。

## 3. UI 评审交互（tracker 规划工作台 ④ 步评审模式）

```
┌ 屏导航条：S1 S2 S3 …（每屏状态环+批注数徽标）      [请求修改] [发起 ui-signoff] ┐
├──────────────────────────────────────┬─────────────────────────────────────────┤
│ 内嵌 design 应用 Present 视图          │ 批注列表（右栏 360px，--panel 表面）      │
│ （iframe 顶部带来源条：Design 标识 +   │  · 批注卡：锚定屏+区域缩略 + 批注文本      │
│  design id/屏文件名 + "Present 只读    │                                          │
│  嵌入"徽标；tracker 不复制原型，       │                                          │
│  只叠加批注层，屏切换与导航条双向同步） │                                          │
│  · 点按"批注模式"后在画布上框选区域    │    + 状态（open/resolved）+ 作者          │
│    即建锚点批注                       │  · 按屏分组；open 计数入屏导航条           │
│  · 底部：设备宽度切换（桌面/窄屏）     │  · resolve 需附说明（改了什么/为何不改）   │
└──────────────────────────────────────┴─────────────────────────────────────────┘
```

- `请求修改`：把 open 批注集打包 → 会话区驱动 `/ui-spec` 修订
  （supersedes 新版本）→ 一键触发 sdlc-ui-build **定点重生成**
  （仅受影响屏，inputs 带批注上下文）。
- `发起 ui-signoff`：GateBanner 判据 = 全部批注 resolved + 屏清单与
  ui-spec 一致（lint 通过）+ 每屏验收信号存在。批准后原型版本被
  **冻结引用**（design 侧打 version 快照，防评审后漂移）。
- 深链互通：design 应用中该 design 的页头显示"属于 tracker Sprint {N}"
  回链徽标（经 tags/描述约定）。

## 4. design 应用的 SDLC 角色约定

不改 design 应用结构，按现有实体建立使用惯例：

| 实体               | 惯例                                                                                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设计系统 Foundry   | 全局唯一、isDefault；tokens/customCSS/customInstructions 按 01 章 §6；由设计文档驱动更新（人审后 update-design-system）                                                                                                                 |
| sprint 原型 design | 每 sprint 一个 design：`Sprint {N} · {sprint 名}`；描述里写 tracker 深链与 sprint id；designSystemId=Foundry                                                                                                                            |
| 屏文件             | 每屏一个自包含 HTML（tokens 内联 :root，Tabler webfont，data-screen 互链）；命名 `s{序号}-{语义}.html`，入口屏 `index.html`                                                                                                             |
| 版本               | ui-signoff 时打 designVersions 快照（label=`ui-signoff v{spec 版本}`）                                                                                                                                                                  |
| 生成方式           | 一律 create-design + create-file / update-file（**不用 generate-design 的 AI 生成路径**，与既有运维红线一致）；sdlc-ui-build 的 publish 节点即走此路径                                                                                  |
| 交接               | **登记的 design 增量**：get-design-snapshot 新增 `summaryOnly` 参数（返回屏/区域/组件/token 引用的结构化摘要）——默认行为不变（design 自身精修回路依赖返回源码）；SDLC 工人调用侧强制 summaryOnly，源码档需显式参数且计入载荷审计（P11） |

## 5. content：项目文档库（文档的家）

content 不只是交付文档的落点——它是**全部流程文档的家**。tracker 管登记
（版本、签核判据、门），content 管正文与呈现（人真正阅读与审查的地方）。

测试计划等富呈现由 content 应用**真实渲染**（本节的文件夹规范 + block 映射
即是生成规格），不需要原型屏；活体示例见 content 组织页
`/content/page/fXZdnHZ9AT2a`。

### 5.1 双表征机制（P11 的落地）

每份产物同源两个视图，方向永远是"纯文本 → 富呈现"：

```
技能/工作流产出（结构化纯文本，schema 可校验）
  │
  ├─▶ tracker_sprint_artifacts        ← agent 视图（唯一被 agent 读的版本）
  │     版本化 · producedByKind · 签核判据锚定此版本
  │
  └─▶ publish-artifact-to-content     ← 确定性发布管道（action）
        按 §5.3 的 block 映射渲染成 content 富文档，放入 §5.2 的规范位置
        tracker artifact.contentRef = content:<documentId>
        content 页头回链 tracker sprint
```

- **agent 永远不读富 block 源码**（`<table>`/`<Mermaid>` 标记对 agent 是
  上下文污染）；派发载荷、评审输入一律取 tracker 纯文本版。
- 人在 content（或工作台内嵌的 content 页）审查；批注/评论用 content 的
  内联评论，回流为修订意见。
- 人工直接改 content 富文档的场景（低摩擦通道）：`pull-document` 纯文本化
  后回写 tracker 新版本（producedByKind=human）。**逆向映射有闸**：回写前
  按 §5.3 映射**剥离发布管道注入的呈现块**（覆盖矩阵、旅程图、三问卡），
  再跑该 docKey 的产物 schema 校验——失败拒绝回写并提示到 tracker 侧编辑，
  保证壳内容永不回流进 agent 视图（P11）。

### 5.2 文件夹规范（组织可见，agent 建档必须入位）

```
SDLC 项目文档库/                       ← org 根文件夹
  <项目名>/                            ← 每项目一夹（如 支付中心）
    项目档案                           ← 仓库/命令/门配置摘要 + tracker 项目深链
    Sprint <N> · <名称>/               ← 每 sprint 一夹
      sprint-doc · Sprint <N>          ← Goal/In-Scope/指标（Goal 用 callout 置顶）
      test-plan · Sprint <N>           ← 场景卡片化富呈现（§5.3）
      ui-spec · Sprint <N>             ← 屏规格 + design 原型深链
      technical-design · Sprint <N>         ← Mermaid/DataModel/文件矩阵富呈现
      briefs · Sprint <N>/             ← 子夹
        shared-brief
        brief · <ITEM-KEY> …           ← 刻意保持纯文本（agent 的口粮）
      verify-report · Sprint <N>       ← GREEN/RED 场景表 + 证据
      audit-report · Sprint <N> · 第<n>轮
      story · Sprint <N> / recap · Sprint <N>
      brainstorm-notes · Sprint <N>    ← 可选（走了头脑风暴才有）
    spike-report · <调研名>            ← 调研产物，项目层
```

命名 = `docKey · Sprint N`；position 按上表固定顺序；agent 每产出一份产物
必须放到对应位置（发布管道自动定位，找不到夹则按规范补建）。

### 5.3 block 呈现映射（每类文档怎么"给人看"）

| docKey           | 富呈现（human 版用的 block）                                                                                                                                                                                                                   | 要点                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| sprint-doc       | Goal 置顶 blue callout + 指标表（Leading/Lagging 列）+ In/Out Scope 双栏 columns                                                                                                                                                               | Goal 是完成判据的锚，必须一眼看到                                                                                         |
| test-plan        | **覆盖矩阵置顶**（Goal 指标 × 场景，未覆盖=红标）+ 用户旅程 Mermaid（场景标注在路径上）+ 场景按 P0/边缘分层（P0 展开、边缘折叠）+ 每场景**审查三问**（信号可证伪吗 / 前置真实非种子吗 / 工具真能执行吗，逐问勾选、异议入口）+ 步骤细节默认折叠 | 审查的本质是回答"盖住了吗、测在刀刃上吗、能证伪吗"——版面围绕这三问组织，勾选状态回流为 plan-signoff 的 test-plan 判据输入 |
| ui-spec          | 屏清单表 + 每屏 toggle（区域表 + 验收信号）+ design 原型深链                                                                                                                                                                                   | 与原型对照走查                                                                                                            |
| technical-design | 架构 Mermaid + DataModel block（数据模型）+ §7 文件矩阵表 + 关键变更 Diff block + §4 每项 toggle                                                                                                                                               | 图优先于散文                                                                                                              |
| briefs           | **纯文本**（标题+要点+文件清单表最多）                                                                                                                                                                                                         | 刻意不加富呈现——它是 agent 的输入，人只抽查                                                                               |
| verify-report    | 场景结果表（行色 green_bg/red_bg）+ 失败证据 callout + 真实输出代码块                                                                                                                                                                          | 证据即打开                                                                                                                |
| audit-report     | 指标×verdict 表（MET/PARTIAL/UNMET 行色）+ 证据引用 mono + blocking red callout                                                                                                                                                                | 反奉承可视化                                                                                                              |
| story            | Do/Why/What-you'll-see 三列表 + 截图                                                                                                                                                                                                           | 新手实走                                                                                                                  |
| recap            | 人工介入时间线表                                                                                                                                                                                                                               | 度量人花在哪                                                                                                              |
| brainstorm-notes | 要点列表 + Parked Ideas 表                                                                                                                                                                                                                     | 可选产物                                                                                                                  |
| spike-report     | 结论 callout + 选项对比表 + 证据引用                                                                                                                                                                                                           | 调研即交付物                                                                                                              |

### 5.4 交付文档（原有职责，纳入同一结构）

| 文档                 | 来源                                            | 时机                                                  |
| -------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| Sprint Story         | `/sprint-story` 技能（实走验证 + 真实验证日志） | storytelling 相位；主打能力未实证→accept-defer 裁决卡 |
| 发布说明 / Changelog | promote 完成后由 docs-task 工作流汇总           | done 相位                                             |
| 验收报告归档         | verify-report / audit-report 的人类可读版       | verifying/auditing 终局                               |
| 产品知识             | 设计文档、复盘沉淀                              | 随需                                                  |

写入一律走 create-document / edit-document（NFM 规范见《content 富文本
写作指南》）。**登记的框架/content 增量：`resetCollabState` action**
（deleteCollabState 的 action 化，现无调用面）——发布管道整文重写的标准
序列是：pull-document flush 握手（有活跃编辑会话先落盘）→ update-document
→ resetCollabState；正在打开该页的编辑器由 updatedAt 信号触发重载。
没有这一步，在线 Yjs 会话会把重写覆盖回旧内容（已实证的故障模式）。

## 6. 跨应用 A2A 全景

```
tracker ──MCP(JSON-RPC + A2A_SECRET JWT)──▶ orchestrator
  · brain-send（派发：brief 全文 + repo/baseBranch + tags 身份）
  · workflowRun（sdlc-ui-build / docs-task 直发）
  · runCancel / nodeResolveGate（回退保护与签核解锁）
  · 读：brain_tasks / runsList / v3RunNodes / spawnList（get-activity 兜底轮询）

orchestrator ──tracker-client(A2A/HTTP + JWT, 身份取 run tags)──▶ tracker
  · advance-stage（幂等回写）
  · create-work-item（from-audit 单）
  · create-artifact（verify/audit 报告、测试证据）

orchestrator(sdlc-ui-build publish 节点) ──A2A──▶ design
  · create-design / create-file / update-file（原型入库）
  · get-design-snapshot（实施阶段只读交接）

orchestrator(docs-task publish 节点) ──A2A──▶ content
  · create-document / edit-document（story/changelog/报告）

tracker(规划技能) ──MCP──▶ orchestrator
  · workspaceCreate(readOnly) + workspaceFiles/Read（/sprint-design 深读真实代码）
  · spawnOnce（/sprint-review 的 vLLM/sonnet 对抗评审轮）

tracker(publish-artifact-to-content 发布管道) ──A2A──▶ content
  · 每份产物定稿即渲染 human 版入项目文档库（§5.2 位置 + §5.3 映射）
  · contentRef 回填，content 页头回链 tracker sprint

tracker UI ──deep link──▶ orchestrator(/runs/:id) · design(/design/:id present)
  · content(/page/:id)；反向徽标回链 tracker
```

身份与红线（全链一致）：JWT 带 sub+org_id；载荷白名单
（brief/shared-brief/ui-spec 摘要，禁 sprint-doc/technical-design 全文）；
跨应用传 id + 有界摘要，不传大 HTML/大 diff 过 prompt。

## 7. 附录 · 原型清单（prototypes/）

全部原型（11 屏）入 design 应用 `SDLC 产品设计 v2.2` design（Foundry 设计系统），
同时在仓库 `docs/sdlc-product-design/prototypes/` 保留源文件。

| #   | 文件                     | 屏                                        | 对应章节  |
| --- | ------------------------ | ----------------------------------------- | --------- |
| 0   | index.html               | 总览导航（原型地图 + 设计原则速览）       | 00        |
| 1   | s1-tracker-board.html    | 看板（含运行信号卡、拖拽门提示态）        | 03 §3     |
| 2   | s2-sprint-studio.html    | Sprint 规划工作台（③ 测试计划步进行中态） | 03 §6     |
| 3   | s3-ui-review.html        | UI 评审模式（内嵌原型 + 批注）            | 05 §3     |
| 4   | s4-work-item.html        | 工作项详情（执行记录 + 失败路由态）       | 03 §4     |
| 5   | s5-inbox.html            | 收件箱（签核 GateBanner 详情态）          | 03 §2     |
| 6   | s6-sprint-cockpit.html   | Sprint 驾驶舱（executing 相位面板）       | 03 §5     |
| 7   | s7-run-detail.html       | 运行详情（DagCanvas + NodeInspector）     | 04 §3     |
| 8   | s8-workflow-library.html | 工作流库 + 模板详情版本链                 | 04 §4     |
| 9   | s9-brain-console.html    | Brain 控制台（引擎徽标 + 纪律指标）       | 04 §6     |
| 10  | s10-health-insights.html | 健康页 + 洞察归因（双段滚动）             | 04 §10/11 |

content 侧的富呈现（test-plan 审查面、文档树、回链 tracker）不做原型屏：
这是 content 应用的既有渲染能力，由 agent 按 §5 的文件夹规范与 block 映射
生成真实文档即可，活体示例见 content 组织页 `/content/page/fXZdnHZ9AT2a`。

原型规范：真实数据形态（PAY-xxx key、mono 数字、真实中文文案）、
空/失败态至少各一处内嵌呈现、Tabler 图标、屏间 data-screen 互链、
`:root` 内联 Foundry tokens、双主题（原型默认 light，右上主题切换）。
