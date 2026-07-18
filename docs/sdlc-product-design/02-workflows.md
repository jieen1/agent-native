# 02 · 流程设计：状态机、技能链、工作流族、恢复语义与 Brain 架构

> 本章定义"流程本身"。页面如何承载这些流程见 03/04/05 章。
> v1.1 已定稿的部分（数据模型增量、红线、验收纪律）此处引用不重复。

## 1. 阶段状态机

### 1.1 Sprint phase（权威）

```
planning ──plan-signoff──▶ designing ──design-signoff──▶ executing
   │                          │  (内含 UI track 与 ui-signoff)      │
   ▼                          ▼                                    ▼
brainstorm/sprint-doc     ui-spec → 原型 → UI 评审               依赖感知派发
test-plan                 technical-design → 对抗评审 → briefs         issue-pipeline × N
                                                                   │ 全部合入
verifying ◀────────────────────────────────────────────────────────┘
   │ GREEN                    RED→from-audit 单→自动修复回环→重跑
   ▼
auditing ──NO_GAPS──▶ promoting ──晋升完成──▶ storytelling ──▶ done
   │ 3 轮超限→escalation/audit-deferral（人裁决）
```

- `sprint.phase` 是流程推进的唯一权威；工作项 `currentStageName` 在
  sprint 级推进时由系统派生联动（批量 advance，失败项入活动流告警）。
- `advance-stage` 幂等 + 前置断言（fromStage / expectedRunId 不匹配 → no-op）。
- 同一项目最多一个 sprint 处于 executing~promoting（进入 executing 时断言）。
- 每道 phase 迁移的**门判据是项目级 JSON 配置**（产物存在性 + 签核 + 校验），
  改判据零代码。
- **auditing 相位 = gap-analysis**：按 sprint Goal 逐指标判定，verdict=NO_GAPS
  是进入 promoting（合入 base）的前置条件——sprint 的"完成"由 Goal 判定，
  不由工作项清单判定。

### 1.2 designing 相位的三条 track

v1.1 把设计相位当单一 track；v2.0 拆为三条各自签核的 track。三者并非无依赖并发：测试计划可与 UI 设计并行，**技术设计依赖已签核的 ui-spec、必须在 UI 之后**：

| track | 产物链 | 门 | 适用 |
|---|---|---|---|
| UI 设计 | ui-spec → sprint 原型（design 应用）→ 批注修订 | **ui-signoff** | sprint 含用户可见界面时激活（sprint-doc 的 In Scope 标注 `ui` 面） |
| 技术设计 | technical-design v1 → 对抗评审 → v2 → briefs | **design-signoff** | always |
| 测试计划 | test-plan（在 planning 相位产出，此处允许按 UI/设计结论修订版本） | 并入 plan-signoff，修订版需重确认 | always |

规则：
- technical-design 的 §4 各节与 §8 测试场景**必须引用**已签核的 ui-spec 屏编号
  与原型深链（含 UI 的 sprint）；extract-briefs 把对应屏的规格摘要
  （非 HTML）打进各工作项 brief。
- ui-signoff 先于 design-signoff（设计必须建立在定稿的 UI 之上）；
  无 UI 的 sprint 自动跳过 ui track（门配置里该判据不激活）。
- **签核失效规则**：已批签核所锚定的产物出新版本时，该 approval 置
  stale 并自动生成「重确认」审批单入收件箱（不回退相位）；重确认前
  依赖该签核的后续门判据视为未满足。test-plan 在 designing 相位修订的
  "重确认"即走此机制。

### 1.3 工作项级状态（派生 + 回写驱动）

- 实施/测试阶段由回写通道推进：run 终态 → reconciler 调 tracker
  `advance-stage(item, fromStage, expectedRunId)`。
- `plannedStages` 按类型激活子集：from-audit / 缺陷 = `实施→测试`，
  文档任务 = `实施→交付`，调研 = `分析→交付`（产物即交付物）。
- run 失败路由：工作项状态 failed 停在当前阶段，详情页给
  `重派 / 回退阶段 / 升级` 三操作；transient 类由系统自动 fork 重试一次。
- **人工完成逃生口（P12）**：人自己改代码自己合入的场景，工作项详情提供
  「人工完成」——强制附证据（PR/commit 链接，EvidenceCard 校验存在性）→
  `advance-stage(producedBy=human, evidence)`，活动流标注人工来源；
  与回写通道靠幂等断言并存。
- 回退保护：绑定非终态 run 时回退先决 = runCancel 成功。
- epic 自动闭合：全部子项到达终阶段 → epic 派生完成。
- **修复子流与派发窗口**：from-audit 单不改变 sprint 相位（verify RED 停在
  verifying、audit blocking 停在 auditing，在原相位内派发修复重验）。
  调度器派发窗口 = phase ∈ {executing, verifying, auditing}；健康门对每次
  派发生效，但系统内生的修复派发不健康时**排队等待恢复**而非拒绝；
  单活跃 sprint 断言只对其他 sprint 计数。
- **相位 → 工作项阶段派生映射**：planning=待办/分析、designing=设计、
  executing=实施（回写推进到测试）、verifying=测试（GREEN 后批量到验收）、
  auditing=验收、promoting/storytelling/done=交付；其中实施/测试内的推进
  由回写通道逐项驱动，其余为相位批量派生。

## 2. 规划域技能链（tracker 侧）

六个技能 + 一个确定性 action。产物采用**双表征**（P11）：
**agent 视图**（纯文本，schema 可校验）入 `tracker_sprint_artifacts`
（版本化 + producedByKind + supersedes；human 产物受保护；签核判据锚定
此版本）；**human 视图**由确定性发布管道渲染到 content 项目文档库的
对应位置（富 block 呈现，见 05 章 §5），`contentRef` 指向 content 页。
agent 永远只读 tracker 版纯文本。低摩擦保底（P12）：每一步都可跳过技能
访谈、直接手工导入现成文档为产物（producedByKind=human）。
技能是 markdown（`.agents/skills/*`），改措辞即生效——判断性=技能、
确定性=action。

| 技能/action | 产物 docKey | 交互形态（UI 由 03 章 Sprint 工作台承载） | 关键质量门 |
|---|---|---|---|
| `/brainstorm`（**可选**） | brainstorm-notes | InterviewCard 决策树：一次一问、**每问先给推荐答案**；四种开场（问题/半成形想法/开放问题/约束）。可整步跳过直接 `/sprint-plan`，或导入现成笔记为产物 | 可证伪门（说不出检验=想法淘汰）；锚定单一方案时强制再出两个 |
| `/sprint-plan` | sprint-doc | 完整访谈或 `--from-brainstorm` 综合模式（先给草稿只问缺口）；结束 HolisticReveal 整块揭示 | P0 删除测试；Leading+Lagging 可证伪指标，**每条带稳定编号 M1/M2…**（Goal 链全程以编号对齐：覆盖矩阵行、audit metrics[].id、Goal 卡）；**文档不含文件路径/代码** |
| `/sprint-test-plan` | test-plan | 场景卡片流：每场景 Why/Repos/Steps/Expected/**Pass-fail 信号**/执行工具/**关联指标（M 编号）**；可选 journey 节（场景在用户路径上的顺序）；无跨模块时一段式"无集成场景" | 按用户目标一场景；黑盒；信号可证伪；覆盖矩阵由关联指标字段**确定性生成**（发布管道不做判断） |
| `/ui-spec`（新增） | ui-spec | 屏清单访谈 + 逐屏规格卡；详见 05 章 §2 | 每屏有目标/主操作/数据状态；每条 In-Scope outcome 至少映射到一屏或显式声明"无界面" |
| `/sprint-design` | technical-design | 四阶段：读产物 → 深读真实代码（经 orchestrator 只读检出）→ 写设计 → 自审；产出 §1–§9 结构化文档 | 每工作项一个 §4 节；文件路径必须真实存在；§7 五列文件变更矩阵机器可解析；每个测试场景与 ui-spec 屏有实现路径 |
| `/sprint-review` | technical-design vN+1 | 多轮对抗评审：orchestrator spawnOnce 起 vLLM/sonnet 交替轮（每轮新 agent + 累计已发现清单防重复）；报告表 轮次/模型/发现/修订 | 只收高置信新发现；有效发现逐条修订进新版本（supersedes 链） |
| `extract-briefs`（action） | brief:{itemKey} / shared-brief / **briefs-index** | 一键执行 + 结果摘要（N briefs / 缺失项 / 依赖清单 / Wave 顺序） | **移植 extract_briefs.py 全算法**（§2/§4/§5 数据模型/§6 API 表/§8 Testing Strategy/Env Vars + CREATE 文件引用与 API 生产-消费双通道依赖推导）；幂等；对拍验收；ui-spec 屏摘要注入对应 brief |

Epic 拆解不是技能：`decompose-epic` action 只接受**人写好的子项清单**
（title/repo/dependsOn/touches），系统做格式校验 + 依赖图校验
（三色 DFS 判环、链深>3 警告、孤儿警告）。红线：无 AI 自动拆解入口。

## 3. 执行域工作流族（orchestrator V3 模板）

九个版本化 DAG 模板，作为**种子模板**随应用发布（解决现状"库中无种子"），
`workflowSave` 自动增版，页面可视化编辑（04 章 §5）。所有模板共同约束：

- worker 节点禁用 claude-code engine_override（CC 订阅只属于 brain）——
  引擎在 dag-validator 层强制拒绝，比模板配置更硬。
- **登记的引擎增量：`action` 确定性节点类型**（V3 现有四类节点均为 LLM/
  控制节点）——diff-audit、ci-watch、merge-pr、spec-parse、ds-lint、publish
  这些非 LLM 步骤以 action 节点承载（引用一个 action 名 + inputs 映射，
  reconciler 直接执行，无 spawn）；ciWatch 与 mergePr 能力原语承 v1.1 M3
  的既定交付。
- 判断类节点必须声明 `output_schema`（Ajv 强制 + 一次纠偏重询），
  自由文本裁决无效。
- **评审独立性（v2.2，自举簇八）**：reviewer/gatekeeper 会话必须独立于
  spec 作者——新会话/独立 agent，输入 = 需求原文 + spec + diff，且提示
  明确要求对抗性质疑 **spec 本身的设计决定**（事务性、批量化、异常
  处理、N+1 等），不只对照实现偏离。依据：自举质量调研中 brain 自审
  自写 spec 的 diff 零命中（B2 非事务三连写、B3 N+1 均为 spec 明确要求），
  而审他人代码（M3-D）抓出 5 个真 bug 含 critical——能力在，结构错。
- 每个节点声明 retry 策略（transient 自动重试）与 timeout。
- run tags 全链路携带 `{source, sprint_id, item_id, ownerEmail, orgId}`。
- **载荷契约表**（P3 的精确化，取代笼统"白名单"）：

| 工作流 | 允许注入的载荷 | 永远禁止 |
|---|---|---|
| issue-pipeline / quick-task / hotfix | brief:{item} + shared-brief + ui-spec 屏摘要 | technical-design 全文、sprint-doc 全文、他项 brief |
| sdlc-verify | 上行 + **test-plan 场景节**（结构化提取） | 同上 |
| sdlc-gap-analysis | **goal-metrics 节**（sprint-doc 的 Goal 与编号指标，确定性提取）+ 跨仓 diff + 验证日志 | technical-design、issue 清单 |
| sdlc-ui-build | ui-spec 全文 + designSystemId | 其余产物 |

### 3.1 `sdlc-issue-pipeline` — 单工作项实施流水线（核心）

适用：sprint 内每个开发类工作项一个 run。

```
workspace(worktree @ sprint-N)
→ dev        [vLLM 默认/按仓 devModel 切 sonnet] TDD：红测试先提交
→ qa         [vLLM] 双工件（E2E + 集成 YAML）；失败→loop 回 dev
→ reviewer   [loop ≤3，sonnet/vLLM 交替，累计发现清单] 只审 diff；越界=FAILED；超限→human_gate(escalation)
→ gatekeeper [sonnet] 按 project_repos.gateMode：stack=起栈实测 / tests-only=全量测试+diff 审查 / none=跳过
→ diff-audit [确定性节点] 变更文件 ⊆ brief.touches，越界=FAILED 回 dev
→ commit+PR  (workspaceCommitPush → sprint-N)
→ ci-watch   [REST，ciMode=none 短路]
→ merge-pr   [顺序锁；断言 merge-base==sprint-tip，不满足→回 dev rebase→重入 qa/reviewer/gatekeeper]
→ 终态 → reconciler 回写 tracker
```

UI 类工作项附加：dev 节点 prompt 注入对应 ui-spec 屏规格 + 原型深链；
gatekeeper 节点（stack 档）附带按 ui-spec 主流程的截图证据。

### 3.2 `sdlc-verify` — Sprint 集成验证

各仓 `test_cmd_full`（parallel_over）→ 集成场景逐个真实执行（不因首败中断，
结构化 PASS/FAIL + 证据）→ FAIL → 经回写通道建 from-audit 单
（targetBranch=sprint 分支，`/draft-fix-issue` 生成单体：
Trigger / What's broken / Suspected boundary / Brief）→ 自动进派发。
无集成场景的 sprint：全绿即 GREEN。

### 3.3 `sdlc-gap-analysis` — 目标审计 / gap-analysis（反奉承）

即原流程的 **Phase H gap-analysis**——晋升合入 base 前的最后一道闸；
判定基准是 **sprint-doc 定下的 Goal 与可证伪成功指标**，不是"单子是否关完"。
输入 = sprint Goal 与成功指标 + 跨仓 diff + 验证日志（**不含 issue 清单/设计文档**）。
output_schema 强制：metrics[]（**id=sprint-doc 的 M 编号**，status ∈ MET|PARTIAL|UNMET + evidence 匹配
`repo:file[:line] | PR#n | sha | absence-of:<pattern>`），"done/✓"类字样拒收；
NO_GAPS 不得与任何 P0 非 MET 并存；用户可感能力必须有真实非种子输入的
运行证据，demo-only=PARTIAL+blocking。轮次产物 `audit-report:{cycle}` 持久化；
blocking→from-audit 单；3 轮超限→escalation/audit-deferral。

### 3.4 `sdlc-promote` — 晋升

依赖拓扑序逐仓，单节点 vllm agent 在 workspace 内直接操作 git
（不经过 PR/CI，生产验证过的直接 merge 方式）：

```
git fetch origin --prune                          # prune 让已删分支本地也不可见
→ 幂等检查：origin/<sprint> 已不存在？            # 上次晋升已完成并清了分支
    是 → already-promoted（分支不存在），跳过不报错
    否 → COMMITS_AHEAD = rev-list --count origin/<base>..origin/<sprint>
       =0 → already-promoted（无领先提交），跳过，不删分支
       >0 → checkout <base> && merge --no-ff origin/<sprint>   # merge-commit 保留 sprint 边界
            冲突 → 报告冲突并停止（顺序合并红线：不自动解、不 force push）
            成功 → push origin <base> → git push origin --delete <sprint>   # 删远程 sprint 分支
                  删除失败（如权限不足）→ 报告，但不回滚已完成的合并
```

报告口径：COMMITS_AHEAD 数、是否晋升、merge-commit sha 或 skip 原因
（区分"分支不存在"与"无领先提交"）、是否有冲突、sprint 分支是否已删除。
绝不 force push，绝不自动解冲突。

### 3.5 `sdlc-ui-build` — UI 原型流水线（新增）

适用：designing 相位 UI track；输入 = 已定稿 ui-spec + designSystemId。

```
spec-parse   [确定性] ui-spec → 屏清单 + 每屏规格
→ parallel_over(屏) screen-gen [vLLM] 按 Foundry 设计系统生成自包含 HTML 屏
→ ds-lint    [确定性] tokens 存在性/禁 emoji 图标/data-screen 链接完整性检查
→ consistency-review [sonnet, output_schema] 跨屏一致性（导航、状态、术语）
→ publish    [确定性] create-design + create-file 入库 design 应用，回写
             tracker 产物 ui-prototype(contentRef=design:<id>) 
```

失败路由：ds-lint 违规项回 screen-gen 定点重生成（loop ≤2）；
consistency-review 的 output_schema 为 findings[]（screen / kind: nav|state|term|copy / severity: blocking|advisory / detail / suggestion），blocking 判据=会导致用户流程断裂或跨屏语义冲突；blocking 以批注写回 ui-spec 待人处理，advisory 仅记录。

### 3.6 `quick-task` — 快速任务（短流程）

适用：单工作项、无 sprint 编排的小改动（executionMode=auto 且类型=任务，
或人工选择）。**跳过规划/设计相位**，工作项 plannedStages=`实施→测试`。

```
workspace(@ base 分支) → dev [vLLM] → qa [vLLM] → reviewer [sonnet ×1]
→ commit+PR → ci-watch → （人工合并 或 mergePr 按项目配置）
```

### 3.7 `hotfix` — 缺陷热修

适用：类型=缺陷/生产问题。红测试优先纪律强化：

```
workspace → reproduce [vLLM] 写复现失败测试（必须先红，附失败输出证据）
→ fix [vLLM/sonnet 按严重度] → regression [全量 test_cmd_full]
→ reviewer [sonnet ×1] → commit+PR → ci-watch → merge-pr
```

### 3.8 `docs-task` — 文档任务

```
draft [vLLM，读代码/产物] → reviewer [sonnet, output_schema 事实核查清单]
→ publish [确定性] content 应用 create-document/edit-document（NFM 约束）
```

### 3.9 `spike-research` — 调研任务

```
explore [sonnet/vLLM，只读 workspace] → report [output_schema：
结论/证据/选项对比/建议] → 产物入 tracker（docKey=spike-report），无代码合入
```

### 3.10 工作流选择器

**拆分契约（决策序之前的前置检查，v2.2 自举簇九）**：spec/brief 涉及
>6 个文件、或跨生命周期协同（schema+action+页面+调度器联动）→ 拒绝
单节点派发，强制拆为多个 dev 子任务（issue-pipeline 多节点或多工作项，
规划工作台给规模告警与一键拆分，03 §6）；执行期 vLLM 单节点输出预算
耗尽 ≥2 次自动定性"规模超标"回规划拆分，不换更大模型硬扛。依据：
1–6 文件级 spec 下 vLLM 一次交付扎实，12 文件级（655/846 行 spec）
连续预算耗尽且 brain 被迫代写（作者身份转移的成因链之一）。

规则按**决策序**匹配，命中即停：① 人工覆盖 → ② from-audit 单
（一律 issue-pipeline 的命名预设 `mode=fix`——模板库中显示为 issue-pipeline
卡内的预设、随模板版本化；节点形态复用 hotfix，基于且合回
targetBranch=sprint 分支，不走独立 hotfix 模板）→ ③ 类型专用模板
（缺陷 sprint 内以 sprint 分支为基）→ ④ 派发窗口内 sprint 的开发项
→ issue-pipeline（窗口外等待相位）→ ⑤ 无 sprint + auto → quick-task。

| 输入 | 规则 |
|---|---|
| 工作项类型 | 缺陷/生产问题→hotfix；文档→docs-task；调研→spike-research；from-audit→issue-pipeline 的 fix 子集（复用 hotfix 形） |
| 所属 sprint | 在 executing sprint 内的开发项→sdlc-issue-pipeline（继承 sprint 分支） |
| 无 sprint + auto | quick-task |
| 项目配置 | 项目设置里可改"类型→工作流"映射与各模板默认参数（模型档、评审轮数、gateMode） |
| 人工覆盖 | 派发面板可显式选任一模板 + 覆盖 inputs |
| brain 建议 | brain 在派发前可建议换模板（如 quick-task 项发现涉及三个模块→建议升级 issue-pipeline），建议以待确认卡片呈现，不自动改 |

## 4. 可恢复与重试语义（homerail 移植到 V3）

V3 已有：advisory-lock tick、错误分类(transient/schema/permanent/cancelled)、
schema 一次纠偏、patch(未来)/fork(过去)、幂等事件、spawn_events 溯源。
v2.0 增强（全部为设计承诺，UI 均有呈现点）：

| # | 语义 | 现状 | 设计 | UI 呈现 |
|---|---|---|---|---|
| R1 | 孤儿运行降级 | **新增**（需 v3_spawns 加心跳列，见 04 §13） | 进程重启时仍 running 且 spawn 无心跳的节点 → failed("node lost: restart")，走失败路由而非悬挂 | 运行详情节点卡显示"进程重启降级"事件 |
| R2 | 事件溯源恢复 | 部分已有（reconcile-on-startup 存在） | reconcile-on-startup 以 v3_events + 节点终态重建调度状态；DB 权威、日志尽力 | 健康页显示"上次恢复：N run 复原" |
| R3 | 有界纠偏 | 部分已有（schema 纠偏 1 次与 loop maxIterations 已在引擎强制） | 评审 loop ≤3、审计 ≤3 轮、run 级 max spawn 上限；耗尽→escalation 而非静默 | 节点卡显示 attempt 计数；超限自动出审批单 |
| R4 | 检查点重试 | 新增 | nodeRetry 支持"从上次成功产物续跑"（fork spawn transcript，新 spawnId，attempt+1，父链保留） | NodeInspector 的 attempt 时间线，可从任一 attempt 重试 |
| R5 | 过期栅栏 | 部分已有（currentSpawnId 列已存在，栅栏语义新增） | node.currentSpawnId 不匹配的 spawn 事件一律丢弃（fork/重试后防竞态） | — |
| R6 | 失控上限 | 部分已有（节点级 maxIterations 已强制；run 级为新增） | run 级 max_dispatches 显式配置于模板，超限 abort + 事件 | 模板编辑器暴露上限字段 |
| R7 | 首目标就绪门 | 新增 | 恢复后的 ready 节点等 vLLM/CC 健康检查通过再派发 | 健康页 + run 事件"等待运行时恢复" |
| R8 | scorecard 归因 | 新增 | run 终态自动评分（pass/needs-attention），失败按 prompt/tool/engine/template/harness 五层归因 + next_steps | 洞察页归因面板（04 章 §11） |
| R9 | spawn 终态传导不变量 | **新增**（自举 SDLC-050：reconcile 判死 spawn 后节点悬挂 running、不可 retry 不再入队） | **不存在 spawn 已终态而其 node 仍 running 超过一个 tick**——spawn 的任何终态来源（正常结束/心跳超时/reconcile 重置/人工取消）都必须在同一事务内驱动 node 状态迁移（failed→按失败路由重试或重新入队）；违反由 reconciler 断言修正并发 `node.reconciled` 告警事件。runCancel 幂等且成功必须返回成功（SDLC-050 附带缺陷） | 运行详情节点卡显示"传导修正"事件；健康页计数 |

### 4.1 执行器上下文契约（v2.2 新增，自举簇十）

worker 引擎（runAgentLoop）此前是裸循环：消息只增不减（每次 Read 的
文件全文、每轮 thinking 全部滞留窗口），溢出物理窗口即截断失败，且
attempt 重试从零重跑同一任务→确定性再溢出。brain（CC）有自动
compaction，worker 没有——上下文是 worker 最稀缺的资源，必须有生命
周期管理，与 brain 能力对等：

| # | 契约 | 说明 |
|---|---|---|
| C1 | 工具结果窗口化 | Read 按需截取（行区间/符号级），大结果只保留头尾+摘要；同文件重复读取返回增量 |
| C2 | 超阈自动折叠 | 窗口占用超阈值（如 70%）时，把已完成步骤的工具往返折叠为结构化摘要（保留决策与产物清单），继续执行而非等死 |
| C3 | 截断续写 | 截断/溢出失败的重试 = **携带已完成产物续写**（R4 检查点重试延伸到上下文场景：已写文件清单+剩余任务作为新起点），禁止从零重跑 |
| C4 | 与拆分契约互补 | §3.10 拆分契约在规划期降低上下文需求；本契约在执行期保底——两者缺一不可（拆分防线漏网的任务靠 C1–C3 存活） |

## 5. Brain 可替换架构

### 5.1 引擎注册表

Brain 引擎是配置数据（表 `brain_engines` 或等价配置），不是硬编码分支：

| 字段 | 说明 |
|---|---|
| id / name | `claude-code` / `sdk-vllm` / `acp:<agent>` … |
| kind | `cli-resume`（CC 式子进程会话）/ `sdk`（AI-SDK 循环）/ `acp`（ACP 协议 agent） |
| modelRef / tier | 引擎默认模型与允许档位 |
| health | 登录态/端点可达性探测方式 |
| capabilities | 是否支持 resume / 上下文窗口上报 / usage 上报 |

契约（任何引擎必须实现）：`startTurn(threadId, message, cwd, mcpConfig)`
非阻塞开启一轮；轮内事件持久化到 brain_events；会话可恢复
（session_id 或等价物持久化）；被 wake（run/节点终态、周期漂移）时以
一条消息恢复。MCP 工具面（orchestrator 全 action 目录 + JWT）对所有引擎一致。

### 5.2 选择与降级

- 线程级选择：新建线程可选引擎（默认=全局默认引擎）；运行中不可换，
  可 fork 新线程换引擎接管。
- 自动降级：默认引擎不健康（CC 未登录/探测失败）→ 新任务落到兜底引擎
  （sdk-vllm），UI 明示"当前以兜底引擎运行"而非静默。
- 双 BRAIN_PROMPT 收敛为单一出处（brain-prompt.ts），引擎按 kind 拼装差异段。

### 5.3 Brain 的职责边界（红线重申）

brain 只做：接收派发、按 runbook 选模板/authoring DAG、workflowRun、
被唤醒时 review 汇报、commit/PR 叙述。**不做**：状态推进（归回写通道）、
代码直改（归 DAG 工人）、自动拆解需求（归人）。
brain 全部代码变更必须经 workflowRun 的 DAG（vLLM develop 节点），
禁止 Bash/Task 直改。自举实战（SDLC-052）证明**提示词红线拦不住任何
一步**（brain 实际发生了 printf 追加、误 checkout 回退、Write 整文件
重写三级递进）——红线必须由 §5.4 能力面矩阵机制背书（00 章 P13），
Brain 控制台的 workflowRun 计数与直改告警数只是可观察证据，不是约束。

### 5.4 能力面矩阵（角色 × 相位 → 机制化能力，v2.2 新增）

红线的机制背书：每个角色在每个相位的工具面与文件系统权限是**引擎配置**
（brain 引擎注册表的 capability profile / DAG 节点的工具面声明），
不是提示词承诺。越界操作机制上不可为；配置漏洞导致的越界由审计告警
兜底（发生即可见）。

| 角色 | 相位/节点 | workspace 权限 | 工具面 | 说明 |
|---|---|---|---|---|
| brain | 分析/派发 | 只读 | MCP 全目录 + Read/Grep 类；**无 Write/Edit，Bash 白名单只读命令** | 深读代码写 spec 允许；写文件不可为 |
| brain | 评审（run 终态唤醒） | **只读挂载** | 同上 + workspaceDiff/nodeSummary | 发现问题→重派 dev 节点 fix 模式（携带评审发现清单），不亲手修 |
| dev/qa (vLLM) | develop/qa 节点 | 读写（本 workspace） | Read/Edit/Write/Bash（含测试执行；依赖工作区契约 §8 供给） | 唯一合法代码作者 |
| reviewer/gatekeeper | 评审/守门节点 | 只读 | 只读 + 测试执行 | 产出结构化 verdict，不改代码 |
| action 节点 | 确定性步骤 | 按 action 声明 | 无 LLM | diff-audit/ci-watch/merge-pr 等 |
| 人 | 任意 | 完全 | 页面 + 受守卫 action（§9） | 人工完成逃生口带证据（P12） |

## 6. 回写通道与健康门（继承 v1.1，UI 呈现点）

- 三层通道：reconciler 确定性回写（主，orchestrator 侧 tracker-client，
  身份取 run tags 铸 JWT）→ get-activity 轮询（兜底）→ brain 叙述（不推状态）。
  幂等 advance 保证双通道不重复。
- 健康前置门：sprint 进 executing、以及每次派发前检查 vLLM / CC 登录 /
  brain 并发槽；人工与常规派发不健康**立即拒绝**并把原因写到 sprint 页与
  队列页（不是深处超时）；系统内生修复派发（from-audit 回环）排队等待恢复。
- UI 呈现：tracker 队列页显示每次派发的健康检查记录；orchestrator 健康页
  显示门的当前状态与最近拒绝原因；工作项活动流记录回写来源
  （`回写:reconciler` / `回写:轮询`）。

## 7. 工作区契约（v2.2 新增，自举簇一）

"工作区"是 dev/qa/reviewer 的全部世界，因此是有供给规范与验收条件的
一等对象，不是 `workspaceCreate` 的实现细节。

**就绪不变量**（三条全过才算 ready，任何一条不满足 = infra 故障，
run 不得开始；违反不记为 agent 失败）：

| # | 不变量 | 断言方式 | 对应自举问题 |
|---|---|---|---|
| W1 | 基线新鲜：workspace.base == 镜像目标分支 @ 派发时刻（merge-base 距离 0） | workspaceCreate 后即断言；克隆缓存/池化工作区必须先 fetch+reset | SDLC-056(1f2igmbdch)：3 天旧基线造成本可避免冲突 |
| W2 | 依赖已预热：node_modules 可用（共享 pnpm store 硬链，秒级），无需也不允许节点内 pnpm install | 供给管道完成安装；develop 提示词维持"禁止装依赖"（职责归供给，不归 agent） | B1 brain 替 dev 装依赖 48 次 Bash；SDLC-057 |
| W3 | 测试可执行：`test_cmd_smoke`（如 vitest --version + 空跑）通过 | 就绪探测的一部分 | SDLC-057：dev 自述"环境无 vitest"，TDD 纸上谈兵 |

**存续期规则**：

- **staleness 事件**：run 存活期间镜像目标分支前进 → run 收到
  `workspace.stale` 事件（brain 唤醒消息附带），交付节点（commit/merge）
  前置断言 merge-base==目标分支 tip，不满足→rebase 检查回环（承 §3.1
  merge-pr 既有断言，把防线提前到交付前）。
- **观测基线正确性（W4，v2.2.1 新增，SDLC-059）**：对比类观测工具
  （workspaceDiff / runSummary 的 diff 统计等）的基线必须在**调用时**
  动态求 `merge-base(HEAD, 镜像目标分支 tip)`，禁止使用创建时记录的
  静态基线（克隆缓存下必然过期——B4 实测 2.3MB/221 文件的误导 diff）；
  基线不可得时返回显式错误，而不是一个"看起来像 diff"的错误答案。
  评审卡与守门读的就是这些工具，**观测错=守门错**。
- **测试证据为交付前置**：develop/qa 节点交付必须附测试执行证据工件
  （命令+输出+退出码，EvidenceCard 呈现）；"测试不可执行"不是可接受的
  交付说明（W3 保证它不会发生）。**涉及 schema 变更的交付，测试证据
  必须包含迁移冒烟档（v2.2.1，SDLC-061）**：对空库执行全部迁移后断言
  schema 中每张表/列存在——自建 schema 的内存库测试**不构成**建表证据
  （B5 实测：测试全绿而生产迁移缺失）。

## 8. 状态迁移守卫（v2.2 新增，自举簇三/七）

门判据（§1 相位门）之下的更基础层：**每个状态迁移允许谁写、必须带什么
证据**。守卫在 action 层强制（写入方身份来自 JWT/run tags），页面与
agent 走同一守卫。

| 迁移 | 合法写入方 | 必需证据载荷 | 失败行为 |
|---|---|---|---|
| 派发（待办→实施） | 仅记 execState=dispatched；**业务阶段不因派发而推进**（v2.2.1，SDLC-063） | threadId（+runId 到位后补） | brain 首轮零交付失败 → execState 回 queued + 审计事件；业务阶段无需回退（因为从未推进）——阶段推进统一由交付证据驱动 |
| 实施→测试 | 回写通道（reconciler/轮询，expectedRunId 断言） | runId + branch + 测试执行证据引用 | 断言不符 no-op（幂等） |
| →待人工评审 | 回写通道（run 终态且交付分支存在） | runId + branch + diff 统计 + 测试证据 | 缺证据→失败路由，不得静默 done |
| 待人工评审→done | **仅人**（收件箱"评审请求"卡/工作项页），或带 PASSED verdict 的 gap-analysis 记录 | 评审 verdict（PASSED/CHANGES_REQUESTED）+ 合并 commit | agent 写 done 一律拒绝（SDLC-056/5rmlahjmxg 的机制性回答） |
| 人工完成（任意→交付） | 仅人 | PR/commit 链接（EvidenceCard 存在性校验） | 无证据拒绝（P12 逃生口仍有底线） |
| 关闭（未派发项） | 仅人（受守卫 close action，强制 reason） | reason 文本 | 写审计；agent 不可关闭 |
| 回链更新 | 与状态迁移同事务 | orchestrator_run_id / branch 为迁移必填载荷；**重派=新迁移=同步更新回链** | 缺载荷拒绝（SDLC-053） |

**标识分配权威**（簇七）：一切全局单调标识（itemKey、迁移版本号）必须
单点分配——itemKey 由 tracker 项目级序列器在 create 时分配（DB 序列/
advisory lock，调用方不报数）；迁移以内容哈希+命名空间登记身份，数字序
仅在合并线性化时单点重排；撞号在分配时失败出声，禁止静默跳过
（SDLC-037/038，后者在本章写作当天以"两个 SDLC-056"再次复发）。

## 9. tracker 依赖感知调度器（确定性）

- exec_queue 升级为调度器：blocked-by 全部"实施完成（合入 sprint 分支）"
  才可派发；每次实施完成事件重评估解锁项（re-eligibility），自动派发，
  无人工触发。
- 队列优先级 = priority + 人工置顶（持久化）；同仓合并顺序由 merge 锁
  保证串行，调度器不并发派发互相依赖的项。
- 每次派发过健康门 + brief 白名单检查（仅 brief/shared-brief/ui-spec 摘要）。
- 暂停/恢复是真实调度器开关（全局与按 sprint 两级）。
