# SDLC 实施规划(R1–R5 执行版,2026-07-16)

> 状态:**执行权威**,取代《SDLC 实施路线图(落地版)》§2–§4 的旧排期作为下一步执行依据。
> 本文不改任何验收判据——判据逐条继承自《SDLC 现状对齐审查(2026-07-16)》§四与
> 《SDLC 实施路线图》§2,本文只做**执行级展开**:把骨架拆成工作包、落到文件、排出依赖与量级。
> 写作纪律:已交付的说已交付,未验证的说未验证;凡本次写作过程中核实到与既有文档
> 不符的现状,直接订正并注明证据(commit/文件/行号),不为了让骨架"看起来齐"而回避矛盾。

## §0 定位

文档链(从设计到执行):

```
产品设计 v2.2(00–07 章,docs/sdlc-product-design/)
  → 《SDLC 实施路线图(落地版)》(docs/sdlc-implementation-roadmap.md,阶段一 F0–F10 历史,已交付)
    → F1–F4 / F5–F10 实施细则(docs/sdlc-product-design/sdlc-impl-f1-f4.md / sdlc-impl-f5-f10.md,地基实现明细)
      → 《SDLC 现状对齐审查(2026-07-16)》(docs/sdlc-alignment-review-2026-07-16.md,
        线上 /page/g2dm0YpO1OnU;现状与 R1–R5 骨架)
        → 本文(R1–R5 的执行级展开:工作包 / 文件级落点 / 依赖 / 验收)
```

本文的关系边界:

- **不改判据**:每个工作包(WP)的验收判据都标注"继承自"何处,原文引用或紧贴原文转述,
  不自创更松的替代判据。
- **不代替走查**:本文给出的是"按什么顺序、落在哪些文件"的执行地图,不是宣告某项已完成——
  除非本文明确写"已核实:已交付"并给出证据。
- **取代对象明确**:仅取代路线图 §2(阶段二场景剧本的"下一步做什么"排期)与 §3–§4(阶段三/四
  的排期);路线图 §0/§1(地基的设计动机与 F0–F10 验收门本身)、§5(反堆砌护栏)继续有效,
  本文引用不重复。

### 0.1 本次写作核实到的一处重要偏差(先说清楚,避免读者按旧文档误判工作量)

《对齐审查》§1.11a 与 03 章现状描述都称"S4 受守卫流转对话框(F3)——shield-lock 入口已加,
对话框本体未做"。**本次执行级展开前逐文件核实(`git blame`/`git log -S` 定位),该说法已过期**:

- `templates/tracker/app/pages/WorkItemDetailPage.tsx` 的 `GuardedTransitionDialog`
  组件(约 :1359 起)已经完整实现:目标状态选择器只列 `get-work-item` 返回的
  `allowedTransitions`(底层 `server/lib/transition-guard.ts:386` 的
  `allowedTransitions()`,由 `actions/get-work-item.ts:129` 调用)、强制 reason(≥4 字符)、
  按目标状态动态要求证据(`done` 需 commit 正则校验、`交付` 需 commit 或 links、`closed`
  免证据)、`useTransitionWorkItem()`(`app/hooks/use-tracker.ts:360`)调用
  `transition-work-item` action、服务端 `evidence-missing` 错误在对话框内展示且不清空已填
  字段、悲观刷新(不做乐观更新,避免守卫驳回后本地状态与服务端不一致)。
- `git blame`/`git log -S "GuardedTransitionDialog"` 定位:整块实现落在 commit
  `41fe0b51b`(2026-07-12,"chore(f0): unify trunk — overlay tracker F5/F6/F8/F9 onto
  post-refactor orchestrator-f0 base"),**早于**《对齐审查》与 03 章现有措辞的写作时间点,
  且该 commit 是 HEAD(`cb4051466`)的祖先。

处置:本文 §3 的 WP-R3.1 按"已交付、非待办"记录,保留验收判据供未来回归核对,不计入
R3 的待办工作量;建议本文发布后另开一次对《对齐审查》§1.11a 与 03 章§4/§11 相应措辞的
小订正(不改判据,只更新状态描述)。

### 0.2 核实方法

repo 定位于 `/home/bot/project/agent-native`,主干 HEAD 为 `cb4051466`(与本次任务指定的
`main@cb4051466` 一致)。所有"已知代码锚点"逐一用 `grep`/`git blame`/`git log -S`/`git
merge-base --is-ancestor` 核实,凡本文引用的文件路径与行号均为本次核实所得,不是从旧文档
照抄。DB 运行时事实(如孤儿 SDLC-042、101 部署状态)不可从 repo 核实,按《对齐审查》原文
引用,标注"未在本次核实范围"。

---

## §1 R1 · 让系统重新转起来(先决,当周可完成)

> 目标重述(继承《对齐审查》§四):解除"机制已交付但四天未被真实运行触发"的停摆状态,
> 把 F 项机制从"代码在、部署在、从未验证过"变成"跑过一次、有计数证据"。

### WP-R1.1 修复 `v3-reconciler.spec.ts` CPU 卡死(既有 bug,先于任何 reconciler 回归验证)

- **目标**:定位并修复该 spec 文件在纯净 main 上以 99% CPU 卡死的根因(疑似某 `it()` 顶层
  同步死循环或死等,`vitest` 的 `testTimeout` 对同步死循环无效),恢复其可在合理时间内
  跑完退出,为 `checkRunLimits` 与后续 reconciler 改动提供自动化回归网。
- **涉及文件**:
  - `templates/orchestrator/server/engine/v3-reconciler.spec.ts`(2153 行,定位与修复对象)。
  - `templates/orchestrator/server/engine/v3-reconciler.ts`(被测对象;`checkRunLimits`
    定义于 :1853,由 :282-283 调用)。
- **依赖**:无。可与 WP-R1.3 的准备工作并行,但物理上应先于 WP-R1.2 的部署完成,降低"带着
  已知卡死 bug 部署"的认知负担。
- **验收判据**(继承《对齐审查》§四 R1 "🆕 独立发现"段):该 spec 文件在纯净 main 上不再
  99% CPU 卡死,可在正常 `testTimeout` 内完成;`checkRunLimits` 具备可运行的测试覆盖。
- **量级**:0.5–1 天(定位是主要成本;确定死循环位置后修复通常是小改动)。

### WP-R1.2 部署 `1fd9783fb` 到 101(运行限额兜底 + workspaceCiWatch + workspaceMergePr)

- **目标**:把已合入 main、尚未部署的 sdlc-issue-pipeline 抢救移植成果推上 101,解除
  "运行限额兜底/CI watch/PR merge"停在"✅代码 ❌部署"的状态。
- **涉及文件**(本次核实,`1fd9783fb` 实际改动的 7 个文件,本 WP 不改代码只做部署动作):
  - `templates/orchestrator/actions/workspaceCiWatch.ts`
  - `templates/orchestrator/actions/workspaceMergePr.ts`
  - `templates/orchestrator/actions/v3-workspace.ts`
  - `templates/orchestrator/server/db/v3-schema.ts`
  - `templates/orchestrator/server/engine/v3-reconciler.ts`(`checkRunLimits` 落点)
  - `templates/orchestrator/server/plugins/db.ts`(`sdlc-run-limits` name-based 幂等迁移)
  - `templates/orchestrator/server/v3-workspace-local.ts`
- **依赖**:WP-R1.1 建议先行(降低卡死 bug 干扰验证判断的风险);对齐审查原文的硬门槛是
  "先跑一次真实运行验证 `checkRunLimits`"本身——若排期紧张,也可以让 WP-R1.3 的小票场景
  兼作这次真实运行验证,验证通过后部署,WP-R1.1 补测试跟进。两种序均可,本文建议
  WP-R1.1 先行。
- **验收判据**(继承《对齐审查》§1.12 "执行前置"两条):①隔离靶位——不得针对共享
  `an-postgres` 生产库与 18 应用共用的常态容器做破坏性注入,一次性库/维护窗口单独操作;
  ②brain 以 API key 运行(非个人订阅)。部署后 `checkRunLimits` 在一次真实 run 上被触发
  并观察到预期行为。
- **量级**:0.5 天(部署动作本身,含回滚预案)。

### WP-R1.3 清理孤儿 SDLC-042 + 复活「SDLC自举」dogfood 循环(首次真实运行验证)

- **目标**:清掉 running 无 `run_id` 的孤儿状态;从 tracker 建一张小票 → dispatch →
  orchestrator 跑通一个 V3 run,作为 F 项机制的首次真实验证。
- **涉及文件**:无代码改动(纯运行时/运维动作)。涉及但不改动:tracker
  `actions/dispatch-to-orchestrator.ts`、orchestrator `server/engine/v3-reconciler.ts`
  的运行时行为。
- **依赖**:建议在 WP-R1.2 之后做,以覆盖到部署后的 CI watch/PR merge 全链路;若小票场景
  不需要走到 merge-pr,也可与 WP-R1.2 并行,不互相阻塞。
- **验收判据**(逐字继承《对齐审查》§四 R1):v3_runs 出现 07-16 后的新 run;F4 phase、
  F7 model_real_name、F9 回写事件三个计数从 0 变为正数——这一条同时是 F 项机制的首次
  真实验证。
- **量级**:0.5–1 天(含孤儿数据核对与清理、观察一次完整 run 生命周期的等待时间)。

---

## §2 R2 · 场景①端到端走通(脊柱场景)

> 目标重述(继承路线图 §2 场景①):单 issue 全流程——建单→规模门→派发→自动开发
> (dev→qa→reviewer→gatekeeper→diff-audit)→commit+PR→ci-watch→merge-pr→回写→
> 守卫流转→验收→PR 合并,业务全程零人工 SQL,状态轨迹与证据链完整可查。

### WP-R2.1 起草并执行"脊柱场景①"验收剧本

- **目标**:用一张真实(非测试)issue 走完全链路,验证 F1–F10 全部机制在真实压力下不
  静默失效,而不只是 WP-R1.3 那种最小规模的单节点验证。
- **涉及文件**:无预先新增代码。若走查中暴露地基缺陷,按路线图 §5.2 止损判据"回阶段一修
  并补故障注入用例",此时才产生具体文件改动——不可预判,视走查结果另开 issue。
- **依赖**:R1 三个 WP 全部完成(尤其 WP-R1.3 已验证过最小 run,R2 要把同样链路走一次
  完整脊柱剧本,规模更大,且要覆盖 WP-R1.3 未必触达的人工评审→守卫流转→PR 合并几步)。
- **一处需要明说的排序张力**:路线图原文把场景①的"依赖"写为"F1-F10 全部",但场景①的
  验收判据本身要求"从 issue 页经(a)(b)(c)(d)四条链能还原完整证据链"——而这四条链
  正是 §3 R3 的交付物(路线图原文:"这四条链任一不可点=场景①未收口")。也就是说，
  R2 与 R3 之间不是严格串行:
  - R2 可以先在"业务全程走通、守卫记录齐全"层面完成验证——证据可以先经 orchestrator
    既有的 `RunView`/`WorkspaceView` 页面查看(03/04 章本来就把这两页设计为证据入口，
    不算破例)。
  - 但"issue 页一键可达全部证据"这一条判据，要等 R3 的 WP-R3.3 补完深链后才最终收口。
  - 详见 §7 的顺序表。
- **验收判据**(逐字继承路线图 §2 场景①):业务全程零 SSH/psql;每个状态迁移都有守卫
  记录;从 issue 页经四条证据链能还原完整证据链。
- **量级**:1–2 天(以真实 issue 的实际处理时长为主,人工观察与记录为辅)。

---

## §3 R3 · 给机制接上 UI 通路

> 目标重述(继承《对齐审查》§四 R3):守卫流转对话框、收件箱、issue 页证据链、队列审批
> 真实化四处优先,随后模型注册表页、健康页;本轮额外要求两应用挂载框架 Agent 页、
> Foundry v3 动效在生产界面落地。**验收总纲**:一个人不碰 agent 聊天窗,纯 UI 走完
> 场景①的人工环节。

### WP-R3.1 受守卫流转对话框接线 —— 核实结论:已交付,非待办

- **原定目标**:把 `transition-work-item` 接入 `WorkItemDetailPage` 状态区,替换只读 chip。
- **核实结论**:见 §0.1。已完整交付于 commit `41fe0b51b`(2026-07-12),早于本次规划的
  上游文档写作时间点。
- **保留判据**(供未来回归核对,不是新开发用):路线图 F3 可证伪验收①②③(直接写
  done 无 verdict 被拒绝;派发只记 execState 不推进业务阶段;未派发项经
  `transition-work-item` 关闭且 audit-log 有行)——本次核实只确认了"UI 层存在受守卫
  选择器+强制 reason+证据字段"这一形态,**未**重新跑三连故障注入,该注入仍按
  《对齐审查》§1.12 地基验收门第 3 项执行,不因 UI 已在场而免验。
- **依赖**:无(已完成)。
- **量级**:0(已交付);如需要,0.5 天做 §1.12 故障注入的 UI 层复核。

### WP-R3.2 收件箱页面(`/inbox`)+ `list-inbox`/`resolve-inbox-item` action —— 全新

- **目标**:建 03 章 §2 定义的收件箱页(签核/评审请求/裁决/失败路由/通知五分组),把
  "人被打断的唯一入口"从零建成。本次核实确认 `list-inbox`/`resolve-inbox-item` 在
  `templates/tracker/actions/` 目录中确实**不存在**,`/inbox` 路由与页面也不存在。
- **涉及文件**(新建为主):
  - `templates/tracker/actions/list-inbox.ts`(新)——聚合 `tracker_approvals`(签核+
    裁决)+ 待人工评审工作项 + failed 工作项(失败路由)+ 只读通知,按 03§2 五个
    分组返回。
  - `templates/tracker/actions/resolve-inbox-item.ts`(新)——统一批准/驳回入口,按
    item 类型分派到既有 `actions/approve-gate.ts`/`actions/reject-gate.ts`(签核+裁决)
    或 `actions/transition-work-item.ts`(评审请求的批准合并/驳回返工)或工作项失败
    路由动作,复用既有守卫而非重复造轮子。
  - `templates/tracker/app/pages/InboxPage.tsx`(新)——两栏 list+detail,GateBanner/
    EvidenceCard 复用 01 章既有组件。
  - `templates/tracker/app/routes/inbox.tsx`(新,flat-route 注册 `/inbox`)。
  - `templates/tracker/app/hooks/use-tracker.ts` 增 `useListInbox`/`useResolveInboxItem`。
  - `application_state` 的 `navigation` 视图枚举补 `inbox`(03§0 已指出现状缺失导致
    agent 对该页面失明)。
  - `templates/tracker/app/components/layout/Sidebar.tsx` 增收件箱入口 + 未处理数角标。
- **依赖**:无新地基依赖(F3/F6 已交付,守卫与核对清单机制在位,本 WP 只是把它们汇聚到
  一个新页面);建议先于 WP-R3.4 做,复用同一条真实审批通路。
- **验收判据**(继承路线图 §2 场景③ + 《对齐审查》§四 R3):一个人不碰 agent 聊天窗,
  纯 UI 走完场景①的人工环节;重放 B5 评审场景(拦下缺迁移→驳回→fix→复审→批准)
  全程零命令行,审计能区分人与 agent 的每一步。
- **量级**:2–3 天(新页面+两个新 action+导航接线;评审卡"按 nature 装配的结构化核对清单
  控件"这一 03§11 已记录的欠账一并在此做)。

### WP-R3.3 issue 页四条证据链接通(场景①收口的可达性判据)

- **目标**:让工作项详情页能一键到达 run / diff / test / audit 四类证据。
- **本次核实到的现状细节**(比路线图原文更精确一层):
  - **(a) run 证据**:**部分已有**。`WorkItemDetailPage.tsx` 的 InspectorPanel"关联运行"
    行(:2612 附近)已挂载真实深链 `orchestratorRunHref(r.runId)`(定义于
    `app/components/tracker-format.ts:253`),点击可达 orchestrator run 详情页,且
    支持多条 run 历史(重派追加、旧 run 标灰划线,F8 交付内容)。**但** 03§4 第 3 点
    描述的完整"执行记录 ExecutionLog"区(active 置顶 + DagMiniMap + 当前节点 + 计时器
    + 每行 hover 出"重试节点/打开运行/查看转录")在页面中**零命中**,未建——本 WP
    的 (a) 部分范围是把现有的"简单深链行"升级为这个完整形态,不是从零建深链。
  - **(b) diff/测试证据**:确认在 tracker 侧缺失,只在 orchestrator
    `WorkspaceView`(DiffViewer)/`RunView` 存在——需要深链或摘要卡嵌入。
  - **(c) 真实审批记录**:见 WP-R3.2(收件箱)与 WP-R3.4(队列去桩),三者共享同一条
    真实审批通路,不重复建设。
  - **(d) 可渲染的 audit 面**:框架提供的 `list-audit-events`(见 `audit-log` skill)
    目前只在 action 层,缺一个渲染面;可作为工作项详情页"活动与评论"区(03§4 第 6 点)
    的一个新 tab,不必新建独立页面。
- **涉及文件**:
  - `templates/tracker/app/pages/WorkItemDetailPage.tsx`(执行记录区升级为 ExecutionLog
    形态;diff/测试证据深链或摘要卡;活动与评论区加 audit tab)。
- **依赖**:无(orchestrator `RunView`/`WorkspaceView` 已存在,只是没有从 tracker 深链
  过去;`list-audit-events` 是框架既有 action,只缺渲染)。
- **验收判据**(逐字继承路线图 §2 场景①):这四条链任一不可点=场景①未收口。
- **量级**:1.5–2 天(主要是深链拼装+跨应用身份对齐——tracker→orchestrator 已有确定性
  MCP 通路可复用,不需要新建鉴权)。

### WP-R3.4 队列审批真实化(替换 toast 桩)

- **目标**:`templates/tracker/app/pages/QueuePage.tsx` 的 `handleApprove`/`handleReject`
  接上真实审批动作。
- **本次核实到的现状细节**(比"队列审批仍是 toast 桩"这一笼统说法更精确):
  - `handleApprove`(:536-539)确认是字面 toast 桩,源码注释自述
    `// In a real app, would call an approve action. For now, just reorder.`;
    `handleReject`(:541-544)同样只 toast 后调用 `handleRemove`,无真实状态迁移。
    这两个函数服务的是"排队中人工门项"(`humanGateItems`,`status` ∈
    `paused`/`待审批`)这一路的快捷按钮。
  - **但** 页面里已经存在第二条真实通路:`handleApprovalApprove`/
    `handleApprovalReject`(:546-552)调用的是真实的 `approveGate`/后续驳回流程
    (底层 `actions/approve-gate.ts`/`actions/reject-gate.ts`,服务的是 `list-approvals`
    的签核数据)。**本 WP 的范围是把桩的那一路也接到真实通路上,不是从零建审批机制。**
- **涉及文件**:`templates/tracker/app/pages/QueuePage.tsx`(:536-544 改为调用真实
  action——建议复用 WP-R3.2 新建的 `resolve-inbox-item` 以统一入口,避免两套审批
  调用路径并存;若排期上 WP-R3.2 未就绪,也可先直接接 `approve-gate`/`reject-gate`,
  后续再收口)。
- **依赖**:建议在 WP-R3.2 之后做以复用统一入口;可独立排期,风险是短期内两套调用路径
  并存。
- **验收判据**(继承《对齐审查》§四 R3):队列页审批不再是 toast 桩,点击后有真实的
  状态变更与审计记录。
- **量级**:0.5–1 天(小改动,给定通路已存在)。

### WP-R3.5 模型注册表页(`/brain/engines`)

- **目标**:04 章 §7 设计的引擎注册表页,把 `server/model-registry.ts` 已有的真名+别名
  映射能力从"有后端无 UI"补齐。本次核实确认 orchestrator 的
  `app/routes/`(flat-route)下没有 `brain.engines.tsx`,`server/model-registry.ts`/
  `server/model-registry.spec.ts` 存在但无对应 action 与页面。
- **涉及文件**:
  - `templates/orchestrator/app/routes/brain.engines.tsx`(新,flat-route 命名法,
    类比现有 `templates/orchestrator/app/routes/brain.tsx`)。
  - action 增量(04§13 已列出,需新建或核对是否已部分存在):
    `brainEngineList`/`brainEngineSet`/`brainEngineProbe`。
  - 模型注册表区块的假名拒绝校验(非 Claude 权重禁止登记 `claude-*` 名,SDLC-054)。
- **依赖**:无新地基依赖(F7 遥测单一事实源已交付,本 WP 是纯 UI+action 薄层)。
- **验收判据**(继承 F7 可证伪验收②③,04§7 全文):按 `model_ref` 统计的报表能区分
  真 Claude 与本地权重;人为删 ACP 包重启→健康页红灯(与 WP-R3.6 共享同一降级事件源)。
- **量级**:1.5–2 天(含 action 新建)。

### WP-R3.6 健康页(`/health`)

- **目标**:04 章 §10 设计的健康前置门单一真相页。本次核实确认 orchestrator
  `app/routes/` 下没有 `health.tsx`;`actions/health-telemetry.ts` 存在(有后端无 UI,
  与 model-registry 同一处境)。
- **涉及文件**:
  - `templates/orchestrator/app/routes/health.tsx`(新)。
  - `templates/orchestrator/actions/health-telemetry.ts`(核对是否已覆盖 04§13
    `healthStatus`(聚合门状态)所需数据,不够则扩展)。
  - 四健康卡(vLLM/Claude Code/Brain 槽/调度器)+ 遥测可信卡(suspect 计数、别名漂移、
    R9 传导修正次数)+ 门事件时间线 + 容量区(合并现有
    `templates/orchestrator/app/routes/pool._index.tsx` 内容并入)。
- **依赖**:F7(遥测单一事实源,已交付)、F10(引擎终态传导完备,已交付)。
- **验收判据**(继承 F7④、04§10 全文):声明开启的能力初始化失败必须在本页显式红灯
  (不允许静默降级);"声明了但未生效"的配置(如 `maxOutputTokens` 被框架钳制)必须
  产生告警事件并计入本卡。
- **量级**:2 天(含容量区从 pool 页迁移合并)。

### WP-R3.7 两应用挂载框架 Agent 页(`/agent`)

- **目标**:tracker、orchestrator 各新增 `app/routes/agent.tsx`,渲染
  `AgentTabsPage`(Context/Files/Connections/Jobs/Access 五 tab)。
- **本次核实**:`templates/analytics`/`assets`/`brain`/`calendar`/`clips`/`content`/
  `design`/`dispatch`/`forms`/`macros`/`mail`/`plan`/`slides` 等十余个模板均已有
  `app/routes/agent.tsx`(或 `_app.agent.tsx`)挂载 `AgentTabsPage`;唯独 tracker 与
  orchestrator 的 `app/routes/` 下**没有**这个文件——确认是真实待办,不是已完成误判。
- **涉及文件**:
  - `templates/tracker/app/routes/agent.tsx`(新,参照
    `templates/brain/app/routes/agent.tsx` 写法:`import { AgentTabsPage } from
    "@agent-native/core/client"`,约 10 行)。
  - `templates/orchestrator/app/routes/agent.tsx`(新,同上;若需要外壳包裹参照
    `templates/dispatch/app/routes/agent.tsx` 的 `DispatchShell` 模式)。
  - `templates/tracker/app/components/layout/Sidebar.tsx`、
    `templates/orchestrator/app/components/layout/Sidebar.tsx` 各加一条导航入口。
- **依赖**:无。**范围明确排除**(03§0/04§12 已定案,本 WP 只挂载不改现有页面语义):
  - tracker Connections tab **不**替代 tracker↔orchestrator 现有确定性 MCP 通路
    (走共享 `A2A_SECRET` 签的 JWT,非 A2A NL loop)。
  - Jobs tab **不**解决 T-D(见 §6)——机制建成前无东西可展示。
  - orchestrator Context tab **不**替代 04§6 Brain 控制台已有的按线程 token/上下文
    表盘,也**不**替代 §10 健康页的遥测可信卡——它只读默认聊天 agent 的 manifest,
    brain 线程/DAG spawn 走自有的 `runAgentLoop` 调用路径,不经过这条 manifest。
- **验收判据**:两应用 `/agent` 路由可访问且五 tab 渲染正常。
- **量级**:每应用半天(CLAUDE.md 已定性"半天量级、不需新建 action")。

### WP-R3.8 Foundry v3 动效在两应用生产界面落地

- **目标**:把已定稿的 Foundry v3 动效 token(本次核实存在于
  `docs/sdlc-product-design/design-system/foundry-motion.html`)落到 tracker/orchestrator
  两个真实 React+Tailwind+shadcn 生产应用,不只是 design 服务里的原型。
- **本次核实**:两应用的 `app/global.css` 均为 Tailwind v4 CSS-first 形态
  (`@import "tailwindcss"`,再 `@import "@agent-native/core/styles/agent-native.css"`),
  当前均**没有**动效 token 层——确认待做,不是部分已有。
- **涉及文件**:
  - `templates/tracker/app/global.css`、`templates/orchestrator/app/global.css`——
    加 `@theme` 时长梯度(120/240/400/700ms + 1.6/2.5/3.2s 氛围循环档)与曲线
    (standard/enter/exit 三件套 + 回弹曲线)token,以及 `data-state` 全局覆盖统一
    shadcn 组件节奏。
  - 招牌模式(thinking 文字扫光、导航进度扫条、活跃态克制脉动、两段式完成动效、数字
    计数动画)落到对应共享组件——具体文件需在 WP 启动时对照 `01-design-system.md`
    §4 组件清单逐一定位(如 `AgentComposerFrame`、`StatusRing`、进度条类组件)。
- **依赖**:无新地基依赖;建议与 WP-R3.5/R3.6 新页面同批做,新页面正好是应用这套
  token 的落点。
- **验收判据**(继承《对齐审查》§五全文):两应用生产界面可观察到统一的动效语言;
  红线走查通过——无 stagger 表演、无视差、无自定义光标;overflow 容器内禁位移动效;
  拖拽/手势进行中禁用一切 transition;全量 `prefers-reduced-motion` 降级生效。
- **量级**:2–3 天(两应用 token 接入 + 招牌模式逐组件应用 + 红线走查)。

---

## §4 R4 · 工作流族与规划技能链

> 目标重述(继承《对齐审查》§四 R4):把 sdlc-issue-pipeline 扩成第一个真实多节点 DAG
> 模板入库带版本;随后 hotfix/docs-task/quick-task 族;规划域六技能 + gap-analysis
> 支撑场景②。验收:场景②③按路线图 §2 判据走通。

### WP-R4.1 `sdlc-issue-pipeline` 硬化为首个真实多节点 DAG 模板(入库带版本)

- **目标**:把 02§3.1 定义的
  `dev→qa→reviewer→gatekeeper→diff-audit→commit+PR→ci-watch→merge-pr` 九步流水线,
  从"仓内零证据、仅单节点 sdlc-dev 活在 101 DB"变成入库、带版本、种子化的真实模板。
- **本次核实**:`templates/orchestrator/server/db/v3-schema.ts` 里 `v3_workflow_templates`
  表结构已存在(`server/plugins/db.ts:763` 起的 `CREATE TABLE IF NOT EXISTS
  "v3_workflow_templates"`),但没有任何九模板的种子 upsert 代码——确认"表在、种子不在"。
- **涉及文件**:
  - `templates/orchestrator/server/plugins/db.ts`(首启段补种子 upsert 逻辑,参照现有
    `sdlc-run-limits` 迁移的 name-based 幂等写法)。
  - dag-validator 相关文件(需在 WP 启动时定位实际路径)新增 `action` 确定性节点类型
    (04§13:"+ `action` 节点类型(引用 action 名 + inputs 映射,reconciler 直接执行
    无 spawn)")。
  - `ciWatch`/`mergePr` 已是 WP-R1.2 部署的能力原语,本 WP 是把它们编织进模板 JSON,
    不是重新实现。
- **依赖**:R1(ciWatch/mergePr 已部署)、R2(脊柱场景走通,证明单节点链路本身可信,
  再谈多节点编排)。
- **验收判据**(继承路线图 §3 + 02§3.1 全文):模板可按版本查看;跑一个真实工作项经
  此模板全链路到 merge。
- **量级**:3–4 天(DAG JSON 编写 + action 节点类型支持 + 首次真实跑通调试)。

### WP-R4.2 `hotfix` / `docs-task` / `quick-task` 族模板

- **目标**:02§3.6/§3.7/§3.8 三个轻量模板入库。
- **涉及文件**:同 WP-R4.1,`v3_workflow_templates` 种子扩展;`hotfix` 复用 F4 已交付的
  评审独立性机制(02§3"评审独立性"约束),不重新实现。
- **依赖**:WP-R4.1(复用同一套 action 节点/种子机制)。
- **验收判据**(继承 03§3.10 工作流选择器规则):缺陷/生产问题→`hotfix`、文档→
  `docs-task`、无 sprint+auto→`quick-task` 三条路由命中对应模板并可实际跑通一次。
- **量级**:2–3 天。

### WP-R4.3 规划域六技能 + `sdlc-gap-analysis`(场景②支撑)

- **目标**:建 tracker `.agents/skills/` 下 `brainstorm`/`sprint-plan`/
  `sprint-test-plan`/`ui-spec`/`sprint-design`/`sprint-review` 六技能,外加
  `draft-fix-issue`/`sprint-story`/`sprint-recap`,按 02§2 技能链表逐一撰写(产物
  docKey、交互形态、质量门);清理残留 `form-*` 技能;新增 `sdlc-gap-analysis`
  workflow + `extract-goal-metrics` 确定性提取的编排层。
- **本次核实**:`templates/tracker/.agents/skills/` 目录下现有 `actions/`、
  `capture-learnings/`、`create-skill/`、`delegate-to-agent/`、`form-building/`、
  `form-publishing/`、`form-responses/`、`frontend-design/`、`real-time-sync/`、
  `security/`、`self-modifying-code/`、`shadcn-ui/`、`storing-data/`——上述九个规划
  技能**全部不存在**,`form-*` 三个属 03§12 明确要求清理的残留技能。
  `templates/tracker/actions/extract-goal-metrics.ts` **已存在**(需在 WP 启动时核对
  是否已支持 M 编号+NO_GAPS 门,若已支持则本 WP 只需补 orchestrator 侧
  `sdlc-gap-analysis` workflow 与 `output_schema`);orchestrator 侧未找到
  gap-analysis 相关 action。
- **涉及文件**:
  - 新建 `templates/tracker/.agents/skills/{brainstorm,sprint-plan,sprint-test-plan,
    ui-spec,sprint-design,sprint-review,draft-fix-issue,sprint-story,
    sprint-recap}/SKILL.md`(九个)。
  - 删除 `templates/tracker/.agents/skills/form-building/`、`form-publishing/`、
    `form-responses/`。
  - `templates/tracker/AGENTS.md`(按 03§12 重写导航与类型枚举)。
  - orchestrator 侧新增 `sdlc-gap-analysis` 模板(同 WP-R4.1 种子机制)+ 新 action
    (具体命名需在 WP 启动时核对 02§3.3 与 03 章 action 清单,若 `extract-goal-metrics`
    不够则新增)。
- **依赖**:WP-R4.1(种子机制复用)。
- **验收判据**(继承路线图 §2 场景②,含其"部署前置"两步):把自举 sprint
  「S-v2.1 地基第一批」作为第一个真实对象走完闭环(M1-M5 逐条实测,读数取已部署 live);
  closed≠done 的语义在页面可见。**注意路线图原文明确的前置步骤**:该 sprint 现处
  planning、无 sprint-doc 产物、无 goal 指标落库,B1-B5 交付的 action merged 但未必
  已部署——本 WP 第一步是先确认 B1-B5(`extract-goal-metrics` 等)已随部署脚本落到
  101 live,再补写该 sprint 的 sprint-doc 与 M 编号指标,之后闭环才有可回填的真实读数。
- **量级**:4–6 天(六技能撰写为主要成本,每个技能的访谈树/质量门都要贴合真实数据结构;
  gap-analysis workflow 次之)。

---

## §5 R5 · 四域打通(design/content 集成)

> 目标重述(继承《对齐审查》§四 R5):ui-spec 子流程(设计稿→评审→实现比对)、content
> 项目文档库自动归档。验收:一个带 UI 的 issue 走完 05 章旅程,产物自动落库。

### WP-R5.1 ui-spec 子流程(`sdlc-ui-build`)

- **目标**:02§3.5 `sdlc-ui-build` 全流水线(`spec-parse`→`screen-gen`→`ds-lint`→
  `consistency-review`→`publish`),把 tracker 规划工作台的 UI 设计 track 接到 design
  应用。
- **涉及文件**:
  - orchestrator 侧新增工作流模板(同 R4 机制)+ 确定性节点 `spec-parse`/`ds-lint`/
    `publish`(复用 WP-R4.1 的 dag-validator `action` 节点类型扩展)。
  - `templates/tracker/actions/request-ui-build.ts`(新,03§11 action 增量已列出)。
  - `templates/tracker/actions/publish-artifact-to-content.ts`(新,发布管道,05§5.1)。
  - `templates/tracker/.agents/skills/ui-spec/SKILL.md`(与 WP-R4.3 共享同一技能;若
    排期上 R5 先做,技能编写移到本 WP)。
- **依赖**:WP-R4.3(ui-spec 技能)、design 应用既有 `create-design`/`create-file`
  能力(只调用其既有 action,不改 design 应用代码)。
- **验收判据**(继承 02§3.5 全文):屏清单→逐屏 HTML 生成→ds-lint 检查(tokens
  存在性/禁 emoji/data-screen 链接完整性)→跨屏一致性评审→发布入库 design 应用且
  回写 tracker `ui-prototype` 产物;失败路由(ds-lint 违规回 `screen-gen` 定点重生成,
  loop ≤2)可复现。
- **量级**:4–5 天。

### WP-R5.2 content 项目文档库自动归档

- **目标**:05§5 规范的 sprint 产物自动落
  `SDLC 项目文档库/<项目>/Sprint N/` 并回链 tracker。
- **涉及文件**:`templates/tracker/actions/publish-artifact-to-content.ts`(与
  WP-R5.1 共用同一发布管道 action;若 R5.1 先做,本 WP 只是把覆盖的 docKey 范围从
  ui-spec/ui-prototype 扩展到全部 sprint 产物)。
- **依赖**:WP-R5.1(发布管道基础设施)、F8(回链完整性,已交付)。
- **验收判据**(继承路线图 §2 场景①收尾 + 05§5):一个带 UI 的 issue 走完 05 章旅程,
  产物自动落库,tracker `contentRef` 指向 content 页且可点。
- **量级**:2–3 天。

---

## §6 工程卫生并行轨

> 这些项不在 R1–R5 主线上,但价值明确、多数无阻塞依赖,适合填缝式并行推进。

<table header-row="true">
<tr>
<td>项</td>
<td>目标</td>
<td>涉及文件</td>
<td>依赖/顺序</td>
<td>量级</td>
</tr>
<tr>
<td>doctor 接入(两应用)</td>
<td>`agent-native.json` 加 doctor 字段,拿到 core 0.97.0+ 起随包提供的"未域控凭据/未域控查询/env 凭据读取/兜底身份"等 7 类自动扫描,覆盖此前人工审计修过的漏洞类别(O9/T-A/T-F 等)</td>
<td>`templates/tracker/agent-native.json`、`templates/orchestrator/agent-native.json`(本次核实均无 `doctor` 字段;`npm view @agent-native/core version` 显示最新 0.102.2,晚于 0.97.0,字段理论可用,启用前按 `agent-native-docs` skill 核对确切字段名)</td>
<td>无依赖</td>
<td>每应用 0.5 天</td>
</tr>
<tr>
<td>F2b(执行器上下文消费端切片)</td>
<td>把 F2(已交付)C1-C4 契约在 engine-loop 侧真正接进 worker 调用路径的消费端切片补完</td>
<td>orchestrator engine-loop 相关文件(需在启动时核对准确路径)</td>
<td>F2 已交付;建议 R1 之后、R4 之前</td>
<td>1–2 天</td>
</tr>
<tr>
<td>回写持久 outbox</td>
<td>F9 确定性回写通道"reconciler 主 + get-activity 轮询兜底"两层之外加一层持久化 outbox,防 reconciler 侧写失败丢事件</td>
<td>orchestrator `tracker-client`(回写模块,04§13 提到的新模块)</td>
<td>F9 已交付;排在 R2 之后(路线图原文:"F2b、回写持久 outbox 排入 R2 之后")</td>
<td>2 天</td>
</tr>
<tr>
<td>verifyA2AToken/actionRouteAuth 收敛(O13 官方替代)</td>
<td>用官方 `verifyA2AToken`/`actionRouteAuth`(core 0.101.0)替换 tracker/orchestrator 手搓的共享 mcp-client JWT(`orchestrator-client.ts`/`content-client.ts` 各自 `node:crypto` 自铸 HS256 JWT)</td>
<td>tracker 侧 orchestrator-client/content-client 对应文件(需核对准确文件名)、orchestrator 侧对应 JWT 校验点</td>
<td>无强依赖;涉及双向改动,需过渡期不断线</td>
<td>2–3 天</td>
</tr>
<tr>
<td>O12(action 面收敛)</td>
<td>~168 个 action 文件里约 40 个自动生成的纯 shim 合并为 op 参数化 CRUD,`agentTool:false` 隐藏 UI-only action</td>
<td>orchestrator `actions/` 目录下待合并的 thin shim(具体清单需 WP 启动时跑一次 action 目录审计)</td>
<td>无依赖;风险在于遗漏调用方引用</td>
<td>3–4 天</td>
</tr>
<tr>
<td>O13(硬编码端点/凭据残余)</td>
<td>清理 `sdk-brain-session.ts:23` 的硬编码 vLLM endpoint(`192.168.1.250:9000`)+ `sk-vllm-local`、`localhost:3002` MCP 硬编码,改走 env</td>
<td>`templates/orchestrator/server/brain/sdk-brain-session.ts`</td>
<td>无依赖</td>
<td>0.5–1 天</td>
</tr>
<tr>
<td>T-D(automations 替代 4s 轮询)</td>
<td>无框架 automations/recurring-jobs/服务端定时,状态迁移靠 UI 4s 轮询 `get-activity`,且该 action 每次读时内联写回状态——改走 event-bus `emit` + automations 或确定性写回通道</td>
<td>`templates/tracker/actions/get-activity.ts`</td>
<td>依赖 F9/outbox 先把"回写是唯一权威源"做扎实,否则轮询退不掉;**明确排除**:03§0/04§12 已裁定挂载 `/agent` 页(WP-R3.7)的 Jobs tab 不解决 T-D,机制要先在后端建成</td>
<td>2–3 天</td>
</tr>
<tr>
<td>reconciler spec 卡死修复</td>
<td>见 §1 WP-R1.1,不重复排期,此处只做交叉引用</td>
<td>`templates/orchestrator/server/engine/v3-reconciler.spec.ts`</td>
<td>见 WP-R1.1</td>
<td>见 WP-R1.1</td>
</tr>
</table>

---

## §7 顺序与并行性

### 7.1 依赖与并行关系

<table header-row="true">
<tr>
<td>阶段/工作包</td>
<td>可与之并行的项</td>
<td>硬依赖(必须先完成)</td>
</tr>
<tr>
<td>WP-R1.1(修 spec 卡死)</td>
<td>WP-R3.7(agent-page 挂载)、H·O13(硬编码清理)——均无依赖、量级小,适合同周填缝</td>
<td>无</td>
</tr>
<tr>
<td>WP-R1.2(部署 1fd9783fb)</td>
<td>同上</td>
<td>建议 WP-R1.1 先行(非硬性,可对调)</td>
</tr>
<tr>
<td>WP-R1.3(孤儿清理+首次验证)</td>
<td>可与 WP-R1.2 并行(若小票场景不需要 merge-pr 全流程)</td>
<td>无(若需要走 merge-pr 全流程,则依赖 WP-R1.2)</td>
</tr>
<tr>
<td>WP-R2.1(脊柱场景剧本)</td>
<td>R3 的多数 WP 可与 R2 并行准备(它们不依赖 R2 的走查结果),但 R2 的"最终收口"依赖 WP-R3.3 完成</td>
<td>R1 全部三个 WP</td>
</tr>
<tr>
<td>R3 八个 WP(R3.1 已完成)</td>
<td>彼此之间除标注的先后建议外基本独立,可多条并行;与 R2 并行准备</td>
<td>R3.4 建议在 R3.2 之后;R3.3 的最终验收需要 R2 走查暴露的实际证据需求</td>
</tr>
<tr>
<td>R4 三个 WP</td>
<td>WP-R4.2/R4.3 可与 R3 剩余项并行</td>
<td>R1 + R2(WP-R4.1 依赖 R2 走通证明单节点链路可信);WP-R4.2/R4.3 依赖 WP-R4.1 的种子机制</td>
</tr>
<tr>
<td>R5 两个 WP</td>
<td>WP-R5.2 可与 R4 尾声并行准备</td>
<td>WP-R4.3(ui-spec 技能)、F8(已交付)</td>
</tr>
<tr>
<td>§6 工程卫生七项</td>
<td>doctor/O13/O12 全程可并行;F2b 建议 R1 后 R4 前;outbox/T-D 排 R2 之后;verifyA2AToken 收敛全程可并行但需双向改动窗口</td>
<td>各项互不依赖,除 T-D 依赖 outbox</td>
</tr>
</table>

### 7.2 各阶段完成定义(Definition of Done)

- **R1 完成**:WP-R1.1/R1.2/R1.3 三条验收判据全部满足——spec 不再卡死、
  `1fd9783fb` 已部署、v3_runs 出现新 run 且 F4/F7/F9 三计数转正。
- **R2 完成**:脊柱场景剧本走完且业务全程零 SSH/psql,守卫记录齐全;若证据可达性
  四链尚未全部就绪,可先以"业务链路走通"部分收口并明确标注待 R3 补完全收口
  (见 §2 的排序张力说明)。
- **R3 完成**:八个 WP(WP-R3.1 已交付不计入待办)全部验收判据满足,一个人不碰
  agent 聊天窗纯 UI 走完场景①的人工环节。
- **R4 完成**:场景②③按路线图 §2 判据走通(场景②以「S-v2.1 地基第一批」为实测对象,
  M1-M5 逐条读数;场景③重放 B5 评审全流程零命令行)。
- **R5 完成**:一个带 UI 的 issue 走完 05 章旅程,产物自动落库且 `contentRef` 可点。

### 7.3 建议第一周

优先做量级小、无依赖、能立即拉开并行面的几项:

1. **WP-R1.1**(定位 `v3-reconciler.spec.ts` 卡死根因)——地基性最强,越早修越能给
   后面所有 reconciler 相关改动提供回归网。
2. **WP-R3.7**(两应用挂载 `/agent`)——半天量级、零依赖、有十余个模板可直接抄写法。
3. **H·O13**(清理 `sdk-brain-session.ts` 硬编码)——半天量级、零依赖。
4. 以上三项完成或过半后接 **WP-R1.2**(部署)与 **WP-R1.3**(首次真实运行验证),
   争取第一周末拿到 R1 的三条验收判据全绿。
5. 第一周内可同时起草 **WP-R3.2**(收件箱)与 **WP-R3.5/R3.6**(模型注册表页/健康页)
   的详细设计(不必等 R1 完成才动笔,它们与 R1/R2 无代码级依赖)。

---

*本文取代《SDLC 实施路线图(落地版)》§2–§4 的旧排期;地基判据见该文档 §1/§1.12;
现状与骨架见《SDLC 现状对齐审查(2026-07-16)》;架构约束见
`docs/agent-native-alignment-audit.md`(其 §5 裁决的合理偏离不再作为问题重提)。*
