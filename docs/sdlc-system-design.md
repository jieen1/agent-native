# Agentic-Engineering SDLC 系统化 — 设计与实施规划

> 目标:把 `~/project/agentic-engineering` 沉淀的 AI 原生研发流程(多仓 Sprint 生命周期、
> umbrella 拆解、依赖感知派发、四角色流水线、目标审计)从"Claude Code 技能 + 脚本 + GitLab 标签"
> 形态,迁移为运行在 **tracker(流程域)+ orchestrator(执行域)** 之上的一等系统能力。
>
> 状态:**设计 v1.1**(2026-07-03:经两路独立评审修订——视角 A 流程忠实性/可行性 15 条、
> 视角 B 健壮性/完备性 15 条,4 条 P0 已全部落进设计)。
> 详细分阶段实施与验收标准见姊妹文档 `docs/sdlc-implementation-plan.md`。

---

## 一、流程完整梳理(我们沉淀了什么)

### 1.1 一句话模型

**Sprint 是编排单元**:briefs 单向向前流动、agent 视野被严格限定、依赖门控派发、
sprint 分支缓冲 master。一条命令启动团队,一条命令回滚整个 sprint。

### 1.2 两大阶段、全产物链

**阶段 I — 规划与建单(人 + 技能,产出全部文档产物)**

| #   | 环节            | 输入                  | 输出                                                       | 执行者                                                 | 推进门槛                                      |
| --- | --------------- | --------------------- | ---------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| 0   | 一次性项目配置  | 空工作区              | `project.yaml`(仓库/命令/基础设施钩子)+ 预建标签           | 人 + project-setup agent                               | 克隆检查通过、占位符清零                      |
| 1.1 | Sprint 计划     | 头脑风暴笔记          | `sprint-N.md`(目标/范围/成功指标/分仓工作项/风险)          | 人 via `/sprint-plan`                                  | **此文档只给人和设计技能看,永不给执行 agent** |
| 1.2 | 集成测试计划    | sprint-N.md           | `sprint-N-test-plan.md`(黑盒用户流场景,每场景有可证伪信号) | `/sprint-test-plan`                                    | 跨仓特性才需要;测试先于设计锚定               |
| 1.3 | 技术设计        | 上两者                | `technical-design.md`(§4 每 issue 一节 + §7 文件变更矩阵)  | `/sprint-design`(深读真实代码)                         | 设计必须覆盖每个测试场景                      |
| 1.4 | 对抗评审+briefs | 设计文档              | 评审修订版 + `briefs/{shared.md, issue-NNN.md, index.md}`  | `/sprint-review`(多模型多轮)+ `extract_briefs.py`      | 每场景有实现路径                              |
| 2.x | 建单            | briefs + 人写拆解散文 | 独立 issue / umbrella + 子 issue(带依赖标签)               | 人 + `/umbrella-yaml`(校验)+ `/sprint-decompose`(落地) | **人拆解、工具格式化校验**;图 lint 通过       |

**阶段 II — 自动执行(sprint-executor lead 按 runbook 跑)**

| 相位       | 内容                                                                              | 门槛                                        |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------- |
| §1/A0      | 预检(克隆/图 lint/循环检测)→ 每仓建 `sprint-N` 分支(幂等)                         | lint 通过                                   |
| A–F        | **逐 issue 流水线**(见 1.3)                                                       | 全部 issue 合入 sprint-N                    |
| §5         | Sprint 验证:每仓 `test_cmd_full` 在 sprint-N 顶点全量绿                           | 任一红 → 不得进入 H                         |
| gatekeeper | 集成场景验证(按测试计划逐场景,不因首败中断)                                       | RED → `/draft-fix-issue` 建修复单重进派发   |
| §6 Phase H | **目标审计循环**:审计者只看 goal+diff+验证日志(不看 issue 清单),输出结构化 report | 必须 `verdict=NO_GAPS`;上限 3 轮 → 升级人类 |
| §7 Phase G | **晋升**:按依赖序将各仓 sprint-N 以 **merge-commit** 合入 master,删分支           | 每仓 CI 绿 + 可合并                         |
| §8         | Sprint Story:新手视角实走验证("能用"≠"合了")                                      | 主打能力必须真实路径实测                    |

**逐 issue 流水线(A–F,含全部失败路由)**:

```
dev(TDD 红-绿-重构,先提交红测试)
  → qa(双工件:E2E + 集成测试,零重叠;失败 → 回 dev)
  → reviewer(多轮评审,越界=自动 FAILED;修复上限 3 次 → 升级人类)
  → gatekeeper(强制真实运行;纯代码分析=自动 FAIL;失败 → 回 dev)
  → diff 审计(无关文件=污染,不开 MR 退回 dev)
  → rebase 最新 sprint-N(有冲突 → dev 解决 → 必须重跑 qa/review/gate,rebase 可能改变语义)
  → MR → CI 全绿(失败 → dev 修 → 重跑)→ 合并前断言 merge-base==sprint-tip → squash 合入(顺序锁)
  → 清理(仅在合并成功后)
```

### 1.3 状态机与标签体系(需系统化的核心)

**issue 生命周期(原以标签表达)**:
`pending → in-progress → ready-for-qa → qa-passed → reviewed → gate-cleared + closed`,
修复态 `qa-failed / review-failed / gate-failed → dev-fix → 重派失败环节`。
终态判据 = **closed 且 gate-cleared**(即"已合入 sprint 分支"),派发闸以此判断 blocker 是否解除。
**派发循环**:lead 每轮按 blocked-by 过滤可派发项,每次合并后重新评估解锁项(re-eligibility)。

**Umbrella 规则(doctrine)**:2–5 个子项健康,>10 必拆;子项目标 2–6 小时人当量;
一个子项=一个仓=一条特性分支;依赖链深度 ≤3;环禁止;
`umbrella_lint.py` 三色 DFS 判环 + 深度/全线性/孤儿告警。最后一个子项合并 → umbrella 自动闭合。

### 1.4 必须保留的六原则 + 验证纪律

1. **每 issue 全新 worktree**,无共享状态(污染曾导致 22 文件 PR)。
2. **顺序合并**,即使并行开发(自动解冲突曾静默毁码——永不自动解冲突,rebase 后必须重验)。
3. **agent 只看自己的 brief**(sprint 文档泄漏会让 agent 抢跑越权)。
4. **兄弟仓只读** + SHA 快照隔离检查(多仓时)。
5. **Sprint 为回滚单元**(晋升前删分支即回滚;晋升后单个 `git revert -m 1`)。
6. **人拆解、工具格式化校验、lead 编排、agent 执行**(LLM 自动拆解被明令禁止)。

**验证纪律(整套流程的灵魂,全部要编码进系统)**:

- **引用即打开**:不打开引用的文件/日志/查询结果,不许宣称 DONE/PASS/APPROVED/NO_GAPS。
- **反奉承 schema**(Phase H):证据必须是 `repo:file[:line]` / `PR#n` / sha / `absence-of:<pattern>`;
  "implemented/complete/done/✓" 一律拒收;`NO_GAPS` 不能与任何 P0 未达/阻塞项并存。
- **真实运行证据**:用户可感指标要求"真实入口 + 真实非种子输入 + 捕获输出"。
- **证明者/否证者分离**:宣称 MET 的 agent 不能自己批准。
- **闭环上限**:评审修复 3 次、审计 3 轮,超限升级人类,绝不无限自旋。
- **CI 永不绕过**;flake 隔离必须带 owner issue(→ backlog,见 4.6)。

---

## 二、现状盘点(我们已有什么)

### 2.1 Tracker(流程域,现成度 ~60%)

**已有**:项目 · 工作项 · 七阶段流水线(待办→分析→设计→实施→测试→验收→交付)·
Sprint 实体 · 类型化链接(blocks/blocked-by 等)· 版本化产物(version/supersedes/producedByKind)·
活动流 · 执行队列 · dispatch-to-orchestrator(MCP brain-send + get-activity 拉回)。

**缺口**:complete-stage 不推进看板列;审批门是 UI 空壳;无 epic 层级;
**artifacts 表 workItemId/stageId 均 NOT NULL 且无 content 列**(sprint 级产物必须新表,见 3.3);
无依赖图校验;单仓模型;priority 语义不一致;
**dispatch/get-activity/exec_queue 全部锚定 per-item 线程模型**(与 sprint-lead 模型冲突,见 3.5)。

### 2.2 Orchestrator(执行域,现成度 ~70%)

**已有**:V3 DAG 引擎(agent/parallel_over/loop/human_gate、guard、retry+错误分类、
patch/fork、output_schema AJV 校验+一次纠偏重询)· Brain(可恢复 CC 会话+MCP 工具+
节点/run 终态自动唤醒+并发准入闸)· Workspace(worktree 隔离+临时 token+commit 前密钥扫描+
PR 自动创建)· 多执行器(vllm/openai-compatible/claude-code worker)· JSONB tags 全链路追溯。

**缺口**:无 CI 监视(**且容器内无 gh CLI,GITHUB_TOKEN 为 Vault 临时解析——ciWatch 必须走
GitHub REST + 临时 token**);无合并自动化;无 sprint 分支管理;
**brain 的 MCP 工具面只指向 orchestrator 自身**(`brain-mcp-config.ts` 单 server)——
不存在"brain 调 tracker action"的通路,回写必须另建(见 3.6)。

### 2.3 集成现状

tracker → orchestrator:MCP 单向派发 + get-activity 拉取重组(写回 status 不动 stage)。
**缺**:执行终态 → 阶段推进的确定性回写;brief 注入协议;反向身份传递(orgId/owner)。

---

## 三、系统设计

### 3.1 总体架构裁决

```
┌─ Tracker = 流程大脑(单一事实源)────────────────────────┐
│ 项目/仓库注册 · Sprint(phase 权威)· Epic · 工作项       │
│ 依赖图+校验 · 依赖感知派发调度器 · 七阶段状态机           │
│ 审批门 · sprint 级产物库 · 规划技能链                    │
└──────────┬────────────────────────────▲────────────────┘
     派发(MCP,brief 全文入 inputs,      │ 确定性回写(orchestrator 侧
     tags 带 ownerEmail/orgId/ids)       │ tracker-client:A2A/HTTP+JWT,
                                         │ run 终态由 reconciler 触发;
                                         │ get-activity 轮询兜底)
┌──────────▼────────────────────────────┴────────────────┐
│ Orchestrator = 执行底座                                  │
│ Brain(sprint-lead,每 sprint 一线程,只做编排叙述)       │
│ V3 DAG:issue-pipeline / verify / audit / promote        │
│ Workspace · PR · ciWatch(REST)· mergePr(顺序锁)       │
└─────────────────────────────────────────────────────────┘
```

分工:tracker 拥有"该做什么、做到哪、谁批准";orchestrator 拥有"怎么做、哪个沙箱、哪个模型"。
跨 app 传 id + **有界全文**(brief 是单 issue 有界文档,直接入 run inputs,不做引用回拉)。

### 3.2 概念映射表(旧世界 → 新系统)

| agentic-engineering                | 系统实现                                                                   | 现成度    |
| ---------------------------------- | -------------------------------------------------------------------------- | --------- |
| issue 仓(GitLab meta 仓)           | tracker 项目 + 工作项                                                      | ✅        |
| issue / umbrella(epic 标签)        | work_item / `type=epic` + child-of links                                   | 🔧        |
| `blocked-by:` 标签 + lead 派发循环 | links + **tracker 依赖感知调度器**(exec_queue 升级,实施完成事件触发重评估) | 🆕 **M3** |
| `sprint-N` 标签                    | work_item.sprintId                                                         | ✅        |
| 生命周期标签 8 个                  | "实施"阶段内子状态(stage 行 deliveryItems/verdict)                         | 🔧        |
| `project.yaml`                     | 项目设置 + project_repos 表                                                | 🆕        |
| sprint 文档/设计/briefs            | **tracker_sprint_artifacts 新表**(content 列+Resources 溢出)               | 🆕        |
| umbrella_lint / extract_briefs     | tracker actions(确定性移植)                                                | 🆕        |
| sprint-executor lead               | brain(每 sprint 一线程;派发/回写走确定性系统,brain 只编排叙述)             | 🔧        |
| dev→qa→reviewer→gatekeeper         | V3 DAG 模板 `sdlc-issue-pipeline`(含 diff-audit/merge-base 断言/重验回路)  | 🆕        |
| worktree / MR                      | workspace / workspaceCommitPush                                            | ✅        |
| CI watch + 顺序合并                | ciWatch(REST)+ mergePr(advisory 锁)                                        | 🆕        |
| sprint 分支 + Phase G              | sprintBranch\* actions + `sdlc-promote` DAG                                | 🆕        |
| Sprint Verify / Phase H            | `sdlc-verify` / `sdlc-audit` DAG(证据 schema)                              | 🆕        |
| 审批/升级                          | human_gate + tracker approvals(**批准回调 nodeResolveGate 解锁**)          | 🔧        |

### 3.3 数据模型增量(全部可加性)

```
project_repos                    # 多仓注册(单仓先行,表一步到位)
  id, projectId, name, gitRemote, baseBranch,
  testCmdUnit, testCmdFull, e2eTestPath, integrationTestPath, buildTool,
  ciMode('github'|'none'),       # 无 CI 仓库一等公民
  gateMode('stack'|'tests-only'|'none'),  # gatekeeper 真实运行环境(见 3.7-8)
  devModel(nullable)             # dev 角色模型覆盖(默认 vllm)

tracker_sprint_artifacts         # 新表(原 artifacts 表 workItemId/stageId NOT NULL,不可复用)
  id, sprintId, docKey,          # docKey: sprint-doc|test-plan|tech-design|brief:{itemKey}|
                                 #         shared-brief|audit-report:{cycle}|story|verify-report
  kind, name, version, supersedes, producedByKind('human'|'agent'),
  content(text),                 # 产物正文(markdown);超大内容走 contentRef→Resources
  contentRef, createdAt

tracker_approvals
  id, sprintId, workItemId(nullable),
  gateKey('plan-signoff'|'design-signoff'|'escalation'|'audit-deferral'),
  gateRef(nullable),             # orchestrator {runId,nodeId} —— 批准后回调 nodeResolveGate 解锁 DAG
  status('pending'|'approved'|'rejected'), requestedBy, decidedBy, reason, decidedAt

tracker_work_items(加列)
  + repoName, + targetBranch(nullable),   # from-audit 单按相位记基线:verifying=sprint 分支,promoting 后=base
  + escalatedAt/escalationReason

tracker_sprints(加列)
  + phase('planning'|'designing'|'executing'|'verifying'|'auditing'|'promoting'|'storytelling'|'done')
  + executorThreadId             # sprint-lead brain 线程
```

**派发载荷协议**(dispatch 升级):run inputs 携带 `brief`(全文)+ `sharedBrief`(全文)+
`repo/baseBranch/targetBranch`;run tags 携带 `{source:'tracker', sprint_id, item_id, ownerEmail, orgId}` —
回写通道用 tags 中身份铸 JWT,保证 ownable 数据落在正确 org(反向身份传递)。
**brief 隔离白名单**:载荷只允许 brief/shared-brief 两个 docKey,sprint-doc/tech-design 禁止注入。

### 3.4 状态机设计(sprint.phase 权威 + per-item 派生)

**不变量**:sprint 级阶段(分析/设计/验收/交付)由 `sprint.phase` **权威驱动**;
工作项 `currentStageName` 在 sprint 级推进时由系统**派生联动**(批量 advance,失败项进活动流告警)。
实施/测试为工作项级,由回写通道推进。**同一项目同时最多一个 sprint 处于 executing~promoting 相位**
(advance 进 executing 时断言,防两个 sprint 抢分支基线)。

| 阶段 | 承载                               | 完成判据(gate,项目级 JSON 配置)                                                  |
| ---- | ---------------------------------- | -------------------------------------------------------------------------------- |
| 待办 | backlog                            | 人拉入 sprint                                                                    |
| 分析 | brainstorm+sprint-plan(+test-plan) | 产物存在 + **plan-signoff**                                                      |
| 设计 | sprint-design+review+briefs        | 产物齐 + 依赖图校验通过 + **design-signoff**                                     |
| 实施 | 依赖感知派发 → issue-pipeline DAG  | run done 且 PR 合入 sprint 分支(全自动;3 次超限→escalation)                      |
| 测试 | sdlc-verify DAG                    | GREEN(**无集成场景时=各仓 test_cmd_full 全绿即 GREEN**;RED→自动建 from-audit 单) |
| 验收 | sdlc-audit DAG                     | `NO_GAPS` 自动过(3 轮上限→escalation;不可修→audit-deferral 问人)                 |
| 交付 | sdlc-promote DAG(+M5 story)        | 晋升合入 base(story 判据 M5 生效)                                                |

**关键语义**(评审修订):

- `advance-stage(itemId|sprintId, fromStage, expectedRunId?)` — **幂等 + 前置断言**:
  fromStage 不匹配当前阶段、或 expectedRunId 不匹配绑定 run → no-op。杜绝双通道(回写+轮询)重复推进
  与"旧 run 终态推进已回退工作项"。
- **plannedStages 按类型激活**:from-audit/缺陷型工作项的阶段子集 = `实施→测试`,
  自动继承所属 sprint 的两道签核(否则 from-audit 单被自己的门卡死,修复回环断裂)。
- **rollback-stage 联动**:工作项绑定非终态 run 时,回退先决 = run 已取消(tracker 经 MCP 调 runCancel,
  失败则拒绝回退)。
- **run 失败路由**:run failed/cancelled → 工作项状态 failed 且停在实施,工作项页提供
  「重派(新 run)/回退阶段/升级(建 escalation 审批单)」三操作;transient 类由 brain 自动 runFork 重试一次。
- **中途加单**:sprint 进入 executing 后变更 sprintId 须过校验——from-audit 自动加单放行;
  人工加单要求 brief 产物已存在 + 追加 design-signoff,否则拒绝并提示进下个 sprint。
- **epic 自动闭合**:子项全部到达终阶段 → epic 状态派生完成(对应原 umbrella auto-close)。

### 3.5 执行域:sprint-lead 线程模型 + 四个 DAG 模板

**线程模型迁移**(评审 A-15):派发从"每工作项一个 brain 线程"迁移为
"**每 sprint 一个 lead 线程 + 每工作项一个 run**"(tags.item_id 关联);
get-activity 改按 run tags 重组;brain_tasks 准入按 sprint 计槽。

**① `sdlc-issue-pipeline`(每工作项一个 run)** — 含评审回填的全部防御:

```
workspace(worktree @ sprint-N)
→ dev [vllm 默认/可配 sonnet;TDD:先提交红测试再实现]
→ qa  [vllm;测试工件;失败→回 dev(loop)]
→ review [loop ≤3:sonnet/vllm 交替,累计已发现清单;越界文件=FAILED;超限→human_gate]
→ gate [sonnet;按 project_repos.gateMode:stack=起栈实测 / tests-only=跑全量测试+diff 审查 / none=跳过]
→ diff-audit [确定性节点:变更文件对照 brief 的 touches 清单,越界=FAILED 回 dev(防污染,原 Phase D step1)]
→ commit+PR(workspaceCommitPush → sprint-N)
→ ci-watch [REST;ciMode=none 短路]
→ merge-pr [顺序锁;前置断言 merge-base==sprint-tip,不满足→回 dev rebase→重入 qa/review/gate(重验回路,L9)]
→ 终态 → reconciler 回写 tracker
```

**声明的偏离**(评审 A-7):单 workspace 贯穿 dev→gate(原流程 dev+qa 双 worktree)。
理由:单仓 + 节点串行,无并发写冲突;TDD 红测试先行 + diff-audit 兜底交叉污染。多仓阶段重估。

**② `sdlc-verify`**:各仓 test_cmd_full(parallel_over)→ 集成场景逐个执行(不因首败中断,
结构化 PASS/FAIL+证据)→ FAIL → 经回写通道在 tracker 建 from-audit 单(draft-fix-issue 技能生成单体,
targetBranch=当前 sprint 分支)。

**③ `sdlc-audit`**:输入 = sprint 目标 + 跨仓 diff + 验证日志(**不含 issue 清单**);
`output_schema` 强制证据格式(见 1.4);**轮次持久化**为 tracker 产物 `audit-report:{cycle}`
(brain 重启可续,schema 无效重询不计轮);blocking → from-audit 单;3 轮 → escalation。

**④ `sdlc-promote`**:依赖拓扑序逐仓:COMMITS_AHEAD=0 跳过(幂等)→ sprint-end PR →
ci-watch → merge-pr(**merge-commit** 保留 sprint 边界)→ 全部晋升后删 sprint 分支。

### 3.6 回写通道(评审 P0-2 的裁决)

**不依赖 brain 主动调 tracker**(LLM 主动性不可靠且通路本不存在)。三层:

1. **确定性回写(主)**:orchestrator 侧新建 `tracker-client`(镜像 tracker 侧 orchestrator-client:
   A2A/HTTP + `A2A_SECRET` JWT,已验证两容器密钥一致),reconciler 在 run 终态回调
   tracker `advance-stage`/`create-work-item(from-audit)`,身份取自 run tags。
2. **get-activity 轮询(兜底)**:现有链路保留,幂等 advance 保证双通道无重复推进。
3. **brain(叙述)**:唤醒后只做 review/commit/汇报,不承担状态推进。

### 3.7 流程红线的系统化编码

1. **人拆解**:epic 拆解 action 只接受人写好的子项清单(校验+落库),无 AI 自动拆解入口。
2. **brief 隔离**:派发载荷白名单(仅 brief/shared-brief),sprint-doc 永不注入。
3. **顺序合并**:mergePr 按目标分支 Postgres advisory lock 全局串行。
4. **CI 不可绕过**:mergePr 无 force 参数;跳过 CI 必须 project_repos 显式 `ciMode=none`。
5. **人写产物保护**:`producedByKind=human` 的产物,agent 新版本必须带 supersedes+审批,否则拒绝。
6. **升级而非自旋**:评审 ≤3、审计 ≤3,超限自动 escalation 审批单;**批准后经 gateRef 回调
   nodeResolveGate 解锁 DAG**(评审 B-8)。
7. **证据 schema**:验证/审计节点必须声明 output_schema,自由文本裁决无效。
8. **gateMode 显式化**(评审 P0):gatekeeper 的"真实运行"环境按仓声明——
   `stack`(workspace 内起栈实测,要求仓库自带可起命令)/`tests-only`(降级:全量测试+严格 diff 审查,
   M3 默认)/`none`。未声明默认 tests-only,绝不静默降级为纯代码分析。
9. **健康前置门**(评审 B-15):sprint 进 executing、以及每次派发前,检查 vllm 与 CC 登录健康
   (get-runtime-status),不健康拒绝派发并在 sprint 页显示原因。

### 3.8 可演进性:流程优化改哪里(设计约束)

**流程逻辑不进代码,进代码的只有能力原语。** 三层结构:

| 层              | 载体                                                                                                | 改动方式                          |
| --------------- | --------------------------------------------------------------------------------------------------- | --------------------------------- |
| ① 提示词/文档层 | brain runbook(markdown)、worker agent 定义(`.claude/agents/*.md`)、tracker 技能(SKILL.md)           | 改 markdown 即生效,零代码         |
| ② 流程编排层    | 4 个 DAG 模板 = 库中 JSON,**带版本**,页面/agent 可改(workflowSave);gate 判据 = **项目级 JSON 配置** | 页面/对话改配置,零代码            |
| ③ 系统代码层    | 确定性 actions(ciWatch/mergePr/图校验/brief 提取/调度器)、数据表、七阶段枚举                        | 改代码(对应原 Python 脚本层,等价) |

例:改评审轮数/换模型 → ②;加流水线环节 → ②+①;改 TDD 纪律/文档模板 → ①;加新技能 → ① 扔 SKILL.md;
改证据 schema → ②;接新 VCS/CI → ③;增删七阶段本身 → ③(罕见)。

### 3.9 规划技能链(tracker 侧技能)

`/brainstorm → /sprint-plan → /sprint-test-plan → /sprint-design → /sprint-review(多轮对抗,
经 orchestrator spawnOnce 走 vllm/sonnet 轮次,累计已发现清单)→ extract-briefs(确定性 action)`。
产物全部入 `tracker_sprint_artifacts`(versioned + provenance),判断性=技能、确定性=action,
与原工具箱划分一致。

### 3.10 模型策略(约束:orchestrator 只用本地 vllm + sonnet,禁 opus)

brain=CC(sonnet)· dev/qa=vllm(qwen3.6,project_repos.devModel 可切 sonnet)·
reviewer=sonnet/vllm 交替 · gatekeeper/audit=sonnet。外部模型(GPT/Gemini)通道不引入。

---

## 四、实施规划(摘要)

> 详细的每阶段交付物清单、验收场景、验收标准与端到端验收剧本见
> **`docs/sdlc-implementation-plan.md`**(实施基准文档)。

### M0 — 决策确认(已完成,2026-07-03 对齐)

- ✅ 单仓先行(表结构一步到位,多仓执行进 backlog)
- ✅ 审批点=规划/设计两道人工签核,其余全自动,超限被动升级
- ✅ dev 默认 vllm、按仓可切 sonnet
- ✅ 评审修订(v1.1):回写走 reconciler 确定性通道、依赖调度器归 tracker、
  sprint 产物新表、gateMode/ciMode 显式化、from-audit 阶段子集、幂等 advance

### 里程碑总览

| 里程碑 | 主题             | 核心交付                                                                                                                                                                                      | 工期    |
| ------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| M1     | Tracker 流程地基 | project_repos/sprint_artifacts/approvals 表 · epic 层级 · 依赖图校验 · advance-stage(配置化 gate+幂等)· 审批门落地 · 单活跃 sprint 断言                                                       | ~1 周   |
| M2     | 规划技能链       | 5 技能 + extract-briefs · 产物入库+human 保护 · 签核流                                                                                                                                        | ~1.5 周 |
| M3     | 执行管道         | sprintBranch\*/ciWatch(REST)/mergePr(锁) · issue-pipeline 模板(含 diff-audit/重验回路)· worker agents · **依赖感知调度器** · **sprint-lead 线程迁移** · **playground 靶仓** · prompt 调优预留 | ~2.5 周 |
| M4     | Sprint 闭环      | **回写通道(tracker-client)** · verify/audit/promote 模板 · from-audit 自动建单(targetBranch)· 审批解锁回调 · 失败路由 · epic 闭合 · 健康门                                                    | ~2 周   |
| M5     | 度量复盘         | sprint-status 耗时页 · burndown · story/recap 技能 · 发布落地                                                                                                                                 | ~1 周   |

### Backlog(里程碑外)

多仓执行(跨仓 sprint 分支、兄弟仓只读+SHA 快照、expand/contract 辅助)· PR 评审意见反馈循环 ·
chrome-test 浏览器实测 · CI flake 隔离(连续 2 次+owner issue)· 外部模型评审通道 · msb 微 VM 池。

### 主要风险

| 风险                  | 缓解                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| qwen3.6 做 dev 的质量 | devModel 按仓可配;TDD+review+gate 多闸;M3 预留 3-4 天靶仓实测与 prompt 调优,验收覆盖双模型配置 |
| 本地仓库无 CI         | ciMode=none 一等公民;gateMode=tests-only 作替代质量闸                                          |
| gatekeeper 起栈环境   | gateMode 显式三档,M3 默认 tests-only,stack 档在靶仓验证后开放                                  |
| 回写链路断            | 三层通道(reconciler 确定性 + 轮询兜底 + 幂等 advance)                                          |
| vllm/CC 单点          | 健康前置门,不健康拒绝派发并显式呈现                                                            |

---

## 附:与原工具箱的对照清单(迁移完备性检查用)

| 原资产                                | 去向                                                                  |
| ------------------------------------- | --------------------------------------------------------------------- |
| project.yaml / merge / resolver       | project_repos 表 + 项目设置                                           |
| create-issue-labels.sh                | 不再需要(标签→字段/links)                                             |
| umbrella_lint.py                      | validate-dependency-graph action                                      |
| extract_briefs.py                     | extract-briefs action                                                 |
| 规划技能五件套                        | tracker skills(M2)                                                    |
| umbrella-yaml + sprint-decompose      | epic 拆解技能 + 校验 action(M1/M2)                                    |
| sprint-executor.md 派发循环           | tracker 依赖感知调度器(M3)                                            |
| sprint-executor.md 流水线结构         | issue-pipeline DAG 模板(M3)                                           |
| sprint-executor.md 编排策略散文       | brain runbook(markdown)                                               |
| dev/qa/reviewer/gatekeeper agent 定义 | orchestrator .claude/agents/\*(M3)                                    |
| sprint-gatekeeper + draft-fix-issue   | sdlc-verify DAG + from-audit 建单(M4)                                 |
| gap-analysis(Phase H)                 | sdlc-audit DAG + 证据 schema + audit-report:{cycle} 产物(M4)          |
| Phase G                               | sdlc-promote DAG(M4)                                                  |
| sprint-story / status / recap         | M5                                                                    |
| lessons L1–L15                        | 编码进模板/action(顺序合并 L9、重验回路、幂等、升级阶梯 L5、污染防护) |
| rules/\*                              | worker agent 系统提示                                                 |
