# Agent-Native 对齐审计 — Orchestrator + Tracker vs 官方框架

> 目的:以 `www.agent-native.com/docs`(版本匹配副本在 `packages/core/docs/content/*.mdx`)
> 与官方参考模板(`templates/brain`、`templates/dispatch`)为**基线标尺**,审计自研
> `templates/orchestrator`(执行域)与 `templates/tracker`(流程域),列出**未按官方思路**的所有
> gap,并给出**目标架构 + 分阶段优化设计**。
>
> 方法:四路独立调研(官方编排原语 / 官方核心租户 / orchestrator 实现盘点 / tracker 实现盘点),
> 所有 gap 均带 `file:line` 证据。日期 2026-07-05。基于 `main` @ `84c4ac88d` 之后。

---

## 零、一句话结论

**自研栈在"确定性 SDLC 编排"这个框架故意不提供的点上是合理的 —— 但它把框架已经提供的 4~5 个
编排原语全部重造了一遍,并在重造过程中引入了越权漏洞、可移植性破坏、静默失败和大量样板。**

- ✅ **该自研的**:声明式 DAG(多轮审查 / Phase H 审计 / Phase G 晋升的确定性流水线)。
  官方明确"agent loop 即编排器",**不提供** DAG 引擎 —— 而 SDLC 恰恰需要确定性(brain 不能"忘了跑审查"),
  这正是过去反复出问题的地方([[brain-must-use-vllm-dag]])。**保留。**
- ❌ **不该自研的**:brain 用裸 `spawn("claude")` 而非 Harness Agents;自造 reconcile sweep/reaper
  而非 run-manager 自愈;轮询而非流式订阅;自造 audit 表而非 audit-log;自铸 JWT + 裸 MCP client
  而非 A2A `invoke`;跨应用裸 SQL 直读对方表;V3 整层绕过框架 DB(不可移植)。
- 🔴 **重造中引入的问题**:orchestrator V3 与 tracker 审批门**都存在 owner-scope 越权**(安全);
  V3 reconciler **裸 SQL 字符串拼接**;guard 求值出错**当作通过**、schema 违规**静默改写为 `{text}`**
  —— 后者直接背叛了 SDLC 自己的"证据/fail-loud/反奉承"灵魂。

**优化方向 = 保留 DAG 的确定性语义,把它的执行底座整体换成框架原语。**

---

## 一、官方思路(基线标尺)

### 1.1 十一条不可谈判的租户(核心架构)

| # | 租户 | 强制它的原语 |
|---|------|------------|
| T1 | **Agent/UI 对等**:每个 agent 工具也是 UI 按钮,走同一逻辑 | 一个 `defineAction()` 扇出到 tool + hook + HTTP + CLI + MCP + A2A |
| T2 | **Action 是唯一事实源**:UI 和 agent 都要的操作 = action,绝不裸 REST | `defineAction`;UI 走 `useActionQuery`/`useActionMutation`/`callAction` |
| T3 | **数据全在 SQL / Drizzle**,provider 无关 | `@agent-native/core/db/schema` + `createGetDb`;禁直接 import `drizzle-orm/*-core` |
| T4 | **应用状态入 SQL**,让 agent 知道当前导航/选择/焦点 | `application_state` 表 + `navigation`/`selection`/`__url__`/`navigate` 键 |
| T5 | **实时同步**:agent 写入即时反映到 UI | `useDbSync()` + SSE `/_agent-native/events` + 轮询 `/_agent-native/poll` |
| T6 | **所有 AI 走 agent chat**,UI 绝不直接调 LLM | `sendToAgentChat()` |
| T7 | **人审门**用于高后果动作 | `defineAction({ needsApproval })` —— 暂停 loop,人批后才 `run()` |
| T8 | **访问域**作用于用户数据 | `ownableColumns()` + `accessFilter`/`assertAccess`/`resolveAccess` |
| T9 | **审计日志**:append-only,谁改了什么、agent 还是人 | `defineAction` 接缝自动写 `agent_audit_log`;`list-audit-events` 读回 |
| T10 | **四面完整**:每个特性触及 UI + Action + 技能/指令 + 应用状态 | `adding-a-feature` |
| T11 | **schema 只增不减 / 代码可移植** | `runMigrations()`,`ADD COLUMN IF NOT EXISTS`,禁 `drizzle-kit push` 生产 |

> 自研栈最常违反的是 **T2**(裸 client / 跨应用裸 SQL)、**T8/T9**(自造 audit + 越权)、
> **T11**(V3 绕过框架 DB 层,Postgres 专用 DDL)。

### 1.2 编排的官方答案:**"agent loop 即编排器"**

框架**不提供** DAG / workflow 引擎,也没有"coding brain"模板。它对"一个协调 agent 把活分给
worker 并追踪到完成"的标准答案是**一组可组合原语**,全部投影到**同一个后台运行 + transcript 面
(run-manager)**:

| 层 | worker 是… | 原语 | 入口 API | 位置 |
|---|---|---|---|---|
| 进程内委派 | 子 agent | **Agent Teams** | `spawnTask()` / `agent-teams` 工具 / `getTask`/`listTasks` | `packages/core/src/server/agent-teams.ts` |
| 完整 coding runtime 作 worker | Claude Code / Codex / Pi / ACP | **Harness Agents** | `resolveAgentHarness(name)` + `startAgentHarnessRun({ createSession:{ resumeState … } })` | `packages/core/src/agent/harness/*` |
| 跨应用委派 | 另一个整应用的 agent | **A2A / Dispatch** | `agentNative.invoke(app, msg, { userEmail })` / `callAgent` | `@agent-native/core/agent-native`、`packages/core/src/a2a/*` |
| 底座 | 一切后台运行 | **run-manager** | `startRun`/`ActiveRun`/heartbeat/soft-timeout/`reapAllStaleRuns` | `packages/core/src/agent/run-manager.ts`、`run-store.ts` |

配套原语:

- **durable-background-runs**:把长回合搬到 15 分钟后台函数(`AGENT_CHAT_DURABLE_BACKGROUND=true` + `A2A_SECRET`),纯 env,无应用代码。
- **durable-resume**:内建"已完成的副作用工具调用不重放"(基于 tool-call 日志的内容寻址硬阻断),保证 exactly-once。
- **in-loop processors**:`Processor` 三钩子(`processOutputStream/Step/Result`)+ `abort()`→`TripWire`,在"声称完成"前**中止**。是 proof-of-done / 覆盖率闸的官方接缝(**配置,不是工具**)。
- **human-approval**:`needsApproval` 暂停 loop 发 `approval_required`。
- **progress**:`progress_runs` + `manage-progress` 工具 + `<RunsTray/>` 百分比条。
- **sandbox/CLI adapters**:换 `run-code` 后端(本地→Docker/远程)/给 CLI 工具结构化访问。

**关键 Don't(官方原文)**:
> "Don't add Claude Code, Codex, Cursor, Mastra, or Pi as an `AgentEngine`. They own their loop;
> running one under `AgentEngine.stream()` double-runs the loop and loses session lifecycle semantics."(`harness-agents.mdx`)
> "Do not add a parallel background-agent runner… Build a host adapter or UI slot on top of the shared
> run-manager foundation."(`code-agents-ui.mdx`)
> 项目 CLAUDE.md:"Background agents must use the core run-manager / agent-teams infrastructure。"

### 1.3 跨应用 / 数据 / 后台的官方原语

- **跨应用调用是一等公民**:orchestrator/tracker 之间应走 `agentNative.invoke("orchestrator", …, { userEmail })`
  或 `call-agent`(A2A JSON-RPC `POST /_agent-native/a2a`,`A2A_SECRET` JWT 携带 `sub`/org)。
  **禁止**:import 对方内部、复制对方表、嵌套对方 app、或**裸读对方 DB 表**(`multi-app-workspace.mdx` 明令)。
- **应用状态**:`application_state`(key→JSON)+ 标准 `view-screen`(agent 的眼睛,把 id 补水成新鲜 SQL 行)/ `navigate`。
- **后台流水线**:**事件驱动** = `@agent-native/core/event-bus`(`registerEvent`/`emit`)+ **automations**(`jobs/*.md`,`triggerType: event`);**定时** = **recurring-jobs**(cron `jobs/*.md`)。**不要**自造 scheduler / 事件总线 / 状态轮询。
- **审计**:`defineAction` 接缝**自动**写 `agent_audit_log`(actor=agent/human、run 关联、surface、outcome、target);`list-audit-events` 读回。**零代码**。

---

## 二、GAP 分析

严重度:🔴 P0(安全/正确性,须先修) · 🟠 P1(架构重造,中期收敛) · 🟡 P2(卫生/parity,可增量)

### 2.1 Orchestrator(执行域)

| # | 关注点 | 现状(证据) | 官方做法 | 影响 | 级别 |
|---|--------|-----------|---------|------|------|
| O1 | **后台运行时** | brain = 裸 `spawn("claude", argv)` 子进程(`server/brain/brain-session.ts:439`),配自造 `brain-monitor.ts` 15s/120s 巡检唤醒 | **Harness Agents** `startAgentHarnessRun` + 可恢复 SQL session(`resumeState`) | 丢掉 heartbeat/soft-timeout/取消/transcript 投影;催生 cwd-recovery hack(`:168-196`)与 `--resume` 脆弱性 | 🟠 |
| O2 | **worker 调用(CC)** | claude worker 走 `runClaudeCodeWorker` 裸 `claude -p`(`server/runtime/claude-code-worker.ts:82`);`v3-acp-adapter.ts` 包了官方 `resolveAgentHarness` 但**全死无调用方** | Harness Agents / ACP adapter | 违反"不要把 CC 当 engine"的 Don't;双跑 loop 风险;已写好的官方适配器被弃用 | 🟠 |
| O3 | **worker 调用(vLLM)** | 走 `createAISDKEngine("openai",{baseUrl})` **改名成 `"vllm"`** 以绕过框架 `requiredEnvVars:[OPENAI_API_KEY]` 预检(`server/vllm-engine.ts:29-41`) | engine 层本身合规;应通过官方途径声明本地 OpenAI 兼容引擎 | 名字欺骗是 workaround,升级框架易碎 | 🟡 |
| O4 | **可恢复/自愈** | 自造 `v3_runs/v3_nodes/v3_spawns` + 启动 reconcile + **多个周期 sweep/reaper**:`v3-run-reconcile-sweep.ts`(90s)、`engine/reap.ts`(60s)、`brain-driver`(5s)、`token-refresh`(30min) | run-manager 已含 `reapIfStale`/`reapAllStaleRuns`/`reconcileAgentTeamRunsForOwner`(**在 `/_agent-native/runs` 读路径上自愈**) | 与框架自愈冗余;48 个 env 阈值、6 组必须相互有序的 grace(25s/30s/2m/10m/15m/30m);**单 isolate 无 leader 选举**,多实例会重复调度 | 🟠 |
| O5 | **run/node 完成传播** | brain **轮询** `runState`/`v3RunEvents`;`run-events.ts:11-19` 明确注释不用框架 `subscribeToRun`,因 V3 不是 run-manager run | run-manager 流式 + 订阅 + 自愈 | 轮询烧 token/延迟;完成靠 sweep 兜底 | 🟠 |
| O6 | **human 门** | 自造 `human_gate` 节点(`v3-reconciler.ts:871`)+ `nodeResolveGate` | 框架 `needsApproval` / human-approval | 重造审批原语;V2 `control.ts:396-401` 甚至自述在引擎内重实现了一遍 | 🟡 |
| O7 | **worker 定义存储** | 自造 SQL 表 `orchestrator_agent_defs`(`server/db/schema.ts:344`)+ 启动 seed + SQL-first loader(`.claude/agents/*.md` 仅兜底) | 官方 Custom Agent = 工作区 `agents/<slug>.md` 文件 | ⚠️ **产品硬需求冲突**:用户要求节点/技能/agent 可**页面配置**。见 §3.2 原则四 —— 此项**保留 SQL 但需适配**,非纯粹 gap | 🟡(受控偏离) |
| O8 | **数据层 / 可移植** | **双 DB**:V2 走框架 LibSQL;**V3 另开裸 Postgres 池**(`server/db/v3.ts`),手写幂等 DDL(`ensureV3Schema` 把 `CREATE TABLE`→`IF NOT EXISTS`),整层绕过框架 DB。V3 表用**本地重定义**的 `ownableColumns()`,无 shareable 注册 | 框架 `runMigrations` + schema helpers + 官方 ownable/shares | 违反 T3/T11:Postgres 专用(`now()/::int/FOR UPDATE SKIP LOCKED/pg_advisory_lock`),不可移植;审计/分享/迁移全绕过 | 🟠 |
| O9 | **访问域(越权)** | V3 读 action 把 owner 过滤放在 `if (ownerEmail) …` 后 —— **caller email 为空时不加任何过滤,返回全部 owner 的 runs/threads**(`actions/v3-runs.ts:36`、`actions/brain-threads.ts:53`) | `accessFilter` fail-closed | **自托管本地请求(常态)= 无域读全库** | 🔴 |
| O10 | **裸 SQL 字符串拼接** | `v3-reconciler.ts` 用 `.replace(/'/g,"''")` 内嵌 id(CAS `:597`、retry `:919`、`hashtext('${runId}')` `:104`);sweep 用 `v3DbExec` 模板串 | 参数化查询 | 注入面 + 移植锁定 | 🔴 |
| O11 | **静默失败(背叛 SDLC 灵魂)** | guard 求值出错 **当作通过**(`v3-reconciler.ts:497`);output_schema 违规 **静默改写为 `{text:…}`**(`v3-dispatcher.ts:272`)—— 散文冒充合法对象;大量 `.catch(()=>{})` | fail-loud;processors 中止;证据 schema 强制 | 与 SDLC 的"引用即打开/反奉承/证据"纪律**直接冲突**;审查/审计裁决可被静默污染 | 🔴 |
| O12 | **action 面过大** | ~168 个 action 文件,~40 个自动生成的 default-export **THIN shim** 仅为注册 MCP 工具名;`runsList/runState/runCancel/…` 逐个拆分 | 官方"小面":合并成 op 参数化的 CRUD;`agentTool:false` 隐藏 UI-only | brain 上下文里工具爆炸,选择退化 | 🟡 |
| O13 | **硬编码端点/凭据/自铸 JWT** | `http://192.168.1.250:9000/v1`+`sk-vllm-local`(`sdk-brain-session.ts:23`)、`localhost:3002` MCP、brain **自铸** `A2A_SECRET` JWT 调自己 MCP(`brain-mcp-config.ts:48`) | env / 框架签发凭据 | 环境泄漏 + 凭据卫生 | 🟡 |
| O14 | **V2 死层** | V2 LibSQL 表 + `engine/scheduler.ts` + `queue/*` + board/canvas UI **未被任何 live 路由挂载**;`workflow-canvas` 自述"@xyflow/react removed" | —— | 大量死重量,维护/认知负担;`executor-choice.ts` 禁 claude-code 作 engine 却只作用于死路径 | 🟡 |
| O15 | **全局池容量** | `poolCapacity` 默认 8 **跨所有 run**(`v3-reconciler.ts:1238`);声明的 run `priority` 实际未进 dispatch 排序 | —— | 一个 run 的扇出饿死其余全部 run | 🟡 |

### 2.2 Tracker(流程域)

| # | 关注点 | 现状(证据) | 官方做法 | 影响 | 级别 |
|---|--------|-----------|---------|------|------|
| T‑A | **审批门越权** | `approve-gate.ts:20`、`reject-gate.ts:20` 按 `id` 查 `approvals` **无 `ownerScope`** 就改状态 | `assertAccess` | **任意登录用户(任意 org)可批准/驳回任意审批 id** | 🔴 |
| T‑B | **访问域** | 每表都 `ownableColumns()`,但用**自写 `ownerScope()`**(`server/lib/access.ts`),非框架 `accessFilter`;`list-queue.ts:29` 内联 owner 过滤 | `accessFilter`/`assertAccess` | 绕过 sharing 子系统;易漏(见 T‑A) | 🟠 |
| T‑C | **审计重造** | 自造 `tracker_activities` 表,几乎每个写 action 直接插一行(`触发/完成/回退/推进/验收…`);`actorKind` 手工设(且 `trigger/complete/rollback` 恒写 `"human"` 即便 agent 驱动) | `defineAction` 自动 audit-log + `list-audit-events` | 重造 T9;无 audit-log 的 scoped 读保护;actor 归属不准 | 🟠 |
| T‑D | **无 automations / 事件** | 无框架 automations / recurring-jobs / 服务端定时。状态迁移 = UI **4s 轮询** `get-activity`/`list-work-items`,`get-activity` 每次读时**内联 status 写回**(`get-activity.ts:282-327`) | event-bus `emit` + automations,或确定性写回通道 | 关闭详情页 → status 停滞到下次看板轮询 | 🟠 |
| T‑E | **跨应用耦合(A2A 绕行)** | tracker→orchestrator、tracker→content 均为**手写 MCP client**(`orchestrator-client.ts`、`content-client.ts`),各**用 `node:crypto` 自铸 HS256 JWT**、复制 ~180 行传输/解析。`agent-native.json` 声明了 A2A connection 但注明"实为确定性 MCP tools/call,非 A2A NL loop" | `agentNative.invoke` / `call-agent` / A2A | 两份近重复客户端;无库无轮换;绕过官方跨应用路径 | 🟠 |
| T‑F | **跨应用裸 SQL** | `get-activity.ts:79-97` 直接 `SELECT status, run_id FROM brain_tasks WHERE thread_id=?` —— **裸读 orchestrator 的表** | A2A 读对方 action,或 orchestrator 反向写回 | **最严重的隔离破坏**;仅因共享 Postgres 才能跑;非 PG 开发即断 | 🔴 |
| T‑G | **status 是外部缓存** | item.status(`queued/running/done/failed`)权威其实是 orchestrator `brain_tasks.status`,仅在 `get-activity` 读时机会写回 | 事件/写回推送 | 无 owner 的生命周期字段;易 stale | 🟠 |
| T‑H | **run-acceptance 无 UI** | 验收(头等能力)仅 agent/MCP 可达,`use-tracker.ts` 无 `useRunAcceptance`,四个可编辑页无按钮 | Agent/UI 对等(T1) | 人无法从 UI 触发验收 —— 对等破坏 | 🟡 |
| T‑I | **符号当图标(违项目禁令)** | `WorkItemDetailPage.tsx:496/807`、`SprintDetailPage.tsx:876`、`SprintsPage.tsx:167/176`、`NewWorkItemPage.tsx:220` 用 `→ ← ` 文本字符当图标 | Tabler Icons | 违反 [[no-emoji-no-symbol-icons]] | 🟡 |
| T‑J | **硬编码内网 IP** | `content-client.ts:31` 默认 `http://192.168.1.101` 作 content 公网基址,烙进每条验收证据 URL | env-only | 环境泄漏 | 🟡 |
| T‑K | **迁移残骸 / schema drift** | v9 建的 8 表列名与 `schema.ts` 不符,v11 补真列、死列残留(`db.ts:200-214`);v16 补建曾 500 的 `tracker_approvals` | 只增迁移 + 一致 | 脆弱历史,认知负担 | 🟡 |
| T‑L | **AGENTS.md ↔ 代码漂移** | `AGENTS.md:35` 称 `list-tracker-activities` "poll orchestrator activity",实际只读本地表 | 指令与代码一致 | 误导契约 | 🟡 |

> ✅ **Tracker 做对的**:action 唯一事实源(48 处 hook,无裸 REST for app data);`application_state`
> 用框架原语(tab 作用域扩展);`decompose-epic`/`validate-dependency-graph` 确定性无 AI;chat plugin
> `databaseTools:false`(agent 不能裸 SQL)。这些**保留**。

---

## 三、优化设计(目标架构 + 迁移路线)

### 3.1 目标架构

```
┌─ Tracker = 流程域(单一事实源)────────────────────────────┐
│ 项目/仓库 · Sprint(phase 权威)· Epic · 工作项 · 依赖图      │
│ 七阶段状态机 · 审批门 · sprint 产物库 · 规划技能链           │
│ 数据:框架 ownable + accessFilter;审计:framework audit-log  │
│ 迁移:emit 领域事件(event-bus),不轮询                      │
└──────────┬──────────────────────────────▲──────────────────┘
   invoke("orchestrator", brief, {userEmail})   │ 反向写回:orchestrator run 终态
   (A2A,brief 全文入 inputs,身份签 JWT)        │ → invoke("tracker","advance-stage",…)
                                                │ (确定性,幂等;不裸读对方表)
┌──────────▼──────────────────────────────┴──────────────────┐
│ Orchestrator = 执行底座                                      │
│ ┌ 声明式 SDLC DAG(保留:多轮审查/Phase H/Phase G)─────────┐ │
│ │ 节点不再自造进程:                                        │ │
│ │  · brain / CC worker → Harness Agents(startAgentHarnessRun)│
│ │  · vLLM dev → engine 层(createAISDKEngine)               │ │
│ │  · guard/proof-of-done → in-loop processors + 证据 schema │ │
│ │  · human 门 → 框架 needsApproval                         │ │
│ └──────────────────────────────────────────────────────────┘ │
│ 生命周期/自愈/流式/resume:全部投影到 run-manager,删自造 sweep │
│ 数据:框架 DB 层(runMigrations + ownable + shares),单一 DB   │
│ Workspace:host git worktree 隔离(保留)                      │
└──────────────────────────────────────────────────────────────┘
```

分工不变(tracker 拥有"做什么/到哪/谁批",orchestrator 拥有"怎么做/哪个沙箱/哪个模型"),
**变的是底座**:一切 worker 走 run-manager,一切跨应用走 A2A,一切数据走框架 DB/audit/access。

### 3.2 六条设计原则

1. **保留 DAG 的确定性,重建它的执行底座。** DAG 是框架故意不给、而 SDLC 硬需要的东西 —— 它保证
   "审查/审计/晋升"不被 brain 遗漏。但 DAG 节点内部**不该自己 spawn 进程**:节点执行 = 调用框架
   原语。DAG = 编排语义层,run-manager/harness/engine = 执行层。

2. **一切 worker 走 run-manager。** brain 与 CC worker → `startAgentHarnessRun`(可恢复 SQL session,
   免 cwd-recovery/`--resume` hack);vLLM dev → engine 层(已合规,去掉名字欺骗);删掉裸
   `spawn("claude")` 与死的 ACP adapter(改为真正接线)。收益:heartbeat/soft-timeout/取消/
   transcript/resume 全部免费,`brain-monitor` 巡检可退休。

3. **可恢复性与自愈交给框架,删自造 sweep/reaper。** V3 run 投影为 run-manager 的
   `BackgroundAgentRun`,完成靠 `reconcile*` 在读路径自愈,而非 90s/60s/5s 多个 setInterval + 6 组
   grace。副作用幂等交给 durable-resume。48 个 env 阈值大幅缩减。

4. **页面可配的 config 是产品硬需求 —— SQL 作源,但适配框架 profile 形状。** 用户要求节点/技能/
   agent 定义能在**页面**管理(不是 `.md` 文件)。这是**受控偏离**,不是要消除的 gap:保留
   `orchestrator_agent_defs` SQL 作**可编辑源**,但(a)对齐框架 Custom Agent profile 的字段形状,
   (b)加一层适配把 SQL def 物化成 harness/agent-teams 能读的 profile(或直接让 harness session
   的 `instructions/tools` 从 SQL def 注入)。**DAG 模板同理**(`workflowSave` 入库、带版本、页面可改)——
   这是把"流程逻辑不进代码"落到实处([[sdlc 三层可演进性]]),官方文件式 profile 反而做不到页面配置。

5. **跨应用一律 A2A `invoke` + 反向身份,禁裸 SQL / 禁自铸 client。** 用 `agentNative.invoke` 取代
   `orchestrator-client.ts`/`content-client.ts` 两份手写 JWT+MCP。**彻底删除** `get-activity` 里裸读
   `brain_tasks` —— 改为 orchestrator run 终态经 A2A 反向写回 tracker `advance-stage`(确定性、幂等、
   身份取自 run tags),UI 轮询降级为兜底。

6. **全链 fail-loud + 证据 schema(对齐 SDLC 灵魂)。** guard 求值出错**必须失败**而非当作通过;
   schema 违规**必须失败/纠偏**而非静默 `{text}`;去掉吞异常的 `.catch(()=>{})`。proof-of-done /
   覆盖率 / 越界文件用 **in-loop processors** 在"声称完成"前中止。这是把审查/审计的反奉承纪律真正编码进引擎。

### 3.3 数据与访问统一

- V3 表迁到框架 DB 层:`runMigrations`(只增,`IF NOT EXISTS`)、schema helpers(去 Postgres 专用
  DDL,恢复 T11 可移植)、官方 `ownableColumns()` + `registerShareableResource`。**单一 DB 连接**,
  淘汰 V2/V3 双库。
- 读写全走 `accessFilter`/`assertAccess`,**fail-closed**(caller 为空 = 拒绝,不是放行)。
- 审计:tracker 删 `tracker_activities` 写入,靠 `defineAction` 自动 audit-log;若需领域事件流(transcript
  面板),用 audit-log 的 `target`+`summary` 投影出视图,而非平行表。

### 3.4 安全修复(P0,先做)

| 项 | 修复 |
|---|---|
| O9 V3 越权 | 所有 V3 读/写 action 上 `accessFilter`/`assertAccess`,`if(ownerEmail)` 改 fail-closed |
| T‑A 审批越权 | `approve-gate`/`reject-gate` 加 `ownerScope`/`assertAccess`(按 sprint/project 归属) |
| O10 裸 SQL | reconciler/queue 全部参数化 |
| O11 静默失败 | guard-error → 节点 failed;schema 违规 → 纠偏一次后 failed;去吞异常 |
| T‑F 跨应用裸 SQL | 删 `SELECT … FROM brain_tasks`,改 A2A / 反向写回 |

### 3.5 分阶段迁移路线

> 用系统自身跑(tracker 建单 → brain 派 vLLM 改 template 代码),我(管理者)做方案/验收/纠偏。
> 每阶段可独立部署到 101 边测边进。

| 阶段 | 主题 | 交付 | 依赖 |
|---|---|---|---|
| **P0 安全 & fail-loud** | 堵越权、参数化、去静默 | O9/O10/O11 + T‑A/T‑F | 无(最高优先,风险最低,收益最大) |
| **P1 brain → Harness** | brain 与 CC worker 换 `startAgentHarnessRun` + 可恢复 session | O1/O2;退休 `brain-monitor` cwd hack | P0 |
| **P2 run 生命周期 → run-manager** | V3 run 投影为 BackgroundAgentRun,删多余 sweep/reaper,轮询转订阅 | O4/O5;env 瘦身 | P1 |
| **P3 跨应用 A2A + 写回** | `invoke` 取代两份手写 client;反向写回通道;删裸 SQL | O13/T‑E/T‑F/T‑G/T‑D | P0(T‑F) |
| **P4 数据/访问/审计统一** | V3 迁框架 DB 层;单库;`accessFilter`;audit-log 统一;删 V2 死层 | O8/O14 + T‑B/T‑C | P2 |
| **P5 卫生 & parity** | action 收敛(op 参数化 + `agentTool:false`);run-acceptance UI;Tabler 图标;去硬编码 IP;迁移残骸清理 | O12/O3/O15 + T‑H/T‑I/T‑J/T‑K/T‑L | 随时 |

> 受控偏离 **O7/原则四**(agent-def / DAG 模板页面可配)贯穿各阶段:P1 让 harness 从 SQL def
> 读 profile;不改"页面配置"的产品面。

### 3.6 保留清单(不要动的正确决策)

- **声明式 DAG + 多轮审查 + Phase H 审计 + Phase G 晋升** —— SDLC 的确定性骨架,框架不提供,保留。
- **workspace = host git worktree 隔离 + commit 前密钥扫描 + 临时 token** —— 稳,保留。
- **vLLM 作 dev engine**(通过 engine 层)—— 保留,仅去名字欺骗。
- **"流程逻辑不进代码、配置进 SQL/页面"三层可演进性** —— 产品理念,保留并做实(原则四)。
- **tracker 的 action 唯一事实源 + application_state + 确定性图校验/拆解 + `databaseTools:false`** —— 合规,保留。

---

## 四、需要你拍板的决策

1. **DAG 去留(推荐:保留 + 重建底座)。** 备选是全盘倒向 Agent-Teams(agent loop 即编排)。
   不推荐:SDLC 需要确定性,过去 brain 自由编排恰恰反复漏跑闸。**保留 DAG,只换执行层。**
2. **V2 死层(推荐:删除)。** LibSQL 表 + V2 引擎 + board/canvas UI 无 live 路由,是纯负担。删。
3. **agent-def / DAG 模板存储(推荐:SQL 作源 + 适配框架 profile)。** 你的"页面可配"硬需求 >
   官方文件式 profile;保留 SQL,加适配层接入 harness/agent-teams,而非二选一。
4. **迁移节奏(推荐:先 P0 安全)。** P0 风险最低、收益最大(堵两处越权 + 去静默失败 = 直接对齐
   SDLC 的证据纪律),再按 P1→P5。

---

## 附:证据索引(供下钻)

- 官方原语:`packages/core/src/server/agent-teams.ts`、`agent-teams-run-queue.ts`、`agent/run-manager.ts`、
  `run-store.ts`、`agent/harness/*`、`a2a/{server,auth-policy}.ts`、`application-state/*`、`coding-tools/sandbox/*`。
- 官方文档:`packages/core/docs/content/{key-concepts,actions,context-awareness,database,multi-app-workspace,
  a2a-protocol,automations,audit-log,agent-teams,harness-agents,dispatch,durable-background-runs,durable-resume,
  processors,human-approval,progress,code-agents-ui}.mdx`。
- orchestrator 证据:`server/brain/brain-session.ts:439`、`server/runtime/claude-code-worker.ts:82`、
  `server/engine/v3-reconciler.ts:{104,497,597,871,919,1238}`、`server/engine/v3-dispatcher.ts:272`、
  `server/vllm-engine.ts:29`、`actions/v3-runs.ts:36`、`actions/brain-threads.ts:53`、`server/db/v3.ts`、
  `server/db/schema.ts:344`、`server/queue/v3-run-reconcile-sweep.ts`、`server/brain/brain-mcp-config.ts:48`。
- tracker 证据:`actions/approve-gate.ts:20`、`reject-gate.ts:20`、`actions/get-activity.ts:{79,282}`、
  `server/lib/{orchestrator-client,content-client,access}.ts`、`content-client.ts:31`、
  `WorkItemDetailPage.tsx:{496,807}`、`SprintDetailPage.tsx:876`、`SprintsPage.tsx:{167,176}`、
  `NewWorkItemPage.tsx:220`、`server/plugins/db.ts:{200,277}`。
