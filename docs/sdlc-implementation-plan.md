# SDLC 系统化 — 分阶段实施规划与验收基准

> 本文档是 `docs/sdlc-system-design.md`(设计 v1.1)的实施基准:每阶段的交付物清单、
> **可由 agent 直接执行的验收场景**(步骤 + 预期结果)、二值化通过标准,
> 以及最终的端到端验收剧本。
>
> 使用方式:实施 agent 按"交付物清单"开发;验收 agent 按"验收场景"逐条执行并逐条记录
> PASS/FAIL 与证据;**全部场景 PASS 且通过标准全勾 = 该阶段完成**。

---

## 0. 验收总纪律与环境基线

### 0.1 纪律(不可违背)

1. **只允许通过页面(Playwright 真实浏览器操作)或 action HTTP 接口验收,禁止执行任何 SQL**。
   SQL 只允许用于"验收后交叉核对"性质的只读检查,且不得作为通过依据。
2. 每个场景必须记录:执行时间、操作步骤实录、**预期 vs 实际**、证据
   (页面截图 / action 响应体 / git log 输出)。任何一步实际与预期不符 = 该场景 FAIL,不允许"大致相符"。
3. 验收使用**全新注册的测试账号**(每轮验收新建),不复用开发期账号,防状态残留假阳性。
4. 页面验收必须包含**刷新后复查**:操作完成后刷新页面,确认状态持久化而非仅前端乐观更新。
5. 发现 FAIL:先在失败点截图留证,再修复,修复后**该阶段全部场景重跑**(不只重跑失败项)。

### 0.2 环境基线(每轮验收前置检查)

| 检查项 | 方法 | 预期 |
|---|---|---|
| tracker 可用 | 打开 `http://192.168.1.101/tracker/` | 登录页或看板正常渲染 |
| orchestrator 可用 | 打开 `http://192.168.1.101/orchestrator/` | 首页正常渲染 |
| vLLM 健康 | `GET http://192.168.1.250:9000/v1/models` | 200,模型列表含 qwen3.6/claude-sonnet-4-6 |
| CC 登录 | orchestrator 设置页 Claude Code 状态 | 已连接 |
| A2A 互通 | tracker 任一工作项页点「派发」(冒烟) | 不报连接类错误 |

### 0.3 靶仓(playground,M3 起全部执行域验收的标的)

在 101 上 orchestrator 容器可见的卷内创建 bare 仓 `demo-app.git`(建议路径
`/home/claudeuser/agent-native/workspaces-seed/demo-app.git`,容器内经卷映射可达):

- **形态**:Node 小服务。`src/calc.js`(add/mul 纯函数)、`src/report.js`(**依赖 calc 的签名**,
  这是埋缺陷的断裂点)、`src/server.js`(HTTP:`/calc?a=&b=`、`/report`)、
  `test/` 全量单测,`npm test` 可跑(vitest 或 node:test,无外网依赖)。
- **注册参数**:`ciMode=none`、`gateMode=tests-only`、`testCmdFull="npm test"`、`baseBranch=main`。
- **配套剧本文件**(与靶仓一起交付,验收 agent 直接取用):
  - 种子需求 R1「新增 /health 端点返回 `{status:'ok',uptime}`」(独立,无依赖);
  - 种子需求 R2「calc 增加 pow 函数」+ R3「report 输出 pow 汇总」(R3 blocked-by R2,构成依赖链);
  - 埋缺陷需求 RX「重构 calc.add 签名为 add({a,b})」——**故意不改 report.js**,
    单测(只测 calc)全绿但 report 集成断裂,专用于触发 verify FAIL → from-audit 回环。

---

## M1 — Tracker 流程地基(~1 周)

### M1.1 交付物清单

| # | 类型 | 名称 | 说明 |
|---|---|---|---|
| 1 | 表 | `project_repos` | name/gitRemote/baseBranch/testCmdUnit/testCmdFull/e2eTestPath/integrationTestPath/buildTool/ciMode/gateMode/devModel |
| 2 | 表 | `tracker_sprint_artifacts` | sprintId/docKey/kind/name/version/supersedes/producedByKind/content/contentRef |
| 3 | 表 | `tracker_approvals` | sprintId/workItemId?/gateKey/gateRef?/status/requestedBy/decidedBy/reason/decidedAt |
| 4 | 列 | work_items + repoName/targetBranch/escalatedAt/escalationReason;sprints + phase/executorThreadId | 可加性迁移 |
| 5 | action | `manage-project-repos`(增删改查) | 项目设置页仓库管理接真 |
| 6 | action | `create-sprint-artifact` / `list-sprint-artifacts` / `get-sprint-artifact` | 含 human 产物保护(3.7-5,M2 强化) |
| 7 | action | `validate-dependency-graph(sprintId\|epicId)` | 三色 DFS 判环 + 深度>3 / 全线性≥3 / 孤儿 告警;返回 `{errors[],warnings[],topoOrder[]}` |
| 8 | action | `advance-stage(scope:'item'\|'sprint', id, fromStage, expectedRunId?)` | 幂等 + 前置断言 + **项目级 gate 判据 JSON 配置** + plannedStages 类型子集 + 看板列联动 |
| 9 | action | `request-approval` / `approve-gate` / `reject-gate` / `list-approvals` | 审批门落地(队列页 UI 空壳接真);approve 时若有 gateRef 则回调 orchestrator nodeResolveGate(M4 联通,M1 先留桩并记录) |
| 10 | action | epic 支持:work_item `type=epic` + `decompose-epic`(接受人写子项清单:title/repoName/dependsOn,校验+批量建子项+建 child-of/blocked-by links) | **无 AI 自动拆解入口** |
| 11 | 页面 | epic 详情:子项树 + 依赖关系 + 图校验按钮;项目设置:仓库管理;sprint 详情:产物区 + 审批区 + phase 展示 | |
| 12 | 约束 | 单活跃 executing sprint 断言;rollback-stage 绑定非终态 run 时拒绝;priority 语义统一(1=P0..4=P3,建单/看板/文档三处一致) | |

### M1.2 验收场景

**M1-S1 项目与仓库注册**
前置:新测试账号登录 tracker。
步骤:① 项目页新建项目 `SDLC演示`(key 自动生成);② 项目设置页添加仓库
`demo-app`(gitRemote 填靶仓路径、baseBranch=main、testCmdFull=`npm test`、ciMode=none、gateMode=tests-only);
③ 刷新页面。
预期:仓库列表显示 demo-app 全部字段;刷新后仍在;编辑 devModel 为 sonnet 再改回空,均生效。

**M1-S2 Sprint 与产物区**
步骤:① sprint 页新建 `Sprint 1`(目标:演示闭环);② 打开 sprint 详情。
预期:详情页出现「产物」区(空态提示)与「审批」区(空态);sprint phase 显示 `planning`。

**M1-S3 Epic 拆解(人拆解红线)**
步骤:① 新建工作项类型选 `epic`,标题「计算能力增强」,加入 Sprint 1;
② epic 详情用拆解表单录入两个子项:`R2 calc 增加 pow`(repo=demo-app)、
`R3 report 输出 pow 汇总`(repo=demo-app,依赖 R2);③ 提交。
预期:生成 2 个子工作项,自动带 child-of(epic)与 R3→blocked-by→R2 链接;
epic 详情子项树正确展示依赖边;**页面/action 面上不存在任何"AI 自动拆解"入口**。

**M1-S4 依赖图校验**
步骤:① 在 R2 上手工添加链接 `blocked-by R3`(制造 R2⇄R3 环);② 点「图校验」;
③ 删除该环边;④ 再建 4 个链式子项 A←B←C←D(深度 4)加一个无依赖孤儿项 E;⑤ 再点校验。
预期:② 返回 error 且**报出环路径**(R2→R3→R2);⑤ 无 error,但出现「链深>3」与「孤儿项」两条 warning;
返回体含 topoOrder。

**M1-S5 gate 拦截与审批推进**
步骤:① Sprint 1 尝试 advance `分析→设计`;② 在 sprint 详情「审批」区发起 plan-signoff;
③ 用页面批准;④ 再次 advance。
预期:① 被拒,错误信息**明确列出缺失判据**(缺 sprint-doc 产物 + 缺 plan-signoff);
④ 若产物仍缺依旧被拒(判据是"产物存在 **且** 签核");手工经 action 建一份 docKey=sprint-doc 的产物后
advance 成功,sprint phase → designing,**看板上该 sprint 内工作项列联动**。

**M1-S6 gate 判据可配置(不硬编码)**
步骤:① 经项目设置(或 action)修改 gate 配置,将「分析」阶段判据中 test-plan 产物设为必需;
② 重复 S5 的 advance。
预期:advance 被拒且新增缺失项 `test-plan`;把配置改回,advance 恢复可通过。**全程零代码改动。**

**M1-S7 from-audit 阶段子集**
步骤:新建工作项类型 `from-audit`(或缺陷型),观察其详情页阶段条。
预期:阶段条只显示 `实施→测试`(plannedStages 类型子集);对它 advance 不要求 plan/design 签核。

**M1-S8 幂等与前置断言**
步骤:① 对某工作项 advance(fromStage=当前阶段)成功;② **用相同参数重放同一请求**;
③ 用 fromStage=旧阶段再放一次。
预期:②③ 均返回 no-op(明确的幂等响应),阶段不重复推进,活动流只有一条推进记录。

**M1-S9 单活跃 sprint 断言**
步骤:建 `Sprint 2` 并推进到 executing 前一步;在 Sprint 1 已处于 executing 相位时对 Sprint 2 advance 进 executing。
预期:被拒,错误信息指明「项目内已有进行中 sprint:Sprint 1」。

**M1-S10 回退保护**
步骤:对一个 `orchestratorRunId` 非空且未终态的工作项(M1 阶段可用 action 手工绑一个假 runId 模拟)执行 rollback-stage。
预期:被拒,提示需先取消执行中的 run。

### M1.3 通过标准

- [ ] S1–S10 全部 PASS(含刷新复查)
- [ ] 全部新表经加性迁移创建,启动日志无 destructive 告警
- [ ] priority 在新建表单/看板/接口文档三处语义一致
- [ ] 用第二个测试账号登录,看不到第一个账号的项目/sprint(ownable 隔离抽查)

---

## M2 — 规划技能链(~1.5 周)

### M2.1 交付物清单

| # | 类型 | 名称 | 说明 |
|---|---|---|---|
| 1 | 技能 | `/brainstorm` | 结构化笔记产物(docKey=brainstorm-notes) |
| 2 | 技能 | `/sprint-plan` | 交互访谈 → sprint-doc 产物;保留 P0 删除测试、指标可证伪门槛 |
| 3 | 技能 | `/sprint-test-plan` | test-plan 产物;无跨模块集成时产出"无集成场景"一段式文档 |
| 4 | 技能 | `/sprint-design` | 深读仓库真实代码(经 orchestrator workspaceCreate 只读检出或 gitRemote 直读)→ tech-design 产物,§4 每工作项一节 + §7 文件变更矩阵 |
| 5 | 技能 | `/sprint-review` | 多轮对抗评审:经 orchestrator spawnOnce 起 vllm/sonnet 交替轮,携带累计已发现清单;每轮把有效发现修订进 tech-design 新版本 |
| 6 | action | `extract-briefs(sprintId)` | 确定性解析 tech-design(§4 标题 + §7 矩阵)→ brief:{itemKey} + shared-brief 产物;返回 `{briefs[], missingItems[], dependencies[]}` |
| 7 | 约束 | human 产物保护 | producedByKind=human 的产物,agent 建新版必须 supersedes+审批,否则拒绝 |
| 8 | 页面 | sprint 产物区:版本链、human/agent 徽标、diff 查看 | |

### M2.2 验收场景

**M2-S1 规划对话产出 sprint-doc**
步骤:① Sprint 1 详情或 tracker 首页 chat 输入「/sprint-plan 帮我规划本 sprint:
给 demo-app 增加 pow 计算与报表汇总」;② 按技能访谈回答目标/范围/指标;③ 结束对话。
预期:产物区出现 `sprint-doc` v1;内容含 目标/In Scope/Out of Scope/成功指标/分仓工作项表;
producedByKind=**human**(人主导访谈定稿);**产物含可证伪的成功指标**(抽查:指标句式含可观测信号)。

**M2-S2 设计技能读真实代码**
前置:S1 完成,plan-signoff 已批,phase=designing。
步骤:chat 输入「/sprint-design」等待完成。
预期:产物区出现 `tech-design` v1,producedByKind=agent;
**内容引用靶仓真实存在的文件路径与函数名**(验收 agent 对照靶仓源码抽查 ≥3 处:
如 `src/calc.js` 的真实导出名);§4 含 R2/R3 各一节;§7 文件变更矩阵含 Repo 列。

**M2-S3 多轮评审产生版本链**
步骤:chat 输入「/sprint-review」;观察 orchestrator spawns 页。
预期:orchestrator 出现数个评审 spawn(模型交替:qwen3.6 与 sonnet 至少各一);
tracker 产物区 tech-design 出现 v2(supersedes v1),版本链页面可见、可 diff;
评审总结记录"各轮发现数/修订数"。

**M2-S4 briefs 提取(确定性)**
步骤:调 `extract-briefs`(页面按钮或 action 接口)。
预期:产物区出现 `brief:R2`、`brief:R3`、`shared-brief`;数量=子项数;
`brief:R3` 内容含依赖声明(R2);返回体 dependencies 与 links 一致;
对同一版本设计**重复执行 → 幂等**(版本不重复增长)。

**M2-S5 human 产物保护(红线)**
步骤:在 chat 里要求 agent「重写 sprint 文档,把范围改成 XXX」。
预期:agent 调 create-sprint-artifact 被拒(错误信息含"human 产物需审批");
产物区 sprint-doc 版本数不变;发起审批并批准后重试,才生成 v2。

**M2-S6 design-signoff 闭环**
步骤:依 M1-S5 同样方式发起并批准 design-signoff;advance 设计→实施(sprint 级)。
预期:判据检查通过(tech-design + briefs 齐 + 图校验通过 + 签核);phase → executing。

**M2-S7 M3 解耦夹具**
步骤:在另一个测试 sprint 里,不跑技能,直接用 create-sprint-artifact 接口手工创建
brief:{itemKey} 与 shared-brief。
预期:成功入库且被 advance 判据认可——证明 M3 验收可用手工夹具,不被 M2 阻塞。

### M2.3 通过标准

- [ ] S1–S7 全部 PASS
- [ ] 技能全部为 tracker `.agents/skills/` 下 markdown(改文档即生效,抽查:改一处措辞刷新即变)
- [ ] 评审轮全部走 vllm/sonnet(orchestrator spawns 页无其他模型)
- [ ] extract-briefs 为纯确定性(同输入两次执行产出 byte 级一致)

---

## M3 — 执行管道(~2.5 周)

### M3.1 交付物清单

| # | 类型 | 名称 | 说明 |
|---|---|---|---|
| 1 | 交付 | playground 靶仓 + 剧本(0.3 节) | R1/R2/R3/RX 四个种子需求文本 |
| 2 | action(orch) | `sprintBranchEnsure/Promote/Delete` | 幂等;Promote 用 merge-commit |
| 3 | action(orch) | `ciWatch(prRef)` | **GitHub REST**(checks/status API)+ 临时 token;`ciMode=none` 立即返回 green(short-circuit) |
| 4 | action(orch) | `mergePr(prRef, strategy)` | 目标分支 advisory lock 串行;前置断言:CI 绿(none 视为绿)+ merge-base==目标分支 tip;**无 force 参数** |
| 5 | agents(orch) | `.claude/agents/`:dev-agent/qa-agent/reviewer/gatekeeper | vllm 与 sonnet 档;移植 TDD/双工件/越界即败/真实运行纪律 |
| 6 | DAG 模板 | `sdlc-issue-pipeline` | dev→qa(loop)→review(loop≤3+human_gate)→gate(按 gateMode)→**diff-audit(确定性)**→commit+PR→ci-watch→merge-pr(断言失败→回 dev 重验回路) |
| 7 | tracker | dispatch 升级 | 载荷=brief+sharedBrief 全文 + repo/baseBranch/targetBranch;tags=source/sprint_id/item_id/ownerEmail/orgId;**白名单禁 sprint-doc/tech-design** |
| 8 | tracker | **依赖感知调度器** | exec_queue 升级:blocked-by 全部解除(实施完成)才派发;每次实施完成事件重评估解锁项 |
| 9 | tracker | sprint-lead 线程迁移 | sprint 进 executing 时建 lead brain 线程(executorThreadId);get-activity 按 run tags 重组 |
| 10 | 预留 | 靶仓实测 + prompt 调优 3–4 天 | 双模型档位实测 |

### M3.2 验收场景

**M3-S1 sprint 分支建立**
前置:M1/M2(或 M2-S7 夹具)使 Sprint 1 进入 executing;靶仓就绪。
步骤:观察(或手动触发)sprint 启动。
预期:靶仓出现分支 `sprint-1`(git log 核对,基于 main tip);重复触发**幂等**(分支不被重置)。

**M3-S2 单项流水线 happy path(核心场景)**
前置:R1(独立需求)brief 就绪。
步骤:① 工作项 R1 页点「派发」;② 打开 orchestrator runs 页跟踪该 run;③ 等待终态。
预期(逐节点):
- run tags 含 `{source:'tracker', item_id:R1, sprint_id, ownerEmail, orgId}`;
- dev 节点 done:spawn 详情可见模型=qwen3.6;workspace diff 含 `src/` 实现与 `test/` 新增测试;
  **git log 中测试提交早于实现提交**(TDD 红先行,验收 agent 核对 commit 顺序);
- qa/review/gate/diff-audit 依次 done;gate(tests-only 档)的 spawn 记录含真实 `npm test` 执行输出;
- PR/分支合入:靶仓 `sprint-1` 分支收到该项的 squash 合入 commit;
- run 终态 done;tracker 侧 R1 实施阶段完成(M3 允许经 get-activity 轮询生效,确定性回写属 M4)。

**M3-S3 评审失败回路与 3 次上限**
步骤:派发一个专门构造的"必然过不了评审"的需求(剧本提供:brief 中埋含明确禁止项的实现要求,
或临时把 reviewer agent md 的口径调严);观察 run。
预期:review→dev-fix 循环出现(loop iteration 增长);第 3 次仍未过 → run 出现 human_gate
节点 awaiting-approval;**tracker 侧自动出现 escalation 审批单**(M3 可先验证审批单创建,
批准解锁 DAG 属 M4-S9);工作项页可见"已升级"状态。

**M3-S4 依赖感知派发**
步骤:同时把 R2、R3 加入队列(R3 blocked-by R2);观察派发顺序。
预期:R2 先被派发,**R3 保持排队**(队列页可见"等待依赖");R2 实施完成(合入)后,
R3 **自动**进入派发(无人工触发);R3 的 dev workspace 基于**已含 R2 变更**的 sprint-1 分支
(git log 核对 R2 的 commit 在 R3 分支历史中)。

**M3-S5 顺序合并锁**
步骤:构造两个无依赖工作项并行派发(并发≥2),两者几乎同时到达 merge。
预期:两次合入在 sprint-1 上**串行落地**(git log 时间与父链无交叉合并冲突);
后合入者 merge 前经历了 merge-base 重新断言;全程无冲突残留。

**M3-S6 重验回路(L9)**
步骤:利用 S5 场景,后到的 run 在 merge-base 断言失败时的行为。
预期:该 run 不直接强合——路由回 dev rebase,且 rebase 后 **qa/review/gate 重新执行**
(节点 iteration 增长可见),然后才 merge。

**M3-S7 brief 隔离(红线)**
步骤:检查 S2 中 run 的 inputs(runs 页 run 详情)与各 spawn 的 renderedPrompt(节点检查器)。
预期:含 brief:R1 与 shared-brief 全文;**不含 sprint-doc、不含 tech-design 全文**;
prompt 中无其他工作项的 brief 内容。

**M3-S8 dev 模型切换**
步骤:项目设置把 demo-app 的 devModel 改为 sonnet;重新派发一个小需求。
预期:dev spawn 的模型显示 sonnet(claude-sonnet-4-6);其余节点模型不变;改回后恢复 qwen3.6。

**M3-S9 diff-audit 防污染**
步骤:剧本提供"越界需求"(brief 的 touches 仅列 `src/calc.js`,但需求文本诱导同时改 `src/server.js`)。
预期:diff-audit 节点 FAILED,run 事件含越界文件清单;路由回 dev;最终产物 diff 不含越界文件
(或 run 以 escalation 结束——两种皆可,但**不允许越界变更被合入**)。

### M3.3 通过标准

- [ ] S1–S9 全部 PASS
- [ ] mergePr 面上不存在绕过 CI/断言的参数(接口 schema 审查)
- [ ] issue-pipeline 为库中版本化 DAG 模板:**页面改 max_iterations 后新 run 生效,零代码**(3.8 层②抽查)
- [ ] worker agent md 改动即生效(改 dev-agent 一句纪律,新 run 的 renderedPrompt 可见)
- [ ] 双模型档位(vllm/sonnet)在靶仓上各完整跑通 ≥2 个需求

---

## M4 — Sprint 闭环(~2 周)

### M4.1 交付物清单

| # | 类型 | 名称 | 说明 |
|---|---|---|---|
| 1 | 通道(orch) | `tracker-client` + reconciler 终态回调 | run 终态 → 调 tracker advance-stage / create-work-item;身份取 run tags 铸 JWT;幂等 |
| 2 | tracker | get-activity 兜底轮询保留 | 与 #1 双通道,靠 advance 幂等去重 |
| 3 | DAG 模板 | `sdlc-verify` | 各仓 test_cmd_full + 集成场景;FAIL→建 from-audit 单(targetBranch=sprint 分支) |
| 4 | DAG 模板 | `sdlc-audit` | 输入=目标+diff+验证日志;**证据 output_schema**;轮次持久化 audit-report:{cycle} 产物;3 轮→escalation |
| 5 | DAG 模板 | `sdlc-promote` | 拓扑序;COMMITS_AHEAD=0 跳过;merge-commit;删 sprint 分支 |
| 6 | tracker | approve-gate 回调 nodeResolveGate(gateRef 联通) | escalation 批准 → DAG 解锁 |
| 7 | tracker | run 失败路由 | failed run → 工作项页「重派/回退/升级」三操作;transient 由 brain runFork 自动重试一次 |
| 8 | tracker | epic 自动闭合;sprint phase 全链推进(executing→…→done) | |
| 9 | 双侧 | 健康前置门 | vllm/CC 不健康 → 派发拒绝 + sprint 页原因展示 |
| 10 | 技能 | `/draft-fix-issue`(from-audit 单体生成) | verify FAIL 场景 → 单体(含 Trigger/What's broken/Suspected boundary/Brief) |

### M4.2 验收场景

**M4-S1 确定性终态回写**
步骤:派发一个小需求,run 走完后**不进行任何 tracker 页面操作**,等待 ≤60 秒后刷新工作项页。
预期:实施阶段自动完成推进(活动流显示系统回写来源);**停掉 get-activity 轮询的浏览器页面也一样生效**
(证明是服务端回调而非前端轮询);orchestrator 日志含回调记录。

**M4-S2 回写幂等(双通道竞态)**
步骤:S1 的同一 run 场景,保持工作项详情页开着(get-activity 轮询活跃)再走一遍。
预期:活动流**只有一条**阶段推进记录(回调与轮询双通道被幂等断言去重)。

**M4-S3 verify GREEN(无集成场景语义)**
前置:sprint 内全部工作项实施完成;该 sprint 的 test-plan 为"无集成场景"。
步骤:观察(或触发)verify。
预期:sdlc-verify run 只跑各仓 test_cmd_full,全绿 → sprint phase → auditing;
tracker 出现 verify-report 产物(GREEN,含测试输出摘要)。

**M4-S4 埋缺陷 → from-audit 回环(核心场景)**
前置:新起 Sprint 2(走完规划/设计/签核,可用夹具),内含 RX(埋缺陷需求,0.3 节)+ 一个正常需求;
test-plan 含集成场景「/report 返回含 pow 汇总的 200」。
步骤:① 全部实施完成;② verify 自动执行;③ 观察 tracker;④ 等修复回环完成;⑤ verify 重跑。
预期:
- ② verify FAIL:report 集成场景 FAIL,证据含实际 HTTP 响应/错误输出;
- ③ **自动出现 from-audit 工作项**:类型正确(阶段子集=实施→测试)、targetBranch=sprint-2 分支、
  单体含 Trigger(失败场景名)/What's broken(期望 vs 实际)/Suspected boundary(repo=demo-app + 置信标记);
  该单**自动进入派发**(无需 plan/design 签核——M1-S7 的子集生效);
- ④ 修复 run 走完,合入 sprint-2;
- ⑤ verify 重跑 GREEN,phase → auditing。**全程零人工干预。**

**M4-S5 audit 证据 schema(反奉承)**
步骤:审计 run 执行;查看 audit 节点的 output 与重询记录;查看 tracker audit-report:{cycle} 产物。
预期:report 的每条 metric 带 evidence 且匹配 `repo:file[:line] | PR#n | sha | absence-of:` 模式;
若模型输出了 "done/implemented/✓" 类证据,可在 spawn 事件中看到 **schema 拒绝 + 一次纠偏重询**;
verdict=NO_GAPS 时 blocking 必为空(schema 层保证);NO_GAPS → phase 自动 → promoting。

**M4-S6 audit 超限 + 延期决策**
步骤:用剧本构造持续 blocking(如目标里写一条环境内不可能满足的 P0);观察 3 轮。
预期:cycle 1/2/3 各产生 audit-report:{cycle} 产物(轮次持久化);第 3 轮后**自动**出现
escalation(或 audit-deferral)审批单;sprint 卡在 auditing 且页面可见原因;
人批准延期 → 继续推进(见 S9)。

**M4-S7 promote 与收尾**
前置:S4 的 Sprint 2 达到 promoting。
步骤:观察 promote run;完成后核对靶仓。
预期:main 收到 **merge-commit**(git log 可见 merge 节点,非 squash——sprint 边界保留);
`sprint-2` 分支被删除;sprint phase → done(M4 口径:story 判据 M5 生效);
**重跑 promote → 幂等**(COMMITS_AHEAD=0 跳过,无二次合并)。

**M4-S8 epic 自动闭合**
步骤:确认 Sprint 1 的 epic(R2/R3)在两子项全部到达终阶段后。
预期:epic 状态自动派生完成,活动流有闭合记录(无人工操作)。

**M4-S9 审批解锁 DAG(gateRef 联通)**
步骤:复现 M3-S3 的 escalation(3 次评审超限,DAG 挂在 human_gate);在 tracker 审批页**批准**。
预期:≤30 秒内 orchestrator 对应 human_gate 解锁(resolve),run 继续;拒绝路径:再造一次,
点「拒绝」→ run 终止为 cancelled/failed,工作项进失败路由。

**M4-S10 失败路由三操作**
步骤:构造一个 permanent 失败 run(如 gitRemote 改成不存在路径后派发);观察工作项页。
预期:工作项状态 failed、停在实施;页面出现「重派 / 回退阶段 / 升级」;
修复 gitRemote 后点「重派」→ 新 run 正常;活动流完整记录。

**M4-S11 健康前置门**
步骤:临时停掉 vLLM(或断其地址);尝试派发;恢复后重试。
预期:派发被**立即拒绝**(不是深处超时),sprint 页/工作项页显示不健康原因(vllm 不可达);
恢复后同一操作成功。

### M4.3 通过标准

- [ ] S1–S11 全部 PASS
- [ ] verify/audit/promote 三模板均为库中版本化 JSON(层②抽查:改 audit 的 evidence 正则,新 run 生效)
- [ ] 回写通道身份正确:第二账号的 sprint 派发后,回写落在第二账号 org(隔离复查)
- [ ] from-audit 单不需要任何人工签核即进入派发(M0 对齐口径)

---

## M5 — 度量与复盘(~1 周)

### M5.1 交付物清单

| # | 类型 | 名称 |
|---|---|---|
| 1 | 页面 | sprint-status:每工作项 dev/qa/review/gate 各环节耗时(自 v3 spawns/events 派生)+ 汇总(均值/最慢环节) |
| 2 | 页面 | sprint 燃尽(按工作项到达终阶段时间) |
| 3 | 技能 | `/sprint-story`(实走验证:每步 Do/Why/What you'll see + 验证日志)→ story 产物;交付判据启用 story |
| 4 | 技能 | `/sprint-recap`(人工介入时间线:从审批/评论/手工操作记录派生) |
| 5 | 功能 | sprint「发布」按钮落地(已完成→已发布 + changelog 联动) |

### M5.2 验收场景

**M5-S1 耗时真实性**:打开已完成 sprint 的 status 页,抽 2 个工作项,把页面耗时与
orchestrator runs 页对应 spawn 的时间戳手工核对。预期:误差 ≤ 秒级,无缺环节。

**M5-S2 story 实走验证**:对已交付 sprint 执行 `/sprint-story`。预期:story 产物含验证日志
(真实命令+真实输出,验收 agent 复跑其中 ≥1 条命令核对);若主打能力实走失败,
技能产出 blocking gap 并建 from-audit 单而非编造通过。

**M5-S3 recap 人工介入清单**:执行 `/sprint-recap`。预期:时间线包含该 sprint 全部审批事件
(与 approvals 表页面记录一一对应)、全部手工重派/回退操作;无编造条目。

**M5-S4 发布**:sprint done 后点「发布」。预期:状态→已发布;重复点击幂等。

### M5.3 通过标准

- [ ] S1–S4 全部 PASS;交付阶段判据升级为"晋升+story 验证通过"后,E2E-A 重跑仍 PASS

---

## E2E — 端到端验收(最终交付判定)

> 三个剧本全部 PASS = 系统交付。执行者:验收 agent(Playwright + action 接口);
> 环境:101 全新测试账号 + 重置后的靶仓(main 回到种子基线,删除全部 sprint-* 分支)。
> 每步记录截图/响应体;任何一步与预期不符即 FAIL,修复后**整个剧本从头重跑**。

### E2E-A 主链路:一个真实 sprint 从想法到交付(预计 2–4 小时)

| 步 | 操作 | 预期结果 |
|---|---|---|
| A1 | 注册新账号,登录 tracker | 进入空看板 |
| A2 | 建项目「E2E演示」,注册 demo-app 仓(ciMode=none, gateMode=tests-only, testCmdFull=npm test) | 设置页仓库卡片完整,刷新后持久 |
| A3 | 建 Sprint E1(目标:计算能力增强并保证报表一致) | sprint 详情 phase=planning,产物/审批区空态 |
| A4 | chat:`/brainstorm` 讨论方向 → `/sprint-plan` 完成访谈 | 产物区 sprint-doc v1(human);含可证伪成功指标 |
| A5 | `/sprint-test-plan` | test-plan 产物;含集成场景「GET /report 返回 200 且含 pow 汇总」 |
| A6 | 发起并批准 plan-signoff;advance 分析→设计 | 拒绝→批准→成功;phase=designing;审批记录含决策人/时间 |
| A7 | 建 epic「计算能力增强」,拆解录入 R2(calc pow)、R3(report 汇总,依赖 R2)、RX(calc.add 签名重构,独立) | 3 子项 + child-of + R3→blocked-by→R2;图校验:0 error(RX 孤儿 warning 可接受) |
| A8 | `/sprint-design` | tech-design v1;§4 含 R2/R3/RX 三节;引用 src/calc.js 真实符号(抽查 3 处) |
| A9 | `/sprint-review` | orchestrator 出现交替模型评审 spawns;tech-design v2(supersedes v1) |
| A10 | `extract-briefs` | brief:R2 / brief:R3 / brief:RX / shared-brief 四产物;R3 brief 声明依赖 R2 |
| A11 | 发起并批准 design-signoff;advance 设计→实施 | phase=executing;sprint 页出现 lead 线程标识;靶仓出现 sprint-E1 分支 |
| A12 | 观察派发(不做任何人工触发) | R2 与 RX 先派发(无依赖),R3 排队显示"等待 R2";健康门检查通过记录可见 |
| A13 | 跟踪 R2 的 run 至终态 | 节点序 dev→qa→review→gate→diff-audit→PR→merge 全绿;dev 模型=qwen3.6;git log:测试提交早于实现;sprint-E1 收到 R2 squash 合入 |
| A14 | R2 合入后观察 | **R3 自动开始派发**;其 workspace 基于含 R2 变更的 sprint-E1(git log 含 R2 commit) |
| A15 | R3、RX 全部实施完成 | 三项实施阶段均自动推进(无人点页面);run inputs 检查:只含各自 brief+shared,无 sprint-doc/tech-design(红线抽查) |
| A16 | verify 自动执行 | **FAIL**:单测全绿但集成场景「/report」失败(RX 埋的签名断裂);verify-report 产物含真实 HTTP 错误证据 |
| A17 | 观察 from-audit 回环(零人工) | 自动建 from-audit 单(targetBranch=sprint-E1;单体含 Trigger/What's broken/Suspected boundary=demo-app);自动派发;修复 run 合入 |
| A18 | verify 自动重跑 | GREEN;phase→auditing |
| A19 | audit 执行 | audit-report:1 产物;每条 metric 带合规 evidence(格式抽查);verdict=NO_GAPS;phase→promoting |
| A20 | promote 执行 | main 收到 merge-commit(非 squash);sprint-E1 分支删除;phase→done(M5 后:story 判据生效再验) |
| A21 | 收尾核对 | epic 自动闭合;看板全部工作项到终列;sprint 详情:产物 ≥8 件、审批 2 件、活动流完整可回溯 |
| A22 | 复盘(M5 后)| status 页各环节耗时与 runs 页一致;`/sprint-story` 实走验证 /calc /report 真实响应 |

**A 剧本通过判据**:22 步全部符合预期;**人工操作仅出现在 A4/A5 访谈、A6/A11 两次签核**
(其余全自动——与 M0 对齐的审批口径逐字核对);靶仓最终 main 上 `/calc?a=2&b=3`、`/report`
经真实 HTTP 请求返回预期内容(真实运行证据,非仅测试绿)。

### E2E-B 异常路径:超限升级与失败恢复(预计 1–2 小时)

| 步 | 操作 | 预期结果 |
|---|---|---|
| B1 | 新 sprint,派发"必然过不了评审"的剧本需求 | review loop 3 次 → human_gate 挂起 + tracker escalation 审批单自动出现 |
| B2 | tracker 批准该审批 | ≤30s orchestrator gate 解锁,run 继续(或按剧本设计继续失败) |
| B3 | 再造一次,tracker **拒绝** | run 终止;工作项进失败路由,页面出现「重派/回退/升级」 |
| B4 | 把仓库 gitRemote 改错后派发 | run permanent 失败;工作项 failed;修复配置→点「重派」→ 成功 |
| B5 | 停 vLLM,派发 | 立即拒绝 + sprint 页显示"vllm 不可达";恢复后同操作成功 |
| B6 | run 进行中对该工作项 rollback-stage | 被拒(需先取消 run);runCancel 后回退成功 |
| B7 | audit 持续 blocking 剧本跑 3 轮 | 3 份 audit-report 产物;第 3 轮自动 audit-deferral 审批单;批准延期→ promoting;活动流记录延期决策与理由 |

### E2E-C 红线逐条验证(预计 1 小时,可与 A/B 穿插取证)

| # | 红线 | 验证方法 | 预期 |
|---|---|---|---|
| C1 | 人拆解 | 全面检查 chat/页面/action 面 | 不存在"AI 自动拆解 epic"入口;decompose-epic 仅接受人写清单 |
| C2 | brief 隔离 | 抽查 ≥3 个 run 的 inputs 与 renderedPrompt | 无 sprint-doc/tech-design;无他项 brief |
| C3 | CI 不可绕过 | 审查 mergePr 接口 schema + 尝试带多余参数调用 | 无 force;多余参数被拒;ciMode=none 必须来自 project_repos 显式配置 |
| C4 | 顺序合并 | E2E-A13/A15 期间 git log 拓扑 | 同分支合入严格串行,无交叉 |
| C5 | 人写产物保护 | chat 要求 agent 改 sprint-doc | 无审批被拒;有审批生成新版本且旧版本保留 |
| C6 | 幂等 | 重放 advance-stage / promote / extract-briefs | 全部 no-op,无重复副作用 |
| C7 | 证据 schema | 检查 audit spawn 事件 | 存在 schema 校验;不合规证据被拒并重询 |
| C8 | 升级而非自旋 | B1/B7 | 3 次/3 轮硬上限,超限必出审批单,绝无第 4 轮 |
| C9 | 越权隔离 | 第二账号访问第一账号的 sprint/产物/run 回写 | 全部不可见/被拒;回写落在正确 org |

### E2E 证据归档

验收 agent 产出 `sdlc-e2e-report-{date}.md`:逐步 PASS/FAIL 表 + 关键截图索引 +
靶仓最终 git log + 三个剧本的总耗时与人工介入次数统计。该报告本身按"引用即打开"纪律撰写
——每个 PASS 必须附可核对的证据引用。

---

## 附:验收场景 ↔ 设计红线/评审 findings 覆盖矩阵(抽样)

| 设计条目 | 覆盖场景 |
|---|---|
| 依赖感知派发(评审 A-1)| M3-S4, E2E-A12/A14 |
| 确定性回写通道(评审 A-2)| M4-S1/S2, E2E-A15 |
| from-audit 阶段子集(评审 B-1)| M1-S7, M4-S4, E2E-A17 |
| gateMode(评审 B-2)| M1-S1, M3-S2(tests-only 实测)|
| 重验回路 L9(评审 A-5)| M3-S6 |
| diff-audit 防污染(评审 A-6)| M3-S9 |
| 幂等 advance / 双通道竞态(评审 B-5/B-12)| M1-S8, M4-S2, E2E-C6 |
| 审批解锁 gateRef(评审 B-8)| M4-S9, E2E-B2 |
| 身份传递(评审 B-7)| M4 通过标准, E2E-C9 |
| 健康前置门(评审 B-15)| M4-S11, E2E-B5 |
| 单活跃 sprint(评审 B-3)| M1-S9 |
| 人拆解/brief 隔离/CI/人写保护/证据 schema | E2E-C1–C8 |
