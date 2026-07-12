<callout color="blue_bg">
	本章定义"流程本身"：阶段状态机、规划技能链、执行域工作流族、恢复与重试语义、Brain 可替换架构。页面如何承载这些流程见 03/04/05 章。
	设计重点有三：一，判断与执行彻底分层——LLM 只做规划与评审，推进状态、调度派发、失败路由全部是确定性代码；二，门放在"人说清楚"与"机器动手"的交界处，且门判据是项目级配置而非代码；三，失败永远有界路由——纠偏、重试、评审、审计全部有硬上限，超限升级人类，绝不静默挂死。
	v1.1（docs/sdlc-system-design.md）已定稿的数据模型增量、验收纪律此处引用不重复。
</callout>

## 1. 阶段状态机：谁有权推进流程

现状 tracker 的最大问题是"两张皮"：七阶段是手动翻转的状态标签，派发是另一条互不相认的链路。v2.0 的裁决是——**`sprint.phase` 是流程推进的唯一权威**，工作项阶段由它派生联动；实施与测试两个工作项级阶段由回写通道驱动，人手不碰。这样"看板上的位置"永远等于"系统里的真相"。

### 1.1 Sprint 八相位状态机

<Mermaid id="wf02-phase-machine" source={"stateDiagram-v2\n  [*] --> planning\n  planning --> designing: plan-signoff\n  designing --> executing: design-signoff 含UI时追加ui-signoff\n  executing --> verifying: 全部工作项合入\n  verifying --> verifying: RED 建 from-audit 单 修复后重跑\n  verifying --> auditing: GREEN\n  auditing --> auditing: blocking 建单修复 最多 3 轮\n  auditing --> promoting: NO_GAPS\n  promoting --> storytelling: 晋升合入 base\n  storytelling --> done: story 实走验证\n  done --> [*]"} />

三道人工签核门（plan-signoff、ui-signoff、design-signoff）全部集中在前两个相位；从 executing 起直到 done，理想路径上没有任何人工介入点——人只在 escalation、audit-deferral、accept-defer 三类例外裁决时被打断。

<callout color="yellow_bg">
	状态机不变量（全部由确定性代码保证，不依赖任何 LLM 判断）：
	- `advance-stage` 幂等且带前置断言：fromStage 或 expectedRunId 不匹配当前状态时是 no-op，杜绝双通道（回写与轮询）重复推进、旧 run 终态推进已回退的工作项。
	- 同一项目同时最多一个 sprint 处于 executing 到 promoting 之间（进入 executing 时断言），防止两个 sprint 抢同一条分支基线。
	- 每道相位迁移的门判据是项目级 JSON 配置（所需产物 docKey、所需签核、附加校验），改判据零代码。
	- **auditing 相位 = gap-analysis**：按 sprint Goal 逐指标判定，verdict=NO_GAPS 是进入 promoting（合入 base）的前置条件——sprint 的完成由 Goal 判定，不由工作项清单判定。
	- sprint 级推进时工作项 `currentStageName` 批量派生联动，失败项写入活动流告警而非静默。
</callout>

### 1.2 designing 相位的三条 track

v1.1 把设计相位当单一 track，UI 是空白——这正是实践中已知的最薄弱点。v2.0 把 designing 拆为三条各自签核的 track。注意三者并非无依赖并发：**测试计划可与 UI 设计并行**；**技术设计依赖已签核的 ui-spec，必须在 UI 之后**（"并行"仅指三者同处 designing 相位、各有独立签核）：

<table header-row="true">
<tr>
<td>track</td>
<td>产物链</td>
<td>门</td>
<td>适用</td>
</tr>
<tr>
<td>UI 设计</td>
<td>ui-spec · sprint 原型（design 应用）· 批注修订</td>
<td>ui-signoff</td>
<td>sprint 含用户可见界面时激活（sprint-doc 的 In Scope 标注 ui 面）</td>
</tr>
<tr>
<td>技术设计</td>
<td>technical-design v1 · 对抗评审 · v2 · briefs</td>
<td>design-signoff</td>
<td>始终</td>
</tr>
<tr>
<td>测试计划</td>
<td>test-plan（planning 相位产出，此处允许按 UI 与设计结论修订版本）</td>
<td>并入 plan-signoff，修订版需重确认</td>
<td>始终</td>
</tr>
</table>

两条顺序规则，保证"设计建立在定稿的 UI 之上"：

- ui-signoff 先于 design-signoff；无 UI 的 sprint 自动跳过 ui track（门配置里该判据不激活）。
- **签核失效规则**：已批签核所锚定的产物出新版本时，该 approval 置 stale 并自动生成「重确认」审批单入收件箱（不回退相位）；重确认前依赖该签核的后续门判据视为未满足。test-plan 在 designing 相位修订的「重确认」即走此机制。
- technical-design 的每工作项小节与测试场景必须引用已签核的 ui-spec 屏编号与原型深链；`extract-briefs` 把对应屏的规格摘要（不是 HTML）打进各工作项 brief。

### 1.3 工作项级状态：回写驱动，不是人手翻转

- 实施与测试阶段由回写通道推进：run 终态后 reconciler 调 tracker 的 `advance-stage(item, fromStage, expectedRunId)`。
- `plannedStages` 按类型激活子集：from-audit 与缺陷类是「实施 · 测试」，文档任务是「实施 · 交付」，调研是「分析 · 交付」（产物即交付物）。子集之外的阶段不渲染、不设门——修复单不会被自己的规划门卡死。
- run 失败路由：工作项状态 failed、停在当前阶段，详情页给「重派 / 回退阶段 / 升级」三操作；transient 类错误由系统自动 fork 重试一次。
- **人工完成逃生口（P12）**：人自己改代码自己合入的场景，工作项详情提供「人工完成」——强制附证据（PR/commit 链接，校验存在性）后 `advance-stage(producedBy=human, evidence)`，活动流标注人工来源；与回写通道靠幂等断言并存。
- 回退保护：工作项绑定非终态 run 时，回退的先决条件是 runCancel 成功，否则拒绝。
- **修复子流与派发窗口**：from-audit 单不改变 sprint 相位——verify RED 时 sprint 停在 verifying、audit blocking 时停在 auditing，修复单在原相位内派发、修复、重验。调度器的派发窗口是 `phase` 属于 executing、verifying、auditing 三者之一；健康前置门对**每次派发**都生效，但对系统内生的修复派发采用**排队等待恢复**（而非人工派发的立即拒绝），避免修复回环因瞬时不健康而断链。单活跃 sprint 断言只对**其他** sprint 计数，同一 sprint 在相位带内的停留与重验不会触发自身断言。

**相位与工作项阶段的派生映射**（哪些由相位批量派生、哪些由回写驱动）：

<table header-row="true">
<tr>
<td>sprint.phase</td>
<td>工作项 currentStageName</td>
<td>驱动方式</td>
</tr>
<tr>
<td>planning</td>
<td>待办（拉入 sprint 后为 分析）</td>
<td>相位派生（批量 advance）</td>
</tr>
<tr>
<td>designing</td>
<td>设计</td>
<td>相位派生</td>
</tr>
<tr>
<td>executing</td>
<td>实施，run 终态后推进到 测试</td>
<td>回写通道逐项驱动</td>
</tr>
<tr>
<td>verifying</td>
<td>测试（verify GREEN 后批量推进到 验收）</td>
<td>回写通道（verify 结果）</td>
</tr>
<tr>
<td>auditing</td>
<td>验收</td>
<td>相位派生（NO_GAPS 推进）</td>
</tr>
<tr>
<td>promoting、storytelling、done</td>
<td>交付</td>
<td>相位派生（三相位合于一个阶段）</td>
</tr>
</table>

- epic 自动闭合：全部子项到达终阶段后 epic 状态派生完成，活动流留痕。

## 2. 规划域技能链（tracker 侧）

划分原则一句话：**判断性的东西是技能，确定性的东西是 action**。技能是 `.agents/skills` 下的 markdown，改措辞即生效，流程优化不动代码；briefs 提取这类必须字节级可重复的操作则是纯确定性 action。产物采用**双表征**（P11）：agent 视图（纯文本，schema 可校验）入 `tracker_sprint_artifacts`（版本化、producedByKind、supersedes 链，签核判据锚定此版本），human 视图由确定性发布管道渲染到 content 项目文档库的对应位置（富 block 呈现，见 05 章第 5 节），`contentRef` 指向 content 页——agent 永远只读 tracker 版纯文本。human 产物受保护——agent 想改人定稿的文档必须走审批出新版本。低摩擦保底（P12）：每一步都可跳过技能访谈，手工导入现成文档直接定稿为产物。

<table header-row="true">
<tr>
<td>技能或 action</td>
<td>产物 docKey</td>
<td>交互形态（由 03 章规划工作台承载）</td>
<td>关键质量门</td>
</tr>
<tr>
<td>`/brainstorm`（**可选**）</td>
<td>brainstorm-notes</td>
<td>InterviewCard 决策树：一次一问、每问先给推荐答案；四种开场（问题、半成形想法、开放问题、约束）。**可整步跳过**直接 `/sprint-plan`，或导入现成笔记为产物</td>
<td>可证伪门（说不出检验的想法淘汰）；锚定单一方案时强制再出两个</td>
</tr>
<tr>
<td>`/sprint-plan`</td>
<td>sprint-doc</td>
<td>完整访谈，或从 brainstorm 综合（先给草稿只问缺口）；结束时整块揭示定稿</td>
<td>P0 删除测试（砍掉它目标还成立就不是 P0）；Leading 加 Lagging 可证伪指标（**每条带稳定编号 M1/M2…**，Goal 链全程以编号对齐：覆盖矩阵、audit metrics[].id、Goal 卡）；文档不含文件路径与代码——what/why 与 where/how 分离；每条 In-Scope outcome 标注是否含 ui 面——该标注写入 sprint-doc，是 designing 相位是否激活 ui track 与 ui-signoff 门的依据</td>
</tr>
<tr>
<td>`/sprint-test-plan`</td>
<td>test-plan</td>
<td>场景卡片流：每场景 Why、Repos、Steps、Expected、Pass-fail 信号、执行工具、**关联指标（M 编号）**；可选 journey 节；无跨模块时一段式"无集成场景"。覆盖矩阵与旅程图由关联指标与 journey 节**确定性渲染**（发布管道不做判断）</td>
<td>按用户目标一场景而非按代码路径；黑盒；信号可证伪</td>
</tr>
<tr>
<td>`/ui-spec`（新增）</td>
<td>ui-spec</td>
<td>屏清单访谈加逐屏规格卡，详见 05 章</td>
<td>每屏有目标、主操作、数据状态；每条 In-Scope outcome 至少映射一屏或显式声明"无界面"</td>
</tr>
<tr>
<td>`/sprint-design`</td>
<td>technical-design</td>
<td>四阶段：读产物、深读真实代码（经 orchestrator 只读检出）、写设计、自审</td>
<td>每工作项一个小节；引用的文件路径必须真实存在；五列文件变更矩阵机器可解析；每个测试场景与 ui-spec 屏有实现路径</td>
</tr>
<tr>
<td>`/sprint-review`</td>
<td>technical-design 新版本</td>
<td>多轮对抗评审：经 orchestrator spawnOnce 起 vLLM 与 sonnet 交替轮，每轮新 agent 携带累计已发现清单防重复；产出轮次报告表</td>
<td>只收高置信新发现；有效发现逐条修订进新版本（supersedes 链）</td>
</tr>
<tr>
<td>`extract-briefs`（action）</td>
<td>brief:`{itemKey}`、shared-brief、briefs-index</td>
<td>一键执行加结果摘要（briefs 数、缺失项、依赖清单）</td>
<td>移植 extract_briefs.py 全算法（§2/§4/§5 数据模型/§6 API 表/§8 Testing Strategy/Env Vars + CREATE 引用与 API 生产-消费双通道依赖推导）；幂等；对拍验收；ui-spec 屏摘要注入对应 brief</td>
</tr>
</table>

Epic 拆解刻意不做成技能：`decompose-epic` action 只接受**人写好的子项清单**（title、repo、dependsOn、touches），系统做格式校验与依赖图校验（三色 DFS 判环，链深超过 3、全线性、孤儿项告警）。这是产品立场：人画边界，工具校验，系统执行。

## 3. 执行域工作流族（orchestrator V3 模板）

为什么是"族"而不是一条流水线：一行文案的改动不应该被迫走七个阶段。九个版本化 DAG 模板作为**种子模板**随应用发布（解决现状库中无种子的缺口），`workflowSave` 自动增版，可在页面可视化编辑——工作流即数据，改流程不改代码。

所有模板的共同约束：

- worker 节点禁用 claude-code 引擎覆盖——CC 订阅只属于 brain；评审与守门类节点按模板配置用 sonnet 档 API 或 vLLM。
- 判断类节点必须声明 `output_schema`（Ajv 强制校验加一次纠偏重询），自由文本裁决无效。
- **评审独立性（v2.2，自举簇八）**：reviewer 与 gatekeeper 会话必须独立于 spec 作者——新会话或独立 agent，输入是需求原文加 spec 加 diff，且明确要求对抗性质疑 **spec 本身的设计决定**（事务性、批量化、异常处理、N+1），不只对照实现偏离。依据：自举质量调研中 brain 自审自写 spec 的 diff 零命中，而审他人代码抓出 5 个真 bug 含 critical——能力在，结构错。
- 每个节点声明 retry 策略（transient 自动重试）与 timeout。
- run tags 全链路携带 `source`、`sprint_id`、`item_id`、`ownerEmail`、`orgId`，回写通道据此铸造身份。

**载荷契约表**（P3 的精确化，取代笼统「白名单」）：

<table header-row="true">
<tr>
<td>工作流</td>
<td>允许注入的载荷</td>
<td>永远禁止</td>
</tr>
<tr>
<td>issue-pipeline / quick-task / hotfix</td>
<td>brief:{item} + shared-brief + ui-spec 屏摘要</td>
<td>technical-design 全文、sprint-doc 全文、他项 brief</td>
</tr>
<tr>
<td>sdlc-verify</td>
<td>上行 + **test-plan 场景节**（结构化提取）</td>
<td>同上</td>
</tr>
<tr>
<td>sdlc-gap-analysis</td>
<td>**goal-metrics 节**（sprint-doc 的 Goal 与编号指标，确定性提取）+ 跨仓 diff + 验证日志</td>
<td>technical-design、issue 清单</td>
</tr>
<tr>
<td>sdlc-ui-build</td>
<td>ui-spec 全文 + designSystemId</td>
<td>其余产物</td>
</tr>
</table>

### 3.1 sdlc-issue-pipeline：单工作项实施流水线（核心）

适用：executing 相位内每个开发类工作项一个 run。

<Mermaid id="wf02-issue-pipeline" source={"flowchart LR\n  ws[workspace 基于 sprint 分支] --> dev[dev vLLM TDD 红测试先行]\n  dev --> qa[qa vLLM 双工件]\n  qa -->|失败| dev\n  qa --> rv[review 交替模型 最多3轮]\n  rv -->|驳回| dev\n  rv -->|超限| hg[human_gate 升级]\n  rv --> gate[gate 按 gateMode 实测]\n  gate -->|失败| dev\n  gate --> da[diff-audit 确定性防污染]\n  da -->|越界| dev\n  da --> pr[commit 与 PR]\n  pr --> ci[ci-watch]\n  ci --> mg[merge 顺序锁]\n  mg -->|断言失败 rebase 重验| qa\n  mg --> wb[终态回写 tracker]"} />

节点要点：

- dev（vLLM 默认，按仓 devModel 可切 sonnet）：TDD 纪律——先提交红测试再实现，提交顺序由 git log 可验证。
- qa（vLLM）：双工件零重叠——CI 跑的 E2E 测试加守门实测用的集成用例。
- review（不超过 3 轮，sonnet 与 vLLM 交替，携带累计发现清单）：只审 diff 不审全树；越界文件等于自动 FAILED；超限自动升级 human_gate 并在 tracker 出 escalation 审批单。
- gate（sonnet）：按 `project_repos.gateMode` 三档——stack 起栈实测、tests-only 全量测试加严格 diff 审查、none 跳过；绝不静默降级为纯代码分析。
- diff-audit（确定性节点）：变更文件必须落在 brief 的 touches 白名单内，越界回 dev——对应原流程的防污染审计。
- merge（顺序锁）：断言 merge-base 等于 sprint 分支 tip；不满足则回 dev rebase，且 rebase 后必须重跑 qa、reviewer、gatekeeper——rebase 可能改变语义，这是 v1.1 继承的重验回路。

UI 类工作项附加：dev 节点 prompt 注入对应 ui-spec 屏规格与原型深链；gate 的 stack 档附带按 ui-spec 主流程截图证据。

### 3.2 sdlc-verify：Sprint 集成验证

节点流：各仓全量测试（parallel_over）· 集成场景逐个真实执行（不因首败中断，结构化 PASS/FAIL 加证据）· 失败则经回写通道自动建 from-audit 单（targetBranch 指向当前 sprint 分支，`/draft-fix-issue` 生成单体：Trigger、What's broken、Suspected boundary、Brief）· 修复单自动进派发。无集成场景的 sprint 全绿即 GREEN。

### 3.3 sdlc-gap-analysis：目标审计 / gap-analysis（反奉承）

即原流程的 **Phase H gap-analysis**——晋升合入 base 前的最后一道闸；判定基准是 **sprint-doc 定下的 Goal 与可证伪成功指标**，不是「单子是否关完」。输入只有 sprint Goal 与成功指标、跨仓 diff、验证日志——**不含 issue 清单与设计文档**，审计者以"有理由怀疑的外部审计人"人格工作，防止照单宣称完成。output_schema 强制每条 metric 带 **id（=sprint-doc 的 M 编号）**与证据且证据必须匹配 `repo:file[:line]`、`PR#n`、sha、`absence-of:<pattern>` 之一，"done、implemented"类字样直接拒收；NO_GAPS 不得与任何 P0 未达并存；用户可感能力必须有真实非种子输入的运行证据，仅演示等于 PARTIAL 加 blocking。轮次产物 audit-report 按轮持久化；blocking 自动建 from-audit 单；3 轮超限升级 escalation 或 audit-deferral 由人裁决。

### 3.4 sdlc-promote：晋升

依赖拓扑序逐仓执行：领先提交数为零则跳过（幂等）· sprint 收尾 PR · ci-watch · merge-pr 用 **merge-commit** 保留 sprint 边界（回滚时单个 revert 即可撤销整个 sprint）· 全部晋升后删除 sprint 分支。

### 3.5 sdlc-ui-build：UI 原型流水线（新增）

适用：designing 相位 UI track；输入是已定稿 ui-spec 与 designSystemId。节点流：spec-parse（确定性，拆屏清单）· screen-gen（parallel_over 逐屏，vLLM 按 Foundry 设计系统生成自包含 HTML）· ds-lint（确定性：token 存在性、禁 emoji 图标、data-screen 链接完整性）· consistency-review（sonnet 带 output_schema：跨屏导航、状态、术语一致性）· publish（确定性：create-design 加 create-file 入库 design，回写 tracker 产物 ui-prototype，contentRef 指向 design id）。

失败路由：ds-lint 违规屏定点重生成（loop 不超过 2）。consistency-review 的 output_schema 为 `findings[]`，每条含 screen、kind（nav、state、term、copy）、severity（blocking 或 advisory）、detail、suggestion；**blocking 判据 = 会导致用户流程断裂或跨屏语义冲突**（导航目标缺失、同一操作两屏文案相反等）——blocking 以批注写回 ui-spec 待人处理，advisory 仅记录。

### 3.6 quick-task：快速任务（短流程）

适用：单工作项、无 sprint 编排的小改动（executionMode 为 auto 且类型为任务，或人工选择）。跳过规划与设计相位，`plannedStages` 为「实施 · 测试」。节点流：workspace 基于 base 分支 · dev（vLLM）· qa（vLLM）· review（sonnet 一轮）· commit 与 PR · ci-watch · 合并按项目配置（人工或自动）。

### 3.7 hotfix：缺陷热修

适用：类型为缺陷或生产问题。红测试优先纪律强化：reproduce（vLLM，先写复现失败测试，必须先红并附失败输出证据）· fix（vLLM 或 sonnet 按严重度）· regression（全量测试）· review（sonnet 一轮）· commit 与 PR · ci-watch · merge。

### 3.8 docs-task：文档任务

节点流：draft（vLLM，读代码与产物起草）· review（sonnet，output_schema 事实核查清单）· publish（确定性，content 应用 create-document 或 edit-document，遵守 NFM 约束）。

### 3.9 spike-research：调研任务

节点流：explore（sonnet 或 vLLM，只读 workspace）· report（output_schema：结论、证据、选项对比、建议）· 产物入 tracker（docKey 为 spike-report），无代码合入。

### 3.10 工作流选择器

**拆分契约（决策序之前的前置检查，v2.2 自举簇九）**：spec 或 brief 涉及超过 6 个文件、或跨生命周期协同（schema 加 action 加页面加调度器联动）→ 拒绝单节点派发，强制拆为多个 dev 子任务，规划工作台给规模告警与一键拆分；执行期 vLLM 单节点输出预算耗尽两次及以上自动定性"规模超标"回规划拆分，不换更大模型硬扛。依据：1–6 文件级 spec 下 vLLM 一次交付扎实，12 文件级连续预算耗尽且 brain 被迫代写。

规则按**决策序**匹配，命中即停（高优先级在前）：

1. 人工覆盖（派发面板显式选模板）。
2. from-audit 单：一律走 **issue-pipeline 的命名预设 `mode=fix`**（模板库中显示为 issue-pipeline 卡内的预设、随模板版本化）——节点形态复用 hotfix（reproduce、fix、regression、reviewer），工作区基于且合回 `targetBranch`（当前 sprint 分支），不走独立 hotfix 模板、不基于 base 分支。
3. 类型专用模板：缺陷与生产问题走 hotfix（若该缺陷隶属派发窗口内的 sprint，则同样以 sprint 分支为基并合回 sprint 分支）；文档走 docs-task；调研走 spike-research。
4. sprint 归属：派发窗口内（executing 至 auditing）sprint 的开发项走 sdlc-issue-pipeline，继承 sprint 分支；**非派发窗口相位的 sprint 内工作项不派发**，在队列中显示"等待相位"。
5. 无 sprint 且 executionMode 为 auto：quick-task。

下表为各规则的输入与说明：

<table header-row="true">
<tr>
<td>输入</td>
<td>规则</td>
</tr>
<tr>
<td>工作项类型</td>
<td>缺陷与生产问题走 hotfix（sprint 内则基于 sprint 分支）；文档走 docs-task；调研走 spike-research；from-audit 见决策序第 2 条</td>
</tr>
<tr>
<td>所属 sprint</td>
<td>派发窗口内 sprint 的开发项走 sdlc-issue-pipeline，继承 sprint 分支；窗口外等待相位</td>
</tr>
<tr>
<td>无 sprint 且 auto</td>
<td>quick-task</td>
</tr>
<tr>
<td>项目配置</td>
<td>项目设置可改"类型到工作流"映射与各模板默认参数（模型档、评审轮数、gateMode）</td>
</tr>
<tr>
<td>人工覆盖</td>
<td>派发面板可显式选任一模板并覆盖 inputs</td>
</tr>
<tr>
<td>brain 建议</td>
<td>brain 派发前可建议换模板（如 quick-task 项涉及三个模块时建议升级 issue-pipeline），建议以待确认卡片呈现，不自动改</td>
</tr>
</table>

## 4. 可恢复与重试语义（homerail 移植到 V3）

homerail 的核心启示：**用事件溯源重建状态，用有界自愈代替无限自旋，用降级代替悬挂**。V3 已有 advisory-lock tick、错误四分类（transient、schema-violation、permanent、cancelled）、schema 一次纠偏、patch 未来与 fork 过去、幂等事件、spawn_events 溯源。v2.0 在其上补八条增强，每条都有明确的 UI 呈现点——可恢复性必须可观察。**现状标注**：R2/R3/R5/R6 部分已有（reconcile-on-startup、loop 上限与 schema 纠偏、currentSpawnId 列、节点级 maxIterations 均已在引擎），R1/R4/R7/R8 为新增（R1 需 v3_spawns 加心跳列，见 04 章增量表）：

<table header-row="true">
<tr>
<td>编号</td>
<td>语义</td>
<td>设计</td>
<td>UI 呈现</td>
</tr>
<tr>
<td>R1</td>
<td>孤儿运行降级</td>
<td>进程重启时仍 running 且 spawn 无心跳的节点转 failed（node lost: restart），走失败路由而非悬挂</td>
<td>运行详情节点卡显示"进程重启降级"事件</td>
</tr>
<tr>
<td>R2</td>
<td>事件溯源恢复</td>
<td>启动时以 v3_events 与节点终态重建调度状态；DB 权威、日志尽力</td>
<td>健康页显示"上次恢复复原 N run"</td>
</tr>
<tr>
<td>R3</td>
<td>有界纠偏</td>
<td>schema 纠偏 1 次、评审最多 3 轮、审计最多 3 轮、run 级 spawn 上限；耗尽升级而非静默</td>
<td>节点卡 attempt 计数；超限自动出审批单</td>
</tr>
<tr>
<td>R4</td>
<td>检查点重试</td>
<td>nodeRetry 支持从上次成功产物续跑：fork spawn transcript、新 spawnId、attempt 递增、父链保留</td>
<td>NodeInspector 的 attempt 时间线，可从任一 attempt 重试</td>
</tr>
<tr>
<td>R5</td>
<td>过期栅栏</td>
<td>node 当前 spawnId 不匹配的 spawn 事件一律丢弃，fork 与重试后防竞态</td>
<td>无（纯内核语义）</td>
</tr>
<tr>
<td>R6</td>
<td>失控上限</td>
<td>run 级最大派发数、最大节点迭代数显式配置于模板，超限 abort 并留事件</td>
<td>模板编辑器暴露上限字段</td>
</tr>
<tr>
<td>R7</td>
<td>首目标就绪门</td>
<td>恢复后的 ready 节点等 vLLM 与 CC 健康检查通过再派发</td>
<td>健康页与 run 事件"等待运行时恢复"</td>
</tr>
<tr>
<td>R8</td>
<td>scorecard 归因</td>
<td>run 终态自动评分（pass 或 needs-attention），失败按 prompt、tool、engine、template、harness 五层归因并给 next_steps</td>
<td>洞察页归因面板</td>
</tr>
<tr>
<td>R9</td>
<td>spawn 终态传导不变量（v2.2）</td>
<td>不存在 spawn 已终态而其 node 仍 running 超过一个 tick——spawn 的任何终态来源（正常结束、心跳超时、reconcile 重置、人工取消）都必须在同一事务内驱动 node 状态迁移；违反由 reconciler 断言修正并发告警事件。runCancel 幂等且成功必须返回成功（SDLC-050）</td>
<td>运行详情节点卡"传导修正"事件；健康页计数</td>
</tr>
</table>

### 4.1 执行器上下文契约（v2.2，自举簇十）

worker 引擎此前是裸循环：消息只增不减（每次读取的文件全文、每轮思考 token 全部滞留窗口），溢出物理窗口即截断失败，且重试从零重跑同一任务——确定性再溢出。brain 有自动压缩而 worker 没有；上下文是 worker 最稀缺的资源，必须有生命周期管理：

<table header-row="true">
<tr>
<td>#</td>
<td>契约</td>
<td>说明</td>
</tr>
<tr>
<td>C1</td>
<td>工具结果窗口化</td>
<td>读取按需截取（行区间、符号级），大结果只保留头尾加摘要；同文件重复读取返回增量</td>
</tr>
<tr>
<td>C2</td>
<td>超阈自动折叠</td>
<td>窗口占用超阈值时把已完成步骤的工具往返折叠为结构化摘要（保留决策与产物清单），继续执行而非等死</td>
</tr>
<tr>
<td>C3</td>
<td>截断续写</td>
<td>截断或溢出失败的重试 = 携带已完成产物续写（已写文件清单加剩余任务作为新起点），禁止从零重跑</td>
</tr>
<tr>
<td>C4</td>
<td>与拆分契约互补</td>
<td>拆分契约在规划期降低上下文需求；本契约在执行期保底——两者缺一不可</td>
</tr>
</table>

## 5. Brain 可替换架构

### 5.1 引擎注册表

"brain 可替换"不能停留在口号：引擎是配置数据（`brain_engines` 表或等价配置），不是代码里的 if 分支。今天两个引擎（claude-code、sdk-vllm），未来任何 ACP agent 满足契约即可接入。

<table header-row="true">
<tr>
<td>字段</td>
<td>说明</td>
</tr>
<tr>
<td>id 与 name</td>
<td>claude-code、sdk-vllm、acp 前缀的 agent 等</td>
</tr>
<tr>
<td>kind</td>
<td>cli-resume（CC 式可恢复子进程会话）、sdk（AI-SDK 循环）、acp（ACP 协议 agent）</td>
</tr>
<tr>
<td>modelRef 与 tier</td>
<td>引擎默认模型与允许档位</td>
</tr>
<tr>
<td>health</td>
<td>登录态与端点可达性的探测方式</td>
</tr>
<tr>
<td>capabilities</td>
<td>是否支持 resume、上下文窗口上报、usage 上报</td>
</tr>
</table>

引擎契约：`startTurn(threadId, message, cwd, mcpConfig)` 非阻塞开启一轮；轮内事件持久化到 brain_events；会话可恢复（session 标识持久化）；被唤醒（run 或节点终态、周期漂移）时以一条消息恢复。MCP 工具面（orchestrator 全 action 目录加 JWT）对所有引擎一致——这保证换引擎不换能力面。

### 5.2 选择与降级

- 线程级选择：新建线程可选引擎（默认取全局默认）；运行中不可换，可 fork 新线程换引擎接管。
- 自动降级：默认引擎不健康（CC 未登录或探测失败）时新任务落到兜底引擎 sdk-vllm，UI 明示"当前以兜底引擎运行"而非静默。
- 现状的双 BRAIN_PROMPT 漂移收敛为单一出处，引擎按 kind 拼装差异段。

### 5.3 Brain 的职责边界

brain 只做：接收派发、按 runbook 选模板或 authoring DAG、发起 workflowRun、被唤醒时 review 与汇报、commit 与 PR 的叙述。brain 不做：状态推进（归回写通道）、代码直改（归 DAG 工人）、需求自动拆解（归人）。brain 的全部代码变更必须经 workflowRun 的 DAG（vLLM develop 节点）——这条纪律以可观察指标呈现在 Brain 控制台：workflowRun 调用数、vLLM 工人 token 增量、直改文件告警数。自举实战（SDLC-052）证明**提示词红线拦不住任何一步**——红线必须由下面的能力面矩阵机制背书（P13），控制台指标只是证据不是约束。

### 5.4 能力面矩阵（角色 × 相位 → 机制化能力，v2.2）

每个角色在每个相位的工具面与文件系统权限是**引擎配置**，不是提示词承诺。越界操作机制上不可为；配置漏洞导致的越界由审计告警兜底（发生即可见）。

<table header-row="true">
<tr>
<td>角色</td>
<td>相位或节点</td>
<td>workspace 权限</td>
<td>工具面</td>
<td>说明</td>
</tr>
<tr>
<td>brain</td>
<td>分析、派发</td>
<td>只读</td>
<td>MCP 全目录加只读文件工具；无写类工具，Bash 白名单只读命令</td>
<td>深读代码写 spec 允许；写文件不可为</td>
</tr>
<tr>
<td>brain</td>
<td>评审（run 终态唤醒）</td>
<td>只读挂载</td>
<td>同上加 workspaceDiff、nodeSummary</td>
<td>发现问题→重派 dev 节点 fix 模式（携带评审发现清单），不亲手修</td>
</tr>
<tr>
<td>dev、qa（vLLM）</td>
<td>develop、qa 节点</td>
<td>读写（本 workspace）</td>
<td>读写文件加测试执行（依赖工作区契约供给）</td>
<td>唯一合法代码作者</td>
</tr>
<tr>
<td>reviewer、gatekeeper</td>
<td>评审、守门节点</td>
<td>只读</td>
<td>只读加测试执行</td>
<td>产出结构化 verdict，不改代码；会话独立于 spec 作者（评审独立性）</td>
</tr>
<tr>
<td>action 节点</td>
<td>确定性步骤</td>
<td>按 action 声明</td>
<td>无 LLM</td>
<td>diff-audit、ci-watch、merge-pr 等</td>
</tr>
<tr>
<td>人</td>
<td>任意</td>
<td>完全</td>
<td>页面加受守卫 action</td>
<td>人工完成逃生口带证据（P12）</td>
</tr>
</table>


## 6. 回写通道与健康前置门

<Mermaid id="wf02-writeback" source={"flowchart TD\n  rt[run 或节点终态] --> rc[reconciler 确定性回写 主通道]\n  rc --> tc[tracker-client 以 run tags 身份铸 JWT]\n  tc --> ad[tracker advance-stage 幂等推进]\n  rt -.兜底.-> gp[get-activity 轮询]\n  gp --> ad\n  rt -.叙述.-> br[brain 被唤醒 review 汇报 不推状态]"} />

- 三层通道的分工：确定性回写是主链路（不依赖 LLM 主动性）；轮询是兜底；brain 只做叙述。幂等 advance 保证双通道并存不重复推进。
- 健康前置门：sprint 进 executing、以及每次派发前，确定性检查 vLLM、CC 登录、brain 并发槽。人工与常规派发不健康时**立即拒绝**并把原因写到 sprint 页与队列页——是门口的拒绝，不是深处的超时；**系统内生的修复派发（from-audit 回环）改为排队等待恢复**，避免修复链因瞬时不健康断裂（与 1.3 节一致）。
- 可观察性：tracker 队列页记录每次派发的健康检查；orchestrator 健康页显示门的当前状态与最近拒绝；工作项活动流标注回写来源（reconciler 或轮询）。

## 7. 工作区契约（v2.2，自举簇一）

"工作区"是 dev、qa、reviewer 的全部世界，因此是有供给规范与验收条件的一等对象，不是 workspaceCreate 的实现细节。**就绪不变量**（三条全过才算 ready；任何一条不满足 = infra 故障，run 不得开始，不记为 agent 失败）：

<table header-row="true">
<tr>
<td>#</td>
<td>不变量</td>
<td>断言方式</td>
<td>对应自举问题</td>
</tr>
<tr>
<td>W1</td>
<td>基线新鲜：workspace.base 等于镜像目标分支在派发时刻的 tip</td>
<td>workspaceCreate 后即断言；克隆缓存或池化工作区必须先 fetch 加 reset</td>
<td>SDLC-056：3 天旧基线造成本可避免冲突</td>
</tr>
<tr>
<td>W2</td>
<td>依赖已预热：node_modules 可用（共享 pnpm store 硬链，秒级），节点内不需要也不允许装依赖</td>
<td>供给管道完成安装；develop 提示词维持"禁止装依赖"——职责归供给，不归 agent</td>
<td>SDLC-057；B1 中 brain 曾替 dev 装依赖 48 次 Bash</td>
</tr>
<tr>
<td>W3</td>
<td>测试可执行：test_cmd_smoke 通过</td>
<td>就绪探测的一部分</td>
<td>SDLC-057：dev 自述"环境无 vitest"，TDD 纸上谈兵</td>
</tr>
</table>

存续期规则：run 存活期间镜像目标分支前进 → run 收到 staleness 事件，交付节点前置断言 merge-base 等于目标分支 tip，不满足走 rebase 检查回环；**观测基线正确性（W4，v2.2.1，SDLC-059）**——workspaceDiff 等对比类工具的基线必须在调用时动态求 merge-base（HEAD 对镜像目标分支 tip），禁止用创建时记录的静态基线（B4 实测产出 2.3MB/221 文件的误导 diff），基线不可得返回显式错误，观测错=守门错；develop 与 qa 节点交付必须附**测试执行证据工件**（命令、输出、退出码），"测试不可执行"不是可接受的交付说明（W3 保证它不会发生），**涉及 schema 变更的交付必须含迁移冒烟档（v2.2.1，SDLC-061）**——对空库执行全部迁移后断言各表存在，自建 schema 的内存库测试不构成建表证据（B5 实测测试全绿而生产迁移缺失）。质量调研佐证：B3 在补齐环境后 311 测全绿一次通过。

## 8. 状态迁移守卫（v2.2，自举簇三与簇七）

门判据之下的更基础层：**每个状态迁移允许谁写、必须带什么证据**。守卫在 action 层强制（写入方身份来自 JWT 与 run tags），页面与 agent 走同一守卫。

<table header-row="true">
<tr>
<td>迁移</td>
<td>合法写入方</td>
<td>必需证据载荷</td>
<td>失败行为</td>
</tr>
<tr>
<td>派发（待办→实施）</td>
<td>仅记 execState=dispatched，业务阶段不因派发而推进（v2.2.1，SDLC-063）</td>
<td>threadId（runId 到位后补）</td>
<td>brain 首轮零交付失败 → execState 回 queued 加审计事件；业务阶段无需回退——阶段推进统一由交付证据驱动</td>
</tr>
<tr>
<td>实施→测试</td>
<td>回写通道（reconciler 或轮询，expectedRunId 断言）</td>
<td>runId、branch、测试执行证据引用</td>
<td>断言不符 no-op（幂等）</td>
</tr>
<tr>
<td>→待人工评审</td>
<td>回写通道（run 终态且交付分支存在）</td>
<td>runId、branch、diff 统计、测试证据</td>
<td>缺证据走失败路由，不得静默 done</td>
</tr>
<tr>
<td>待人工评审→done</td>
<td>仅人（收件箱评审卡或工作项页），或带 PASSED verdict 的 gap-analysis 记录</td>
<td>评审 verdict 加合并 commit</td>
<td>agent 写 done 一律拒绝（SDLC-056 的机制性回答）</td>
</tr>
<tr>
<td>人工完成（任意→交付）</td>
<td>仅人</td>
<td>PR 或 commit 链接（存在性校验）</td>
<td>无证据拒绝（P12 逃生口仍有底线）</td>
</tr>
<tr>
<td>关闭（未派发项）</td>
<td>仅人（受守卫 close，强制 reason）</td>
<td>reason 文本</td>
<td>写审计；agent 不可关闭</td>
</tr>
<tr>
<td>回链更新</td>
<td>与状态迁移同事务</td>
<td>orchestrator_run_id 与 branch 为迁移必填载荷；重派等于新迁移等于同步更新</td>
<td>缺载荷拒绝（SDLC-053）</td>
</tr>
</table>

**标识分配权威（簇七）**：一切全局单调标识（itemKey、迁移版本号）必须单点分配——itemKey 由 tracker 项目级序列器在 create 时分配（DB 序列或 advisory lock，调用方不报数）；迁移以内容哈希加命名空间登记身份，数字序仅在合并线性化时单点重排；撞号在分配时失败出声，禁止静默跳过（SDLC-037/038——后者在本章写作当天以"两个 SDLC-056"再次复发）。

## 9. tracker 依赖感知调度器（确定性）

- exec_queue 升级为真正的调度器：blocked-by 全部"实施完成（已合入 sprint 分支）"才可派发；每次实施完成事件重新评估解锁项，自动派发，无人工触发。
- 队列顺序等于 priority 加人工置顶（持久化）；同分支合并由 merge 顺序锁保证串行，调度器不并发派发互相依赖的项。
- 每次派发过健康门与载荷契约检查（按 3 节契约表：工人=brief、shared-brief、ui-spec 摘要；verify/gap-analysis 各有登记的追加节）。
- 暂停与恢复是真实的调度器开关，全局与按 sprint 两级。

---

<callout color="red_bg">
	流程红线清单（系统化编码，任何模块不得绕过）：
	- 人拆解：epic 拆解只接受人写的子项清单，全系统不存在 AI 自动拆解入口。
	- brief 隔离：派发载荷白名单只有 brief、shared-brief、ui-spec 摘要；sprint-doc 与 technical-design 全文永不注入工人。
	- CC 只属 brain：worker 节点禁用 claude-code 引擎；CC 订阅不用于自动化轮询。
	- 顺序合并：merge 按目标分支全局串行；merge-base 断言失败必须 rebase 后重验 qa、reviewer、gatekeeper。
	- CI 不可绕过：merge 无 force 参数；跳过 CI 必须来自仓库显式 ciMode 配置。
	- 人写产物保护：human 产物的新版本必须带 supersedes 并经审批。
	- 升级而非自旋：评审 3 轮、审计 3 轮硬上限，超限自动出审批单，绝无第 4 轮。
	- 证据 schema：验证与审计节点必须声明 output_schema，自由文本裁决无效。
	- 健康前置门：人工与常规派发不健康即拒绝并显式呈现原因，绝不静默降级；系统内生修复派发排队等待恢复（唯一例外，见 1.3 节）。
</callout>
- **登记的引擎增量：`action` 确定性节点类型**——diff-audit、ci-watch、merge-pr、spec-parse、ds-lint、publish 这些非 LLM 步骤以 action 节点承载（引用 action 名 + inputs 映射，reconciler 直接执行、无 spawn）；ciWatch 与 mergePr 能力原语承 v1.1 M3 既定交付。现有 engine_override 禁用在 dag-validator 层强制。
