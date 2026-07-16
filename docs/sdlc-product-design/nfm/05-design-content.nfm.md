<callout color="blue_bg">
	本章补上 SDLC 的最薄弱环节：从 sprint-plan（what/why）到 sprint-design（where/how）之间，"用户会看到什么"完全没有设计环节——原流程里视觉正确性只在末端被验证，从未被设计。本章定义 UI 设计子流程，并给 design 与 content 两个应用在流水线中的正式角色。
	核心逻辑三句话：原型唯一存放在 design 应用（每 sprint 一个设计、每屏一个文件）；tracker 不复制原型，只做编排与批注层；跨应用永远传 id 与有界摘要，不把大 HTML 或大 diff 塞进 prompt。
</callout>

## 1. UI 设计子流程总览

补位点在 plan 与 technical-design 之间：消费 sprint-doc 的 In Scope 与成功指标，产出可被技术设计、测试场景、briefs 引用的 ui-spec 与原型。这样实施阶段的 dev 工人拿到的不是"想象中的界面"，而是已签核的屏规格与原型深链。

<Mermaid id="wf05-ui-track" source={"flowchart TD\n  sd[sprint-doc 已签核 In Scope 标注 ui 面] --> us[ui-spec 技能访谈 human 定稿]\n  us --> ub[sdlc-ui-build 工作流]\n  ub --> dz[design 应用 sprint 原型 多屏]\n  dz --> rv[tracker 内嵌评审 锚点批注]\n  rv -->|批注打包 修订 spec 定点重生成| us\n  rv --> so[ui-signoff 冻结原型版本]\n  so --> td[technical-design 与 test-plan 与 briefs 引用屏编号与深链]"} />

## 2. `/ui-spec` 技能与产物 schema

访谈流（InterviewCard，一次一问带推荐答案）：

1. 从 sprint-doc 的 In Scope 逐条确认"这条 outcome 用户在哪里看到？"（已有屏、新屏、无界面）——保证覆盖完整性；
2. 屏清单定稿：每屏名称、一句话目标、入口；
3. 逐屏访谈：主操作与次操作、关键信息与密度、数据状态（空、加载、错误、正常四态哪些需要专门设计）、复用哪些 Foundry 组件；
4. 屏间流程：谁跳到谁，data-screen 关系图；
5. 非目标：明确不做的界面改动。

产物 ui-spec 的结构（markdown，机器可解析节，front 区块过 Ajv 校验）：

```text
# UI Spec: Sprint {N}
## 屏清单           表：编号 / 屏名 / 目标 / 入口 / 关联 outcome
## Screen S1: {屏名}
   目标 / 主操作 / 布局区域（区域 -> 内容 -> 组件映射表）
   数据状态：空态文案 / 加载 / 错误 / 正常
   组件：Foundry 组件名列表（不存在的组件标注"新组件"并给解剖）
   验收信号：本屏的可证伪信号（供 test-plan 引用）
## 流程图           屏间跳转：S1 -(主操作)-> S2 ...
## 非目标
```

<callout color="yellow_bg">
	质量门：每条 ui 面 outcome 至少映射到一屏、或显式声明"无界面"；每屏必有主操作与验收信号；新组件必须给解剖描述。验收信号直接被 test-plan 场景引用——测试计划由此锚定在"用户看到什么"，而不是代码路径。
</callout>

## 3. UI 评审交互（tracker 规划工作台第 4 步的评审模式）

```text
+ 屏导航条：S1 S2 S3 ...（每屏状态环+批注数徽标）    [请求修改] [发起 ui-signoff] +
+--------------------------------------+----------------------------------------+
| 内嵌 design 应用 Present 视图          | 批注列表（右栏 360px，--panel 表面）     |
| （iframe 顶部带来源条：Design 标识 +   |  - 批注卡：锚定屏+区域缩略 + 批注文本     |
|  design id/屏文件名 + "Present 只读   |    + 状态 open/resolved + 作者           |
|  嵌入"徽标）                          |  - 按屏分组；open 计数入屏导航条          |
|  - 点按"批注模式"后在画布上框选区域    |  - resolve 需附说明                      |
|    即建锚点批注                       |    （改了什么 / 为何不改）               |
|  - 底部：设备宽度切换（桌面/窄屏）     |                                        |
+--------------------------------------+----------------------------------------+
```

<callout color="yellow_bg">
	画布是 design 应用 Present 视图的内嵌 iframe——tracker 不复制原型，只在其上叠加批注层；屏切换与导航条双向同步。原型的唯一事实源永远是 design 应用。
</callout>

- 请求修改：把 open 批注集打包，会话区驱动 `/ui-spec` 修订（supersedes 出新版本），一键触发 sdlc-ui-build **定点重生成**——只重生成受影响的屏，inputs 携带批注上下文。
- 发起 ui-signoff：GateBanner 判据齐备才可批——全部批注 resolved、屏清单与 ui-spec 一致（lint 通过）、每屏验收信号存在。批准后原型版本被**冻结引用**：design 侧打 designVersions 快照，防止评审后漂移。
- 深链互通：design 应用中该设计的页头显示"属于 tracker Sprint N"回链徽标（经 tags 与描述约定）。

## 4. design 应用的 SDLC 角色约定

不改 design 应用结构，按现有实体建立使用惯例：

<table header-row="true">
<tr>
<td>实体</td>
<td>惯例</td>
</tr>
<tr>
<td>设计系统 Foundry</td>
<td>全局唯一、isDefault；tokens、customCSS、customInstructions 按 01 章；由设计文档驱动更新（人审后 update-design-system）</td>
</tr>
<tr>
<td>sprint 原型 design</td>
<td>每 sprint 一个 design，命名「Sprint N · sprint 名」；描述里写 tracker 深链与 sprint id；designSystemId 指向 Foundry</td>
</tr>
<tr>
<td>屏文件</td>
<td>每屏一个自包含 HTML（tokens 内联 :root、Tabler webfont、data-screen 互链）；命名 s 序号加语义，入口屏 index.html</td>
</tr>
<tr>
<td>版本</td>
<td>ui-signoff 时打 designVersions 快照，label 记 spec 版本</td>
</tr>
<tr>
<td>生成方式</td>
<td>一律 create-design 加 create-file 或 update-file（不用 generate-design 的 AI 生成路径，与既有运维红线一致）；sdlc-ui-build 的 publish 节点即走此路径</td>
</tr>
<tr>
<td>交接</td>
<td>**登记的 design 增量**：get-design-snapshot 新增 `summaryOnly` 参数（返回屏、区域、组件、token 引用的结构化摘要）——默认行为不变（design 自身精修回路依赖源码返回）；SDLC 工人调用侧强制 summaryOnly，源码档需显式参数且计入载荷审计（P11）</td>
</tr>
</table>

## 5. content：项目文档库（文档的家）

content 不只是交付文档的落点——它是**全部流程文档的家**。tracker 管登记（版本、签核判据、门），content 管正文与呈现（人真正阅读与审查的地方）。

测试计划等富呈现由 content 应用**真实渲染**（本节的文件夹规范加 block 映射即是生成规格），不需要原型屏；活体示例见 content 组织页 `/content/page/fXZdnHZ9AT2a`。

### 5.1 双表征机制（P11 的落地）

每份产物同源两个视图，方向永远是「纯文本到富呈现」：

```text
技能/工作流产出（结构化纯文本，schema 可校验）
  |
  +--> tracker_sprint_artifacts        <- agent 视图（唯一被 agent 读的版本）
  |      版本化 · producedByKind · 签核判据锚定此版本
  |
  +--> publish-artifact-to-content     <- 确定性发布管道（action）
         按 5.3 的 block 映射渲染成 content 富文档，放入 5.2 的规范位置
         tracker artifact.contentRef = content:<documentId>
         content 页头回链 tracker sprint
```

<callout color="red_bg">
	**agent 永远不读富 block 源码**——`<table>`、`<Mermaid>` 这类标记对 agent 是纯粹的上下文污染。派发载荷、评审输入一律取 tracker 纯文本版；富呈现只服务人的阅读与审查。
</callout>

人在 content（或工作台内嵌的 content 页）审查，批注用 content 内联评论，回流为修订意见。低摩擦通道：人也可以直接改 content 富文档，`pull-document` 纯文本化后回写 tracker 新版本（producedByKind=human）。**逆向映射有闸**：回写前按 5.3 映射剥离发布管道注入的呈现块（覆盖矩阵、旅程图、三问卡），再跑该 docKey 的产物 schema 校验——失败拒绝回写并提示到 tracker 侧编辑，保证壳内容永不回流进 agent 视图（P11）。

### 5.2 文件夹规范（组织可见，agent 建档必须入位）

```text
SDLC 项目文档库/                       <- org 根文件夹
  <项目名>/                            <- 每项目一夹（如 支付中心）
    项目档案                           <- 仓库/命令/门配置摘要 + tracker 项目深链
    Sprint <N> · <名称>/               <- 每 sprint 一夹
      sprint-doc · Sprint <N>          <- Goal/In-Scope/指标（Goal 用 callout 置顶）
      test-plan · Sprint <N>           <- 场景卡片化富呈现（5.3）
      ui-spec · Sprint <N>             <- 屏规格 + design 原型深链
      technical-design · Sprint <N>         <- Mermaid/DataModel/文件矩阵富呈现
      briefs · Sprint <N>/             <- 子夹
        shared-brief
        brief · <ITEM-KEY> ...         <- 刻意保持纯文本（agent 的口粮）
      verify-report · Sprint <N>       <- GREEN/RED 场景表 + 证据
      audit-report · Sprint <N> · 第<n>轮
      story · Sprint <N> / recap · Sprint <N>
      brainstorm-notes · Sprint <N>    <- 可选（走了头脑风暴才有）
    spike-report · <调研名>            <- 调研产物，项目层
```

命名 = `docKey · Sprint N`；position 按上表固定顺序；agent 每产出一份产物必须放到对应位置（发布管道自动定位，找不到夹则按规范补建）。组织下已建好该结构的活体骨架与各类文档的富呈现示例（《SDLC 项目文档库》），照着写即可。

### 5.3 block 呈现映射（每类文档怎么「给人看」）

<table header-row="true">
<tr>
<td>docKey</td>
<td>富呈现（human 版用的 block）</td>
<td>要点</td>
</tr>
<tr>
<td>sprint-doc</td>
<td>Goal 置顶 blue callout + 指标表（Leading/Lagging）+ In/Out Scope 双栏 columns</td>
<td>Goal 是完成判据的锚，必须一眼看到</td>
</tr>
<tr>
<td>test-plan</td>
<td>**覆盖矩阵置顶**（Goal 指标 × 场景，未覆盖红标）+ 用户旅程 Mermaid（场景标注在路径上）+ 场景按 P0/边缘分层（P0 展开、边缘折叠）+ 每场景**审查三问**（信号可证伪吗、前置真实非种子吗、工具真能执行吗——逐问勾选、异议入口）+ 步骤细节默认折叠</td>
<td>审查的本质是回答「盖住了吗、测在刀刃上吗、能证伪吗」——版面围绕三问组织；勾选状态回流为 plan-signoff 的 test-plan 判据输入</td>
</tr>
<tr>
<td>ui-spec</td>
<td>屏清单表 + 每屏 toggle（区域表 + 验收信号）+ design 原型深链</td>
<td>与原型对照走查</td>
</tr>
<tr>
<td>technical-design</td>
<td>架构 Mermaid + DataModel block + 文件矩阵表 + 关键变更 Diff block + 每工作项 toggle</td>
<td>图优先于散文</td>
</tr>
<tr>
<td>briefs</td>
<td>**纯文本**（标题、要点、文件清单表最多）</td>
<td>刻意不加富呈现——它是 agent 的输入，人只抽查</td>
</tr>
<tr>
<td>verify-report</td>
<td>场景结果表（行色 green_bg/red_bg）+ 失败证据 callout + 真实输出代码块</td>
<td>证据即打开</td>
</tr>
<tr>
<td>audit-report</td>
<td>指标与 verdict 表（MET/PARTIAL/UNMET 行色）+ 证据引用 mono + blocking red callout</td>
<td>反奉承可视化</td>
</tr>
<tr>
<td>story</td>
<td>Do/Why/What-you-see 三列表 + 截图</td>
<td>新手实走</td>
</tr>
<tr>
<td>recap</td>
<td>人工介入时间线表</td>
<td>度量人花在哪</td>
</tr>
<tr>
<td>brainstorm-notes</td>
<td>要点列表 + Parked Ideas 表</td>
<td>可选产物</td>
</tr>
<tr>
<td>spike-report</td>
<td>结论 callout + 选项对比表 + 证据引用</td>
<td>调研即交付物</td>
</tr>
</table>

### 5.4 交付文档（原有职责，纳入同一结构）

<table header-row="true">
<tr>
<td>文档</td>
<td>来源</td>
<td>时机</td>
</tr>
<tr>
<td>Sprint Story</td>
<td>`/sprint-story` 技能：新手视角实走验证，每步 Do、Why、What you will see，附真实验证日志</td>
<td>storytelling 相位；主打能力未实证时转 accept-defer 裁决卡</td>
</tr>
<tr>
<td>发布说明与 Changelog</td>
<td>promote 完成后由 docs-task 工作流汇总（工作项、PR、story 摘要）</td>
<td>done 相位</td>
</tr>
<tr>
<td>验收报告归档</td>
<td>verify-report 与 audit-report 的人类可读版</td>
<td>verifying 与 auditing 终局</td>
</tr>
<tr>
<td>产品知识</td>
<td>设计文档、复盘沉淀</td>
<td>随需</td>
</tr>
</table>

写入一律走 create-document 与 edit-document（NFM 规范见《content 富文本写作指南》）。**登记的框架/content 增量：`resetCollabState` action**（deleteCollabState 的 action 化，现无调用面）——发布管道整文重写的标准序列：pull-document flush 握手（有活跃编辑会话先落盘）、update-document、resetCollabState；在线编辑器由 updatedAt 信号触发重载。没有这一步，在线 Yjs 会话会把重写覆盖回旧内容（已实证的故障模式）。


## 6. 跨应用 A2A 全景

<Mermaid id="wf05-a2a" source={"flowchart LR\n  T[tracker 流程域] -->|MCP brain-send 派发 brief 与 tags 身份| O[orchestrator 执行域]\n  T -->|workflowRun 直发 ui-build 与 docs-task| O\n  O -->|回写:advance/建单/产物| T\n  O -->|create-design 与 create-file 原型入库| D[design UI 域]\n  O -->|create-document 交付文档| C[content 文档域]\n  T -->|publish 管道 产物富呈现入库| C\n  T -->|只读检出与 spawnOnce 规划技能用| O\n  T -.深链 评审嵌入.-> D\n  T -.深链 文档查看.-> C"} />

连接明细：

<table header-row="true">
<tr>
<td>方向</td>
<td>通道</td>
<td>调用</td>
</tr>
<tr>
<td>tracker 到 orchestrator</td>
<td>MCP JSON-RPC 加 A2A_SECRET JWT</td>
<td>`brainSend`（派发：brief 全文、repo、baseBranch、tags 身份）；workflowRun（sdlc-ui-build 与 docs-task 直发）；runCancel 与 nodeResolveGate（回退保护与签核解锁）；读观察 brain_tasks、runsList、v3RunNodes、spawnList（`getActivity` 兜底轮询）</td>
</tr>
<tr>
<td>orchestrator 到 tracker</td>
<td>tracker-client：A2A HTTP 加 JWT，身份取 run tags</td>
<td>advance-stage（幂等回写）；create-work-item（from-audit 单）；create-artifact（verify 与 audit 报告、测试证据）</td>
</tr>
<tr>
<td>orchestrator 到 design</td>
<td>A2A（sdlc-ui-build 的 publish 节点）</td>
<td>create-design、create-file、update-file（原型入库）；get-design-snapshot（实施阶段只读交接）</td>
</tr>
<tr>
<td>orchestrator 到 content</td>
<td>A2A（docs-task 的 publish 节点）</td>
<td>create-document、edit-document（story、changelog、报告）</td>
</tr>
<tr>
<td>tracker 到 content（publish-artifact-to-content 发布管道）</td>
<td>每份产物定稿即渲染 human 版入项目文档库（5.2 位置、5.3 映射）；contentRef 回填，content 页头回链 tracker sprint</td>
<td>A2A（确定性 action）</td>
</tr>
<tr>
<td>tracker UI 深链</td>
<td>deep link</td>
<td>orchestrator 运行详情、design Present 评审嵌入、content 文档页；反向徽标回链 tracker</td>
</tr>
</table>

<callout color="red_bg">
	身份与载荷红线（全链一致）：JWT 必须带 sub 与 org_id，回写据 run tags 铸身份，保证 ownable 数据落在正确组织；载荷白名单只有 brief、shared-brief、ui-spec 摘要，sprint-doc 与 technical-design 全文禁止注入；跨应用传 id 与有界摘要，不传大 HTML 与大 diff 过 prompt。
</callout>

## 7. 附录 · 原型清单

全部原型入 design 应用「SDLC 产品设计 v2.2 · Foundry 原型」（链接 Foundry 设计系统），仓库 docs/sdlc-product-design/prototypes/ 保留源文件。

<table header-row="true">
<tr>
<td>序号</td>
<td>文件</td>
<td>屏</td>
<td>对应章节</td>
</tr>
<tr>
<td>0</td>
<td>index.html</td>
<td>总览导航（原型地图加设计原则速览）</td>
<td>00</td>
</tr>
<tr>
<td>1</td>
<td>s1-tracker-board.html</td>
<td>看板（运行信号卡、拖拽门提示态）</td>
<td>03 章看板节</td>
</tr>
<tr>
<td>2</td>
<td>s2-sprint-studio.html</td>
<td>Sprint 规划工作台（测试计划步进行中态）</td>
<td>03 章工作台节</td>
</tr>
<tr>
<td>3</td>
<td>s3-ui-review.html</td>
<td>UI 评审模式（design Present 内嵌加批注）</td>
<td>05 章评审节</td>
</tr>
<tr>
<td>4</td>
<td>s4-work-item.html</td>
<td>工作项详情（执行记录、失败路由态）</td>
<td>03 章工作项节</td>
</tr>
<tr>
<td>5</td>
<td>s5-inbox.html</td>
<td>收件箱（签核 GateBanner 详情态）</td>
<td>03 章收件箱节</td>
</tr>
<tr>
<td>6</td>
<td>s6-sprint-cockpit.html</td>
<td>Sprint 驾驶舱（executing 相位面板）</td>
<td>03 章驾驶舱节</td>
</tr>
<tr>
<td>7</td>
<td>s7-run-detail.html</td>
<td>运行详情（DagCanvas 加 NodeInspector）</td>
<td>04 章运行详情节</td>
</tr>
<tr>
<td>8</td>
<td>s8-workflow-library.html</td>
<td>工作流库加模板版本链</td>
<td>04 章工作流库节</td>
</tr>
<tr>
<td>9</td>
<td>s9-brain-console.html</td>
<td>Brain 控制台（引擎徽标、纪律指标）</td>
<td>04 章 Brain 节</td>
</tr>
<tr>
<td>10</td>
<td>s10-health-insights.html</td>
<td>健康页加洞察归因</td>
<td>04 章健康与洞察节</td>
</tr>
</table>

content 侧的富呈现（test-plan 审查面、文档树、回链 tracker）不做原型屏：这是 content 应用的既有渲染能力，由 agent 按第 5 节的文件夹规范与 block 映射生成真实文档即可，活体示例见 content 组织页 `/content/page/fXZdnHZ9AT2a`。

原型规范：真实数据形态（PAY 编号、mono 数字、真实中文文案）；空态与失败态至少各一处内嵌呈现；Tabler 图标（禁 emoji 与文字符号）；屏间 data-screen 互链；`:root` 内联 Foundry tokens；双主题（默认 light，右上主题切换）；卡片不用左侧竖向强调条；次级面板用 --panel 表面色与内容分层。
