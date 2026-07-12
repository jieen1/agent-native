<callout color="blue_bg">
	**本章回答三个问题**：这套系统到底是什么（愿景与产品立场）、由哪四个应用怎样分工协作（系统全景）、人和机器的边界画在哪里（人机分界与假设）。**设计重点**：人的时间只花在判断上，判断之后全自动执行，全程证据优先——后续所有章节的页面与流程设计都从这三句话推导出来。阅读顺序上本章是总纲，02 章展开流程，03/04/05 章展开各应用页面。
</callout>

## 1. 愿景

**人负责说清楚，系统负责做出来，并且自己证明做对了。**

这套系统把已经在实践中验证过的 agentic-engineering SDLC 工作流，从"Claude Code 技能 + 脚本 + GitLab 标签"形态，升级为运行在 agent-native 四个应用之上的一等系统能力：

- 人的时间只花在**判断**上：把需求说清楚、把范围划清楚、审查 UI 设计、审查技术设计、审查测试计划——这些步骤有专门设计的、一次一问带推荐答案的交互界面，而不是在聊天窗口里自由发挥。
- 判断完成之后**全自动执行**：编排器按可复用的 DAG 工作流派发、开发、测试、评审、管理 issue、记录测试证据、合入交付，全程状态自动回写，人只在升级（escalation）时被打断。
- 全程**证据优先**：每一次"完成"都必须附带可核对的证据（`repo:file:line`、PR 链接、真实运行输出、截图），拒绝一切 "implemented / done" 式的自我宣称。

## 2. 五条产品立场（区别于"把任务丢给 AI"）

1. **不是把任务丢给 brain 让它自己设计自己开发。** 规划阶段（sprint 规划、需求明确、UI 设计评审、技术设计评审、测试计划评审）是人主导、系统辅助的结构化交互；只有全部签核后，工作才进入自动执行域。
2. **brain 可替换，hand 可多样。** 编排大脑（今天是 Claude Code，明天可以是任何 ACP agent 或 SDK 模型）只做编排叙述与判断；确定性调度、状态机、回写全部由不依赖 LLM 的协调器完成（homerail 的双脑分层）。工人节点按任务选模型（本地 vLLM 为主力，按仓可切换）。
3. **简单任务走短流程。** 工作流是数据不是代码：完整 SDLC、快速任务、缺陷热修、文档任务、调研任务各有可复用模板，按工作项类型自动选择、可人工覆盖。不强迫一行文案改动走七个阶段。
4. **UI 设计是流程的一等公民。** 原 SDLC 从 sprint-plan（what/why）直接跳到 sprint-design（where/how），中间没有任何"用户会看到什么"的设计环节——这是实践中已知的最薄弱点。v2.0 在两者之间补上 UI 设计子流程：ui-spec 产物、design 应用原型流水线、嵌入式 UI 评审、ui-signoff 四步，技术设计与测试场景引用原型而非凭空想象界面。
5. **系统的核心价值是可视化与交互，不是流程搬家。** 我们不是把 SDLC 的 markdown 平移进数据库——原来"一大堆文字没人细看"的测试计划、技术设计、依赖关系、数据模型，要变成场景卡、DAG 图、模型图、可嵌入原型这样**可视化、可交互**的呈现，让人真的去理解与审查；而 agent 拿到的永远是干净的纯文本——复杂呈现只给人，绝不进 agent 上下文。

## 3. 设计原则（约束所有模块设计）

<table header-row="true">
<tr>
<td>#</td>
<td>原则</td>
<td>来源</td>
<td>含义</td>
</tr>
<tr>
<td>P1</td>
<td>四位一体</td>
<td>agent-native</td>
<td>每个功能必须同时落 UI、actions、技能/指令、application state；agent 与 UI 能力对等</td>
</tr>
<tr>
<td>P2</td>
<td>双脑分层</td>
<td>homerail</td>
<td>LLM 只做规划与判断；调度/状态机/回写是确定性代码，可测试、可重放</td>
</tr>
<tr>
<td>P3</td>
<td>最小知识契约</td>
<td>homerail / a-e</td>
<td>工人只看自己的 brief 与依赖产物，永远拿不到全图与 sprint 文档；上游到下游只走显式声明的数据边</td>
</tr>
<tr>
<td>P4</td>
<td>证据优先</td>
<td>a-e 验证纪律</td>
<td>引用即打开；反奉承 schema；宣称者与批准者分离；真实运行证据</td>
</tr>
<tr>
<td>P5</td>
<td>有界自愈</td>
<td>homerail / a-e</td>
<td>纠偏、重试、评审、审计全部有硬上限，超限升级人类，绝不无限自旋，也绝不静默挂死</td>
</tr>
<tr>
<td>P6</td>
<td>产物即接口</td>
<td>a-e</td>
<td>sprint 文档、测试计划、ui-spec、技术设计、briefs、审计报告都是版本化产物，有明确 schema，人写产物受保护</td>
</tr>
<tr>
<td>P7</td>
<td>工作流即数据</td>
<td>v1.1 §3.8</td>
<td>流程逻辑放在版本化 DAG 模板与技能 markdown 里，改流程不改代码；进代码的只有能力原语</td>
</tr>
<tr>
<td>P8</td>
<td>幂等与可恢复</td>
<td>homerail / v1.1</td>
<td>一切推进操作幂等 + 前置断言；进程重启可从持久化事件恢复；孤儿运行态降级而非悬挂</td>
</tr>
<tr>
<td>P9</td>
<td>乐观与密度</td>
<td>multica</td>
<td>UI 点击即改、乐观更新、失败回滚；Linear 级信息密度；渐进披露，过程可折叠、结论外露</td>
</tr>
<tr>
<td>P10</td>
<td>状态可感</td>
<td>multica</td>
<td>系统任何"正在发生"都有专门的视觉语汇（流光、呼吸、计时器、状态环），人扫一眼就知道系统在不在动、卡在哪</td>
</tr>
<tr>
<td>P11</td>
<td>双表征</td>
<td>本设计</td>
<td>每份产物同源两个视图：人审查用富可视化（content 的表格、折叠、图、清单 block），agent 消费用纯文本（tracker 产物列）；复杂呈现只给人，绝不进 agent 上下文</td>
</tr>
<tr>
<td>P12</td>
<td>低摩擦保底</td>
<td>本设计</td>
<td>结构化流程的每一步都有跳过与直达通道：可选步骤（头脑风暴）、手工导入现成文档、直接建单直接派发——原来容易做的事进了系统必须仍然容易</td>
</tr>
<tr>
<td>P13</td>
<td>机制优先于提示词</td>
<td>v2.2 自举（07 章）</td>
<td>凡红线，必有一个技术机制背书——能力面裁剪、写入守卫、引擎断言、显式告警四者其一；提示词只承担解释职责。可观察不等于已约束：自举证明纯提示词红线在压力下必然失守（SDLC-052）</td>
</tr>
</table>

## 4. 系统全景

### 4.1 四应用分工

核心逻辑：**判断在人，流程在 tracker，执行在 orchestrator，UI 域与文档域各自沉淀专业产物**。四个应用通过 A2A/MCP 互联，任何一侧都不复制另一侧的数据，只传 id 与有界全文。

<Mermaid id="mmd-00-topology" source={"flowchart TD\n  H[人 · 判断与签核] --> T[Tracker · 流程域驾驶舱]\n  T -->|派发 MCP: brief 全文 + tags 身份| O[Orchestrator · 执行域引擎室]\n  O -->|回写:advance/建单/证据| T\n  O -->|A2A: 原型入库| D[Design · UI 域]\n  O -->|A2A: story 与 changelog 入库| C[Content · 文档域]\n  T -->|UI 评审: 内嵌 Present 视图| D\n  T -.->|深链互通| O"} />

<table header-row="true">
<tr>
<td>应用</td>
<td>拥有的裁决</td>
<td>核心能力</td>
</tr>
<tr>
<td>**Tracker** 流程域</td>
<td>该做什么、做到哪（`sprint.phase` 权威）、谁批准</td>
<td>项目/仓库注册 · Sprint · Epic/工作项 · 依赖图+校验 · 规划工作台（技能链） · 产物库（版本化） · 审批中心 · 依赖感知调度 · 度量</td>
</tr>
<tr>
<td>**Orchestrator** 执行域</td>
<td>怎么做、哪个沙箱、哪个模型</td>
<td>V3 DAG 引擎（可视化） · 工作流库（多套模板、版本化） · Brain（可替换） · Worker（vLLM 主力/按仓切换） · Workspace · PR/CI/合并 · 健康门 · 洞察</td>
</tr>
<tr>
<td>**Design** UI 域</td>
<td>界面长什么样</td>
<td>设计系统（Foundry） · sprint 原型（每 sprint 一个 design、多屏） · UI 评审的画布与批注</td>
</tr>
<tr>
<td>**Content** 文档域</td>
<td>交付给人读什么</td>
<td>交付文档（story、changelog、发布说明） · 验收报告归档 · 产品知识沉淀</td>
</tr>
</table>

<callout color="yellow_bg">
	**跨应用传输的关键决策**：只传 **id + 有界全文**。brief 与 ui-spec 是有界文档，直接进 run inputs；原型传 designId + 深链，绝不把 HTML 塞进 prompt；大 diff、日志走产物引用而非消息体。这是控制上下文成本与防泄漏的双重手段。
</callout>

### 4.2 身份与安全（继承 v1.1，全景重申）

- 所有跨应用调用走 A2A/MCP + `A2A_SECRET` JWT，run tags 携带 `source / sprint_id / item_id / ownerEmail / orgId`，回写通道用 tags 中身份铸 JWT，保证 ownable 数据落在正确 org。
- brief 隔离改为**按工作流声明的载荷契约**（02 章契约表）：issue-pipeline 工人只许 brief、shared-brief、ui-spec 屏摘要；sdlc-verify 追加 test-plan 场景节；sdlc-gap-analysis 追加 sprint-doc 的 Goal 与编号指标节（goal-metrics 节选）。任何工作流都禁止注入 technical-design 全文与 issue 清单；「节选」是确定性提取的结构化节，不是全文。
- workspace 临时 token、commit 前密钥扫描、`*.mcp.json` 排除、日志脱敏，全部继承现有实现并在 UI 中可见（工作区页显示扫描结果）。

## 5. 端到端旅程：一个 Sprint 的完整故事

旅程分七步呈现，人工介入只出现在前三步的访谈与签核、以及后两步的例外裁决；中间的实施与验证完全自动。与 02 章八相位状态机的对应关系：第 2、3 步（UI 设计、技术设计）同处 designing 相位、各自签核，但技术设计依赖已签核的 ui-spec（顺序在 UI 之后）；第 7 步（交付）覆盖 promoting、storytelling、done 三个相位；其余一一对应。第 5 步的 RED 回环是**相位内修复**：修复单重跑实施与测试节点，sprint 相位停在 verifying 不回退。

<Mermaid id="mmd-00-journey" source={"flowchart LR\n  P1[1 规划 · 人访谈] -->|plan-signoff| P2[2 UI 设计 · 人批注]\n  P2 -->|ui-signoff| P3[3 技术设计 · 人评审]\n  P3 -->|design-signoff| P4[4 实施 · 全自动]\n  P4 --> P5[5 验证 · 全自动]\n  P5 -->|RED: 相位内修复回环 不回退相位| P4\n  P5 -->|GREEN| P6[6 目标审计 gap-analysis]\n  P6 -->|NO_GAPS| P7[7 交付]\n  P6 -.->|3 轮超限: 人裁决| P7"} />

<table header-row="true">
<tr>
<td>阶段</td>
<td>人</td>
<td>Tracker</td>
<td>Design</td>
<td>Orchestrator</td>
<td>Content</td>
</tr>
<tr>
<td>1 规划</td>
<td>brainstorm 对话（**可选**）、sprint-plan 访谈、test-plan 审查、**plan-signoff**</td>
<td>sprint-doc v1(human，**含 Goal 与可证伪成功指标——全程完成判据的锚**) / test-plan 产物 / 可选 brainstorm-notes；phase 进入 designing</td>
<td>—</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td>2 UI 设计（含 UI 的 sprint）</td>
<td>逐屏批注、**ui-signoff**</td>
<td>ui-spec 产物；批注驱动修订</td>
<td>sprint 原型（多屏）入库、Present 视图供评审</td>
<td>sdlc-ui-build 流水线（vLLM 并行出屏）</td>
<td>—</td>
</tr>
<tr>
<td>3 技术设计</td>
<td>审查设计草稿与对抗评审报告、**design-signoff**</td>
<td>technical-design 从 v1 修订至 v2；briefs 提取；依赖图校验；phase 进入 executing</td>
<td>—</td>
<td>sprint-review 对抗评审（vLLM/sonnet 交替轮）</td>
<td>—</td>
</tr>
<tr>
<td>4 实施</td>
<td>不介入</td>
<td>依赖感知调度：解锁即派发；状态/证据自动回写；看板实时前进</td>
<td>—</td>
<td>sdlc-issue-pipeline × N：dev / qa / review / gate / diff-audit / PR / CI / 合入</td>
<td>—</td>
</tr>
<tr>
<td>5 验证</td>
<td>不介入</td>
<td>verify-report 产物；RED 自动建 from-audit 单并自动派发（阶段子集）</td>
<td>—</td>
<td>sdlc-verify：全量测试 + 集成场景逐个实测</td>
<td>—</td>
</tr>
<tr>
<td>6 目标审计（gap-analysis）</td>
<td>仅 3 轮超限时裁决</td>
<td>audit-report 轮次产物；NO_GAPS 后 phase 进入 promoting（**合入 base 的前置条件**）</td>
<td>—</td>
<td>sdlc-gap-analysis：按 Sprint Goal 逐指标判 MET/UNMET（证据 schema、反奉承）</td>
<td>—</td>
</tr>
<tr>
<td>7 交付</td>
<td>验收 story（或 accept/defer）</td>
<td>phase 到 done；度量页更新</td>
<td>—</td>
<td>sdlc-promote：拓扑序 merge-commit 晋升</td>
<td>story / changelog / 发布说明入库</td>
</tr>
</table>

<callout color="green_bg">
	**人工介入清单（与 v1.1 M0 对齐，v2.0 新增第 2 道可选 UI 签核）**：阶段 1–3 的访谈与三道签核、阶段 6–7 的例外裁决、以及任何 escalation。其余全部自动。
	**Sprint 的完成由 Goal 判定，不由"单子关完"判定**（承 a-e Phase H 纪律：closed 不等于 goal achieved）：第 1 步定下的 Goal 与可证伪指标是唯一基准；第 6 步 gap-analysis 只看 Goal、跨仓 diff 与验证日志（不看 issue 清单），逐指标给出 MET/PARTIAL/UNMET 与证据，verdict=NO_GAPS 是晋升合入 base 的前置条件。
</callout>

## 6. 人机分界表

<table header-row="true">
<tr>
<td>人做的事</td>
<td>在哪里做</td>
<td>交互形态</td>
</tr>
<tr>
<td>说清楚方向</td>
<td>Sprint 规划工作台 · 头脑风暴步</td>
<td>一次一问、每问带推荐答案的对话卡片</td>
</tr>
<tr>
<td>定稿需求与范围</td>
<td>规划工作台 · 规划步</td>
<td>访谈 + 整块文档揭示 + 可证伪指标检查清单</td>
</tr>
<tr>
<td>审查测试计划</td>
<td>规划工作台 · 测试计划步</td>
<td>场景卡片逐个过目（每场景带 pass/fail 信号）</td>
</tr>
<tr>
<td>审查 UI 设计</td>
<td>规划工作台 · UI 评审步</td>
<td>内嵌原型逐屏走查 + 锚点批注</td>
</tr>
<tr>
<td>审查技术设计</td>
<td>规划工作台 · 设计步</td>
<td>文档 + 对抗评审报告表 + 版本 diff</td>
</tr>
<tr>
<td>画拆解边界</td>
<td>Epic 拆解表单</td>
<td>人写子项清单，系统校验依赖图（**无 AI 自动拆解入口**）</td>
</tr>
<tr>
<td>三道签核</td>
<td>审批中心 / 工作台顶栏</td>
<td>签核卡片：缺失判据明示，一键批准/驳回</td>
</tr>
<tr>
<td>例外裁决</td>
<td>收件箱</td>
<td>escalation / audit-deferral / accept-defer 卡片</td>
</tr>
</table>

<table header-row="true">
<tr>
<td>系统做的事</td>
<td>由谁做</td>
</tr>
<tr>
<td>技能访谈引导、产物起草、对抗评审、briefs 提取</td>
<td>tracker 技能链 + orchestrator spawn</td>
</tr>
<tr>
<td>原型生成、设计系统套用</td>
<td>sdlc-ui-build 工作流（vLLM 并行）</td>
</tr>
<tr>
<td>依赖感知派发、健康前置检查</td>
<td>tracker 调度器（确定性）</td>
</tr>
<tr>
<td>开发/测试/评审/守门/防污染/合入</td>
<td>sdlc-issue-pipeline（多模型工人）</td>
</tr>
<tr>
<td>集成验证、缺陷建单、修复回环</td>
<td>sdlc-verify + from-audit 自动单</td>
</tr>
<tr>
<td>目标审计、证据校验</td>
<td>sdlc-gap-analysis（schema 强制）</td>
</tr>
<tr>
<td>晋升合入、分支清理</td>
<td>sdlc-promote</td>
</tr>
<tr>
<td>状态回写、阶段推进、epic 闭合</td>
<td>reconciler 回写通道（幂等）</td>
</tr>
<tr>
<td>story / changelog / 报告</td>
<td>content 流水线</td>
</tr>
<tr>
<td>度量与失败归因</td>
<td>双侧度量页（自动派生）</td>
</tr>
</table>

## 7. 与现状的关系（模块级 delta 总览）

<table header-row="true">
<tr>
<td>模块</td>
<td>现状</td>
<td>v2.0 设计</td>
</tr>
<tr>
<td>tracker 七阶段</td>
<td>手动状态翻转，与派发两张皮</td>
<td>phase 权威 + 门判据 + 确定性回写驱动（03 章）</td>
</tr>
<tr>
<td>tracker 规划</td>
<td>无任何规划技能与界面</td>
<td>Sprint 规划工作台 + 六技能链 + 产物库（03 章）</td>
</tr>
<tr>
<td>tracker 队列</td>
<td>UI 全线桩、无消费者</td>
<td>依赖感知调度器 + 真实审批/排序/暂停（03 章）</td>
</tr>
<tr>
<td>orchestrator 运行视图</td>
<td>垂直卡片列表，无图</td>
<td>真正的 DAG 图可视化 + 节点检查器（04 章）</td>
</tr>
<tr>
<td>orchestrator 工作流</td>
<td>裸 JSON textarea，无种子</td>
<td>工作流库（种子模板 + 版本链）+ 可视化编辑器（04 章）</td>
</tr>
<tr>
<td>orchestrator brain</td>
<td>功能在但不可见、不可选</td>
<td>Brain 控制台 + 引擎注册表（可替换 UI 化）（04 章）</td>
</tr>
<tr>
<td>orchestrator agents 页</td>
<td>静态假页</td>
<td>读真实 agent 定义 + Inspector 编辑（04 章）</td>
</tr>
<tr>
<td>UI 设计环节</td>
<td>完全缺失</td>
<td>ui-spec + 原型流水线 + 评审门（05 章）</td>
</tr>
<tr>
<td>design 应用</td>
<td>通用原型工具</td>
<td>承载 Foundry 设计系统 + sprint 原型惯例（01/05 章）</td>
</tr>
<tr>
<td>content 应用</td>
<td>通用文档工具</td>
<td>承载交付文档流水线（05 章）</td>
</tr>
<tr>
<td>设计系统</td>
<td>各 app 各自 shadcn 默认</td>
<td>Foundry 统一 tokens 与组件语汇（01 章）</td>
</tr>
<tr>
<td>产物正文的家</td>
<td>tracker 单文本列，无人细读</td>
<td>content 项目文档库：文件夹规范 + 富 block 呈现给人；tracker 存 agent 纯文本视图 + 登记链接（05 章）</td>
</tr>
</table>

## 8. 假设与前提

本设计的全部结论建立在以下假设之上。任何一条失效，对应模块需要重估（表内注明受影响章节）。

### 环境与运行时

<table header-row="true">
<tr>
<td>#</td>
<td>假设</td>
<td>失效影响</td>
</tr>
<tr>
<td>A1</td>
<td>部署形态是 101 单机 docker compose（an-* 容器 + 共享 Postgres + nginx 网关）；hosted/多租户不是当前目标，但 schema 与访问控制仍按 ownable 规范设计</td>
<td>跨机部署需重估回写通道与共享 DB 读取（02 §6）</td>
</tr>
<tr>
<td>A2</td>
<td>本地 vLLM（qwen3.6）持续可用且是 dev/qa 主力；sonnet 档经 API 可用于 review/gate/audit；开发阶段不引入其他外部模型</td>
<td>模型策略与 devModel 切换设计重估（02 §3）</td>
</tr>
<tr>
<td>A3</td>
<td>Claude Code 订阅只供 brain 使用：不给 worker、不高频轮询 usage（账号安全红线）</td>
<td>brain 引擎默认项与健康门语义变化（02 §5）</td>
</tr>
<tr>
<td>A4</td>
<td>浏览器可出网加载 CDN（Tabler / Google Fonts / Alpine）；原型与 design 渲染依赖之</td>
<td>离线环境需把资源内联进设计系统（01 §6）</td>
</tr>
<tr>
<td>A5</td>
<td>`A2A_SECRET` 在全部容器间一致，JWT（sub+org_id）是跨应用信任的唯一凭据</td>
<td>跨应用调用与回写全部失效（05 §6）</td>
</tr>
</table>

### 流程与组织

<table header-row="true">
<tr>
<td>#</td>
<td>假设</td>
<td>失效影响</td>
</tr>
<tr>
<td>A6</td>
<td>单仓先行：每项目一个主仓；project_repos 表结构一步到位，多仓执行属后续</td>
<td>issue-pipeline 的 workspace/合并语义需加兄弟仓隔离（02 §3.1）</td>
</tr>
<tr>
<td>A7</td>
<td>人工介入收敛为：规划访谈 + 三道签核 + 例外裁决；其余全自动是可接受的工作方式</td>
<td>阶段门与收件箱的设计密度重估（03 §2/§6）</td>
</tr>
<tr>
<td>A8</td>
<td>sprint 是编排与回滚单元；同项目处于 executing 至 promoting 相位之间的 sprint 同时最多一个</td>
<td>调度器与分支模型重估（02 §7）</td>
</tr>
<tr>
<td>A9</td>
<td>需求拆解由人完成（人画边界、系统校验）是产品立场，不因模型能力提升而改变</td>
<td>Epic 拆解交互不变，人拆解红线永久有效（03 §7）</td>
</tr>
<tr>
<td>A10</td>
<td>工作项粒度 2–6 小时人当量、epic 2–5 子项、依赖链深不超过 3（承 agentic-engineering doctrine）</td>
<td>依赖图告警阈值与派发批量需调整（03 §7/§8）</td>
</tr>
<tr>
<td>A11</td>
<td>UI 设计子流程只对"含用户可见界面"的 sprint 激活；纯后端 sprint 跳过 ui track 不损失质量</td>
<td>designing 相位门配置调整（02 §1.2）</td>
</tr>
</table>

### 技术与集成

<table header-row="true">
<tr>
<td>#</td>
<td>假设</td>
<td>失效影响</td>
</tr>
<tr>
<td>A12</td>
<td>V3 引擎既有能力（advisory-lock tick、patch/fork、schema 纠偏、错误分类、MCP 全目录）保持可用；v2 引擎可安全退役</td>
<td>04 章全部运行视图与 action 收敛重估</td>
</tr>
<tr>
<td>A13</td>
<td>orchestrator 可反向调 tracker（tracker-client 走 A2A/HTTP+JWT）；run tags 中身份可信</td>
<td>回写通道降级为轮询单通道（02 §6）</td>
</tr>
<tr>
<td>A14</td>
<td>gateMode=tests-only 是默认质量闸；ciMode=none 的仓是一等公民；起栈实测（stack 档）仅在仓库自带可起命令时启用</td>
<td>issue-pipeline gate 节点语义重估（02 §3.1）</td>
</tr>
<tr>
<td>A15</td>
<td>design 应用的 create-file 编辑桥标注、srcdoc 沙箱渲染、data-screen 导航约定保持稳定</td>
<td>UI 评审嵌入与原型入库方式重估（05 §3/§4）</td>
</tr>
<tr>
<td>A16</td>
<td>content 应用 NFM 语法（HTML 表格、块级规则）保持稳定；文档发布走 MCP 通道可行</td>
<td>交付文档流水线重估（05 §5）</td>
</tr>
<tr>
<td>A17</td>
<td>agent-native core 持续迭代但不破坏 actions/ownable/A2A 契约；本设计不改 core，若必须改则单独记录</td>
<td>对应模块随 core 变更重估</td>
</tr>
</table>

### 度量与呈现

<table header-row="true">
<tr>
<td>#</td>
<td>假设</td>
<td>失效影响</td>
</tr>
<tr>
<td>A18</td>
<td>spawns/events 时间戳足以派生环节耗时（秒级误差可接受）；工作项阶段迁移时间轴取自活动流回写记录</td>
<td>度量页数据来源重估（03 §10 / 04 §11）</td>
</tr>
<tr>
<td>A19</td>
<td>失败五层归因（prompt/tool/engine/template/harness）用确定性规则 + LLM 辅助可达到可用精度</td>
<td>洞察页归因面板降级为人工标注（04 §11）</td>
</tr>
<tr>
<td>A20</td>
<td>目标浏览器支持 oklch() 与 color-mix()（现代 Chrome/Edge/Safari）</td>
<td>Foundry token 需提供 sRGB 回退（01 §2）</td>
</tr>
</table>

### 8.1 自举修订（v2.2）——被实战证伪或需强化的假设

<callout color="orange_bg">
	2026-07-11 自举实战（07 章）对上表的修订，以及此前**隐含未写出**、失效后才暴露的假设——现补为显式假设并配机制。
</callout>

**既有假设修订**

- **A2 修订**：模型"身份"不可假设——本地 vLLM 曾以 4 个名字（含 2 个 claude-* 假名）服务同一份权重（SDLC-054）。模型真名与别名映射必须由注册表权威登记（04 章），归因与度量只认真名。
- **A12 修订**：引擎"既有能力保持可用"不等于"行为正确"——spawn 终态传导（SDLC-050）、用量采集（SDLC-051）都需以不变量加告警背书（02 章 R9 与执行器上下文契约），能力存在性不再当作正确性证据。
- **A18 修订**：时间戳可信，但 **token 用量列在采集契约修复前不得进入任何度量**——现值物理不可能（SDLC-051）。

**新增显式假设（此前隐含，自举证伪后补写并配机制）**

<table header-row="true">
<tr>
<td>#</td>
<td>假设</td>
<td>失效影响</td>
</tr>
<tr>
<td>A21</td>
<td>工作区由供给管道保证：基线新鲜、依赖预热、测试可执行（02 章工作区契约三不变量）；不满足即 infra 故障，不开 run</td>
<td>全部执行工作流的交付质量失去地基（曾以 SDLC-056/057 形式失效）</td>
</tr>
<tr>
<td>A22</td>
<td>agent 的能力边界由机制（02 章能力面矩阵）而非提示词保证；提示词红线单独存在时视为未设防</td>
<td>作者身份与审计链失真（曾以 SDLC-052 形式失效）</td>
</tr>
<tr>
<td>A23</td>
<td>状态迁移只接受守卫表（02 章状态迁移守卫）列明的写入方与证据载荷；其余写入一律拒绝</td>
<td>done 失去含义、回链断裂（曾以 SDLC-053/056 形式失效）</td>
</tr>
</table>

## 9. 代号与缩写

<table header-row="true">
<tr>
<td>代号</td>
<td>含义</td>
</tr>
<tr>
<td>a-e / agentic-engineering</td>
<td>既有的 SDLC 实践工具箱（技能 + 脚本 + GitLab 标签形态），本设计的流程蓝本</td>
</tr>
<tr>
<td>homerail</td>
<td>参考项目：brain 与 hand 完全分离、可恢复可重试的本地 DAG 编排运行时</td>
</tr>
<tr>
<td>multica</td>
<td>参考项目：把编码 agent 当团队成员管理的平台，UI/交互/agent 定义的蓝本</td>
</tr>
<tr>
<td>v1.1 / M0</td>
<td>前身文档《SDLC 系统化设计 v1.1》及其已对齐的决策基线（M0）</td>
</tr>
<tr>
<td>CC</td>
<td>Claude Code——当前默认的 brain 引擎（订阅只供 brain，不给 worker）</td>
</tr>
<tr>
<td>ACP</td>
<td>Agent Client Protocol——agent 运行时协议，未来 brain/worker 引擎的接入形态之一</td>
</tr>
<tr>
<td>vLLM / qwen3.6</td>
<td>本地推理服务及其主力模型，dev 与 qa 节点默认执行档</td>
</tr>
<tr>
<td>sonnet 档</td>
<td>经 API 调用的 claude-sonnet 模型档位，用于 review、gate、audit 类判断节点</td>
</tr>
</table>

## 10. 术语表

<table header-row="true">
<tr>
<td>术语</td>
<td>定义</td>
</tr>
<tr>
<td>Sprint</td>
<td>编排单元与回滚单元；phase 是流程推进的权威状态</td>
</tr>
<tr>
<td>工作项 (work item)</td>
<td>需求/任务/缺陷/from-audit 等；实施与测试在工作项级推进</td>
</tr>
<tr>
<td>Epic</td>
<td>带子项树与依赖边的大工作项；人拆解，系统校验</td>
</tr>
<tr>
<td>产物 (artifact)</td>
<td>版本化流程文档：sprint-doc / test-plan / ui-spec / technical-design / brief / verify-report / audit-report / story</td>
</tr>
<tr>
<td>签核 (signoff)</td>
<td>人工审批门：plan / ui / design 三道 + 例外类（escalation / audit-deferral / accept-defer）</td>
</tr>
<tr>
<td>Brain</td>
<td>编排大脑：接任务、编排叙述、审查汇报；可替换（CC / SDK-vLLM / ACP）</td>
</tr>
<tr>
<td>协调器 (reconciler)</td>
<td>确定性调度内核：tick、guard、重试、回写；非 LLM</td>
</tr>
<tr>
<td>Worker / 工人</td>
<td>DAG 节点的执行者：vLLM、sonnet API 档等 spawn（CC 订阅只属 brain，见 A8 组 A3）</td>
</tr>
<tr>
<td>工作流 (workflow)</td>
<td>版本化 V3 DAG 模板；工作流族 = 多套可复用模板</td>
</tr>
<tr>
<td>brief</td>
<td>单工作项的有界实施简报；工人唯一可见的需求视图</td>
</tr>
<tr>
<td>ui-spec</td>
<td>UI 设计规格产物：屏清单、流程、组件映射、数据状态</td>
</tr>
<tr>
<td>证据 (evidence)</td>
<td>`repo:file:line` / PR / sha / 真实运行输出 / 截图 / absence-of</td>
</tr>
<tr>
<td>健康前置门</td>
<td>派发前对 vLLM / CC 登录 / 队列的确定性检查</td>
</tr>
<tr>
<td>from-audit 单</td>
<td>verify/audit 失败自动创建的修复工作项（阶段子集：实施到测试）</td>
</tr>
</table>
