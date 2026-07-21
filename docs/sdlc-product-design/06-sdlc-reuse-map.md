# 06 · SDLC 资产复用与命名对照（权威）

> 回答一个必须一次说清的问题：**agentic-engineering（a-e）沉淀的资产，
> 在新系统里到底哪些逐字复用、哪些移植、哪些被替代？** 命名如何对齐，
> 保证 a-e 的 skill、agent 定义、doctrine、脚本能直接搬进来跑，
> 而不是"看起来像但对不上"的两套东西。
> 本章是命名与复用的**唯一权威**；其余章节与本章冲突时以本章为准。

## 1. 总原则

1. **a-e 既有资产，名字与语义一律原样保留**——skill 名、agent 名、
   产物结构、纪律原文都不改；只有系统新增的东西（ui-spec、Foundry、
   可视化层）才起新名。
2. **被替代的只有承载介质，不是内容**：
   文件系统 → DB 产物（双表征）；GitLab 标签状态机 → tracker 状态机；
   glab/git worktree 命令 → workspace actions；lead 人肉轮询 → 调度器 +
   回写通道。介质换了，跑在上面的提示词、纪律、算法、结构原样。
3. **三层复用策略**（对应 v1.1 §3.8 的三层可演进结构）：
   - **层① 提示词/文档（判断性）→ 逐字复用**：文件直接拷入新家，
     只替换 I/O 段（读写文件 → 调 action），访谈流程、人格、质量门、
     红线原文不动。
   - **层② 流程编排（结构性）→ 结构移植**：sprint-executor 的流水线
     结构与消息状态机变成版本化 DAG 模板与门配置，语义逐条对应。
   - **层③ 确定性脚本 → 算法移植**：Python 脚本变 action，同算法同规则，
     **用 a-e 真实历史输入对拍验收**（同输入同输出才算移植完成）。
4. **可视化层是壳不是芯**：tracker UI、content 富呈现、design 原型全部
   包在这些资产外面（P11 双表征）；壳的任何变化不触碰资产语义——
   这就是"最后能串起来"的结构性保证：**跑的还是那套 SDLC，系统只是
   给它装了驾驶舱**。

## 2. 资产级对照矩阵

### 2.1 规划技能（层①，逐字复用 → tracker `.agents/skills/` 同名落位）

| a-e 资产                                                                                   | 策略                                                                                 | 保留什么（原文不动）                                                                                               | 只改什么                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skills/brainstorm`                                                                        | 逐字复用（**可选步骤**）                                                             | PM 人格、四种开场、一次一问先给推荐答案、可证伪门、推过第一方案                                                    | 产物写入：文件 → `create-sprint-artifact(docKey=brainstorm-notes)`                                                                                                                                       |
| `skills/sprint-plan`                                                                       | 逐字复用                                                                             | 访谈顺序（Goal→In/Out Scope→指标→…）、P0 删除测试、Leading/Lagging 可证伪指标、"文档不含路径/代码"反模式、整块揭示 | 同上（docKey=sprint-doc）；**登记的结构性增量**：① In-Scope 每条追加 ui 面标注；② Success Metrics 每条带稳定编号 M1/M2…（Goal 链全程以此对齐）；③ 随产物输出 gates[] 自评标注（UI 与确定性校验分开呈现） |
| `skills/sprint-test-plan`                                                                  | 逐字复用                                                                             | 黑盒、按用户目标一场景、每场景 Why/Steps/Expected/Pass-fail 信号/Execution tool/Executable spec、无集成场景一段式  | 同上（docKey=test-plan）；**登记的结构性增量**：每场景「关联指标（M 编号）」字段 + 可选 journey 节——覆盖矩阵与旅程图由此**确定性渲染**（管道不做判断）；其余富呈现不改 agent 版结构                      |
| `skills/sprint-design`                                                                     | 逐字复用                                                                             | 四阶段（读产物→深读真实代码→写→自审）、§1–§9 模板、自审门（路径必须存在等）                                        | 代码检出：本地 clone → orchestrator 只读 workspace；产物 docKey=**technical-design**                                                                                                                     |
| `skills/sprint-review`                                                                     | 逐字复用                                                                             | 多轮对抗、累计已发现清单、只收高置信新发现、报告表结构                                                             | 轮次执行：CLI 多模型 → orchestrator spawnOnce（vLLM/sonnet 交替）                                                                                                                                        |
| `skills/sprint-story`                                                                      | 逐字复用                                                                             | Do/Why/What you'll see、"没执行过不许进故事"、主打能力不许 unverifiable                                            | 产物入库 + content 发布                                                                                                                                                                                  |
| `skills/sprint-status` / `sprint-recap`                                                    | 逐字复用（口径）                                                                     | 环节耗时表、人工介入时间线的统计口径                                                                               | 数据源：会话日志 → spawns/approvals/活动流（03 §10 度量页即其 UI 化）                                                                                                                                    |
| `sdlc/teams/gap-analysis-workflow.md` + `agents/gap-analyst.md` + `skills/draft-fix-issue` | 逐字复用（workflow 文档 → 模板说明与 brain runbook 节；agent 文件与 skill 原文拷贝） | 证据 schema、3 轮上限、from-audit 单体格式（Trigger/What's broken/Suspected boundary/Brief）                       | 触发方式：命令 → sdlc-gap-analysis / sdlc-verify 工作流节点。注意 a-e 的 /gap-analysis 是保存的 workflow 命令而非 skills/ 目录文件                                                                       |
| `/ui-spec`（无 a-e 对应）                                                                  | **新增**                                                                             | —                                                                                                                  | 按 a-e 技能范式写（推荐答案、可证伪门、整块揭示），补 UI 空白                                                                                                                                            |

### 2.2 执行角色与纪律（层①，逐字复用 → orchestrator `.claude/agents/` 同名落位）

真实源路径是 **`sdlc/teams/agents/*.md`**（注意：a-e 根目录另有一个无关的
`agents/` 目录——project-setup.md 等，勿混拷）。

| a-e 资产                                       | 策略     | 保留什么（原文不动）                                                                                              | 只改什么                                                                        |
| ---------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `sdlc/teams/agents/dev-agent.md`               | 逐字复用 | TDD 红-绿-重构强制、**红测试先 commit**、只写单测、只在集成边界 mock、隔离检查                                    | 工具段：git worktree/glab → workspace actions；上报 → spawn 输出                |
| `sdlc/teams/agents/qa-agent.md`                | 逐字复用 | 双工件零重叠（E2E .spec.ts + YAML TC-NNN）、"你写两样只跑 E2E"、确定性纪律                                        | 同上                                                                            |
| `sdlc/teams/agents/reviewer.md`                | 逐字复用 | **"Review the diff, not the tree"**、只报 HIGH/MEDIUM、越界=自动 **CHANGES REQUESTED（HIGH）**、3 次超限 ESCALATE | 多模型轮换由 DAG loop 承载（sonnet/vLLM 交替）                                  |
| `sdlc/teams/agents/gatekeeper.md`              | 逐字复用 | **"Code analysis alone is an automatic FAIL"**、基线红=AUTO-FAIL、对抗阶段、无实证报告拒收                        | 起栈方式按 project_repos.gateMode（stack/tests-only）；chrome-test 保留为其工具 |
| `sdlc/teams/agents/gap-analyst.md`             | 逐字复用 | 外部审计人格、不看 issue 清单、JSON schema（evidence 正则、NO_GAPS 约束、self_check）、实走规则                   | 输入注入：文件 → 工作流节点 inputs                                              |
| `rules/*`、`doctrine/artifact-verification.md` | 逐字复用 | "Don't Claim DONE Without Opening the Output" 全套                                                                | 追加到各 agent systemPrompt 尾部，一字不改                                      |

**verdict token 映射**（a-e §3 消息词表 → DAG 边路由，命名对齐的最后一公里）：`DONE`→进 qa；`PASSED`→进 reviewer；`APPROVED`→进 gatekeeper；`CHANGES REQUESTED` / `FAILED`→dev-fix loop；`CLEARED`→进 Phase D（diff-audit 起）；`BLOCKED`→human_gate。agent 原文的裁决词不改，DAG 边按此表路由。

**节点名 = 角色名**：issue-pipeline 的节点命名与 agent 文件一一同名
（`dev / qa / reviewer / gatekeeper`），节点的 `agent` 字段直接引用同名
定义文件——这就是"命名对齐让复用零摩擦"的具体含义。

### 2.3 编排结构（层②，结构移植）

| a-e 资产                                                                                          | 策略                    | 新系统落点                                                                                                                                 | 对应关系                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sprint-executor §2 逐 issue 流水线 + §3 消息状态机                                                | 结构移植                | 模板 `sdlc-issue-pipeline`                                                                                                                 | DONE→qa、PASSED→reviewer、APPROVED→gatekeeper、FAILED→dev-fix 的消息路由 = DAG 边与 loop；Phase D（rebase/MR/CI/顺序 squash 合入）= diff-audit→pr→ci-watch→merge 节点 + merge-base 断言 |
| sprint-executor §1 派发门（blocked-by 全部 closed+gate-cleared）                                  | 系统替代                | tracker 依赖感知调度器                                                                                                                     | "closed+gate-cleared" 的语义 =「实施完成（已合入 sprint 分支）」这一状态事实                                                                                                            |
| sprint-executor §5 Sprint Verification                                                            | 结构移植                | 模板 `sdlc-verify`                                                                                                                         | 各仓 test_cmd_full + 集成场景逐个实测，不因首败中断                                                                                                                                     |
| sprint-executor §6 Phase H 审计循环                                                               | 结构移植                | 模板 `sdlc-gap-analysis`                                                                                                                   | 3 轮上限、轮次产物持久化、blocking→from-audit 单                                                                                                                                        |
| sprint-executor §7 Phase G 晋升                                                                   | 结构移植                | 模板 `sdlc-promote`                                                                                                                        | 拓扑序、merge-commit、幂等跳过、删分支                                                                                                                                                  |
| sprint-executor 策略散文 + 11 条 Key Rules                                                        | 逐字复用                | brain runbook（markdown）                                                                                                                  | 工具调用名改为 MCP action 名，策略原文保留                                                                                                                                              |
| sprint-executor 的**隐含前提：宿主环境测试可直接执行**（dev-agent TDD 依赖 vitest/test_cmd 在场） | 系统替代（v2.2 显式化） | **工作区契约（02 §7 三不变量）**：依赖预热 + test_cmd_smoke 就绪断言归 workspace 供给管道；DAG 内另有确定性 test-runner 承载 test_cmd_full | a-e 在宿主机跑理所当然；本系统 workspace 隔离后该前提消失，自举以 SDLC-057 暴露——归属：供给管道保证、agent 消费、守卫验证（07 章簇一）                                                  |
| 标签生命周期（in-progress→…→gate-cleared；pending 只是 lead 的队列变量，非标签）                  | 系统替代                | 工作项阶段 + run 状态（映射表见 02 §1.3）                                                                                                  | 每个标签在新状态机里有唯一对应态                                                                                                                                                        |
| umbrella doctrine + `/umbrella-yaml` + `/sprint-decompose`                                        | 语义移植                | epic + `decompose-epic`（人写清单表单，无 AI 拆解）                                                                                        | YAML 中间格式消失（表单直录）；2–5 子项健康/链深≤3/环禁止等 doctrine 全量保留                                                                                                           |
| `project.yaml` + project-setup agent                                                              | 系统替代                | 项目设置 + project_repos + content《项目档案》                                                                                             | 字段一一对应                                                                                                                                                                            |

### 2.4 确定性脚本（层③，算法移植 + 对拍验收）

| a-e 资产                                                                                                                                         | 新 action                   | 对拍口径                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------- |
| `umbrella_lint.py`（三色 DFS 判环、链深>3/全线性/孤儿告警、exit 0/1/2）                                                                          | `validate-dependency-graph` | 用 a-e 历史 umbrella YAML 转成链接集，errors/warnings/topoOrder 逐条一致                        |
| `extract_briefs.py`（**全算法**：§2/§4/§5 数据模型/§6 API 表/§8 Testing Strategy/Env Vars 组装 + CREATE 文件引用与 API 生产-消费双通道依赖推导） | `extract-briefs`            | 用 a-e 历史 technical-design 原文对拍，产出 brief 集**字节级一致**（issue 号→itemKey 映射除外） |

### 2.5 产物与命名对照（docKey 权威表）

| a-e 产物                           | docKey（系统名）                                                 | 说明                                         |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| `sprint-N.md`                      | `sprint-doc`                                                     | 标题结构原样；Goal 是完成判据的锚            |
| `sprint-N-test-plan.md`            | `test-plan`                                                      | 字段原样                                     |
| `sprint-N-technical-design.md`     | `technical-design`                                               | §1–§9 原样（**不再用 tech-design 简写**）    |
| `briefs/shared.md`                 | `shared-brief`                                                   | 原样                                         |
| `briefs/issue-NNN.md`              | `brief:{itemKey}`                                                | issue 号 → itemKey                           |
| `briefs/index.md`                  | `briefs-index`                                                   | Wave 1/2 实施顺序保留（工作台 ⑦ 步的数据源） |
| 审计 report（sprint-N-audit.json） | `audit-report:{n}`                                               | schema 原样                                  |
| §5 验证输出                        | `verify-report`                                                  | 场景 PASS/FAIL + 证据                        |
| `sprint-N-story.md`                | `story`                                                          | 原样                                         |
| recap 输出                         | `recap`                                                          | 原样                                         |
| （无对应）                         | `ui-spec` / `ui-prototype` / `brainstorm-notes` / `spike-report` | 系统新增                                     |

### 2.6 相位 ↔ a-e 阶段对照（贯穿全部文档的读法）

| sprint.phase | a-e 对应                                                    | 内容                               |
| ------------ | ----------------------------------------------------------- | ---------------------------------- |
| planning     | §0 配置 + 1.1 sprint-plan + 1.2 test-plan                   | 规划与测试计划                     |
| designing    | 1.3 sprint-design + 1.4 review/briefs（+ v2 新增 UI track） | 设计三 track                       |
| executing    | §1 启动 + §2 A0–F 逐 issue 流水线                           | 派发与实施                         |
| verifying    | §5 Sprint Verification                                      | 集成验证                           |
| auditing     | **§6 Phase H gap-analysis**                                 | 目标审计（合入 base 前最后一道闸） |
| promoting    | §7 Phase G                                                  | 晋升                               |
| storytelling | §8 Sprint Story                                             | 实走验证                           |
| done         | §9 完成                                                     | 收尾                               |

## 3. 命名修正记录（本章生效时同步全文档）

- `tech-design` → **`technical-design`**（与 a-e 文件名对齐）。
- issue-pipeline 节点 `review`/`gate` → **`reviewer` / `gatekeeper`**
  （与 agent 定义文件同名；quick-task/hotfix/docs-task 中同理）。
- 模板 `sdlc-audit` → **`sdlc-gap-analysis`**（与 a-e 的 gap-analysis
  workflow、gap-analyst agent 对齐；相位枚举 auditing 不变，全文标注对应）。
- 新增 docKey `briefs-index`（对应 a-e briefs/index.md，此前遗漏）。

## 4. "能串起来"的运行时图景

```
tracker .agents/skills/          ← a-e skills 原文件（层①）
tracker actions                  ← umbrella_lint / extract_briefs 算法（层③）
tracker 状态机+调度器             ← 标签生命周期 + 派发门（系统替代，语义对照 2.3/2.6）
orchestrator .claude/agents/     ← a-e agents + rules + doctrine 原文件（层①）
orchestrator workflow 模板       ← sprint-executor 流水线结构（层②）
orchestrator brain runbook       ← sprint-executor 策略散文（层①）
content 项目文档库 / tracker UI / design 原型
                                 ← 全部是呈现壳（P11），不触碰以上任何语义
```

验收上的含义：把 a-e 的一个真实 sprint 历史（文档、briefs、审计 JSON）
灌进新系统，规划链产出应与历史产物结构一致、extract-briefs 对拍一致、
gap-analysis 的 schema 校验行为一致——这三条对拍是"复用成立"的硬证据
（对应 v1.1 实施基准 M2/M4 的既有验收场景）。
