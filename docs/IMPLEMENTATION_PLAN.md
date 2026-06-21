# Routines + Chief-of-Staff 实施规划

本文是**执行规划**,不重复两份设计文档的 schema/代码细节。深度细节见:
- [docs/ROUTINES_DESIGN.md](./ROUTINES_DESIGN.md)
- [docs/CHIEF_OF_STAFF_DESIGN.md](./CHIEF_OF_STAFF_DESIGN.md)

目标:按本规划逐阶段执行完毕后,得到**两个生产可用、功能完整的真实 app**(Routines、Chief-of-Staff),都跑在你本地长驻自托管环境里。

---

## 0. 已锁定决策(不可再动摇 —— 执行时禁止重新解释)

| 项 | 决定 |
|---|---|
| 落点 | 本仓库 `templates/` 下,两个**独立** app:`templates/routines`、`templates/chief-of-staff`(与现有 mail/calendar 等并排) |
| 数量 | 两个独立 app,经 A2A / 共享 action 咬合;不合并 |
| 数据源(Chief-of-Staff) | **mail、calendar、brain、analytics** 四个 app(各自本地跑) |
| 运行模型 | **长驻自托管进程**。内置 `setInterval(60s)` 调度 + 进程内 event-bus 直接用,**不做** serverless 外部 cron / 持久事件兜底(明确排除) |
| 运行历史写入 | **改 core 极小钩子**:`routine_runs` 表由 `packages/core` 持有并写入(`executeJob` / `dispatchAgentic` 各加少量行),Routines app **读**该表。这是唯一一处 core 改动,additive |
| 租户模型 | 单用户本地自用。`ownableColumns()` 照用,owner 默认本地用户;不做多租户/组织共享 UI(但不破坏 access 原语) |
| 编排原语归属 | fan-out 编排逻辑先写在 Chief-of-Staff 内、留干净模块边界(`shared/fanout.ts`),日后给 orchestrator 抽取;本规划不提前拆公共包 |

---

## 1. 全局约定与硬约束(每个阶段都适用)

**技术栈/风格**
- TypeScript only;Prettier 跑改动文件;shadcn/ui 原语 + Tabler 图标;无自绘弹层;无 `alert/confirm/prompt`(用 shadcn dialog)。
- 数据走 `defineAction` + `useActionQuery`/`useActionMutation`;**禁止**手写 `fetch` 到框架/兄弟 app 路由。
- 所有 AI/LLM 经 agent chat;**禁止** app 代码内联 LLM SDK。
- schema 只增不改;ownable 表用 `ownableColumns()` + `accessFilter`/`assertAccess`。
- 不硬编码密钥;外部出站走 `web-request` + `${keys.NAME}`(`app_secrets`)。
- 每个功能必须 touch 框架四区:UI / action / skill 或指令 / application_state。

**测试基线**(参照现有模板 plan/forms 的测试规格)
- 单测 vitest(action/lib 逻辑、frontmatter 解析、fan-out 并行、access 隔离)。
- e2e Playwright(关键用户流:建 routine → 触发 → 看历史;编译简报 → 面板渲染 → 深链)。
- 每阶段验收里列的检查点都要有自动化测试佐证,**不接受"看着能用"**。

**本地发现接线(一次性,Phase 0 完成)**
- 两个新 app + 四个数据源 app 各固定一个 dev 端口。
- 用 `.agent-native/workspace-apps.json`(或 `AGENT_NATIVE_WORKSPACE_APPS_JSON`)登记全部 6 个 app 的 `{id,name,path,url:"http://localhost:<port>"}`,经 `discoverWorkspaceAgents`(`agent-discovery.ts:597`)发现。**走 workspace manifest,不动 `packages/shared-app-config/templates.ts` 公共 allow-list**(保持私有,不污染公开模板目录)。

**"生产可用"的定义(两个 app 各自的最终验收门)**
1. 核心用户流端到端真实可用(非 mock),含错误/部分失败/空态处理。
2. 单测覆盖核心逻辑 + 至少 1 条 e2e 覆盖主流程。
3. 四区齐全;app-state 让 agent 能感知并操作该 app。
4. 跨用户访问隔离测试通过(即便单用户,access 原语不被绕过)。
5. 无 TODO/stub 残留在主路径;Prettier 干净。

---

## 1.5 审查修订与锁定澄清

> 经 4 路独立子 agent 对抗审查后修订。**本节覆盖前文任何冲突表述;冲突时以本节为准。** 每条都是执行 agent 必须遵守的硬约定。

### 1.5.1 进程拓扑现实 + 跨进程事件桥
六个 app 各自独立进程,各有自己的 scheduler、dispatcher、event-bus(单进程 `globalThis`)、resource 存储(`jobs/*.md`)、DB。由此:
- **每个 app 的 event-bus 只收到它自己进程内 emit 的事件**(进程内 EventEmitter,不跨进程)。
- **同进程事件**(`test.event.fired`、`agent.turn.completed`、`notification.sent`、`run.progress.*`,及 Routines 自己 `registerEvent` 的)由本进程 dispatcher 直接即时派发。
- **跨 app 事件**(别 app 里 `plan.created`/`mail.message.received` 等)经 **Phase A3 的跨进程事件桥**(durable `event_log` + 拉取式 cursor poller)交付到 Routines —— **完整实现**,见 §1.5.23。
- **Routines 定位**:集中编写/运行/观测**所有** routine 的中枢 —— 定时型经 A2A 够别 app;跨 app 事件型经事件桥订阅别 app 事件;deterministic 单步免 LLM。它管自己进程的 routine 存储,跨 app 能力一律走 A2A / 事件桥(不远程改别 app 的 jobs)。

### 1.5.2 自动简报的正确组合(改 Phase C;删除「无额外胶水」)
scheduler 的 agent loop 只持有宿主进程自己的工具;`compile-briefing` 在 CoS 进程,Routines 进程直接调不到。修正:**自动简报 = 跑在 Routines 进程的 schedule routine,正文经 A2A `invokeAgent("chief-of-staff", "编译并润色今天的晨间简报", { selfAppId:"routines" })`;CoS 的 agent 在自己 loop 里(有 compile/update 工具)完成 compile→update。** 这是统一 A2A 胶水,前文「无额外胶水」作废。

### 1.5.3 精修简报的唯一产出路径(解决面板按钮无 agent 润色)
润色 `summaryMd` **永远由 CoS 自己的 agent 产出**:面板「立即编译」按钮 = `sendToAgentChat("编译并润色今天的简报")`(走本 app agent chat),**不是**前端直调 action;自动 routine 经 A2A 让 CoS agent 做(1.5.2)。`compile-briefing` action 只产出结构化 sources + `deterministicDigest` 兜底;润色一律 CoS agent 调 `update-briefing`。守「AI 全走 agent chat」。

### 1.5.4 运行模式 = 生产模式
六个 app 跑 A2A fan-out 时**必须生产模式启动**(`AGENT_MODE=production` 或 `NODE_ENV=production`)。dev 模式下被叫 app 的 A2A handler 换 bash devScripts 而非 native action 工具(`agent-chat-plugin.ts` dev :4534-4552 vs prod :4553-4573)。Phase 0 据此跑生产模式。

### 1.5.5 `invokeAgent` 必传 `selfAppId`
self-call 防护仅在传 `selfAppId`(和/或 `selfUrl`)时生效(`invoke.ts:103/94`)。**所有 fan-out 调用必须传 `selfAppId`**(CoS 传 `"chief-of-staff"`,Routines 传 `"routines"`),否则自身入 targets 会递归自调。COS_DESIGN §6.1 示例据此补 `selfAppId`。

### 1.5.6 `shared/fanout.ts` 契约(B2 开工前定死)
导出 `runFanout(opts): Promise<BriefingSource[]>`,`opts = { selfAppId, targets: DiscoveredAgent[], buildPrompt:(appId)=>string, perAppTimeoutMs }`。
- 身份签发**在 runFanout 内部**用 `resolveA2ACallerAuth()`(30m JWT),调用方不传 auth。
- 并行 `Promise.allSettled`,每 target 一个 `invokeAgent({ target:t.id, selfAppId, prompt, async:true, timeoutMs:perAppTimeoutMs, ...auth })`。
- `latencyMs` = 调用前后 `Date.now()` 差。
- 配置要某 app 但 `discoverAgents` 未发现 → 该 source `status:"skipped"`,不报错不中断;超时 → `status:"timeout"`;rejected → `status:"error"`+`error`。
- 边界干净,日后 orchestrator 直接复用 `runFanout`。

### 1.5.7 workspace manifest 条目格式(否则静默丢弃)
每条 `{ id, name, path, url }`。**`path` 必填且必须以 `/` 开头**(如 `"/mail"`);`parseWorkspaceAppsManifest`(`agent-discovery.ts:464`)对无合法 `path` 的条目**静默丢弃不报错**。`url = "http://localhost:<port>"`。Phase 0 写 manifest 必满足,否则 app 发现不到且无报错。

### 1.5.8 frontmatter 统一(消除双重执行 bug)
scheduler 只看 `schedule`(`parseJobFrontmatter`,不认 `triggerType`),dispatcher 靠 `triggerType==="event"` 挑;同一 `jobs/*.md` 若 event 型残留合法 `schedule` 会被两套引擎**双重执行**。修正 `save-routine`:
- **一律用 `buildTriggerContent` 写**,显式写 `triggerType`("schedule"|"event"),不再用 `buildJobContent`。
- **event 型** `schedule` 写空串(`isValidCron("")` 为 false 故被 scheduler 跳过)。
- **切 kind**:event→schedule 清 `event/condition/mode`;schedule→event 把 `schedule` 置空。
- A2 验收新增:event 型 routine 不被 scheduler tick 拾取(断言只走 dispatcher 一条路)。

### 1.5.9 `routine_runs` 钩子落点(否则终态恒 success / 缺 threadId)
`executeJob`(scheduler.ts)与 `dispatchAgentic`(dispatcher.ts)的 catch **在 `runWithRequestContext` 回调内部且不 rethrow**。所以:
- 写入放**回调内部**:开始 insert `running` 行;在**成功路径末尾**与 **catch 分支**各更新终态(**不能**用函数级 finally,它只见 success)。
- `dispatchAgentic` 当前丢弃 `createThread` 返回值 → 改 `const thread = await createThread(...)` 拿 `threadId`。
- `routine_runs` 表在 **core 迁移集**注册;启动后断言表存在,Routines app 能 `select`。
- A2 验收含 error 路径:被执行体抛错(错误被吞)时仍落 `status:"error"`+`error` 非空+`finishedAt` 有值,不残留 `running`。

### 1.5.10 deterministic 模式 — 完整实现(Phase A4,定时型 + 事件型)
当前空壳只在 dispatcher else 分支(`dispatcher.ts:~294`),且 `JobFrontmatter` 无 `mode` 字段。Phase A4 完整补齐:
- **core**:给 `JobFrontmatter` 加 `mode:"agentic"|"deterministic"`(默认 agentic);`executeJob`(scheduler)与 `dispatchAgentic` 的 else 分支各读 `mode`,deterministic 时调共享执行器 `runDeterministicStep(decl, ctx)`,**不起 agent loop**,仍写 `routine_runs`。
- **单步声明 schema**(定死,存 routine 正文的 fenced ```json 块或 frontmatter `action:` 字段):
  - `{ "kind": "web-request", "method": "POST"|"GET"|…, "url": "…${keys.X}…", "headers"?: {…}, "body"?: "…" }`
  - `{ "kind": "action", "action": "<已注册 action 名>", "params": { … } }`
  - web-request 经 `fetch-tool` 执行(`${keys}` 替换 + SSRF + URL 白名单);action 经 action registry 直接调,带当前 `runWithRequestContext` 身份。
- 两种触发(定时 + 事件)都支持 deterministic。`save-routine` 用 Zod 校验声明合法性,非法即拒不落文件。

### 1.5.11 事件型 dry-run 不走 fire-test
`fire-test` 硬编码 emit `test.event.fired`(`routes.ts:273`),不能用任意事件样例 payload。event 型 dry-run = **直接调 `condition-evaluator`(用户样例 payload)+ 直接走 `dispatchAgentic` 路径**,绕过 emit。

### 1.5.12 深链抽取规则(B3 定死)
`deepLinks` = (markdown 链接正则 `\[[^\]]*\]\((https?://[^)]+)\)` ∪ 裸 `https?://\S+`)并集,去重;**只保留 origin == 对应 source app `discovered.url` origin 的 URL**;对方回相对路径用该 app base url 补全为绝对;一个都抽不到 → 面板该 source 纯文本、**无死按钮**。B2 不承诺深链(只渲染 sources),B3 按此实现 + 验收降级路径。

### 1.5.13 analytics 源能力准确口径
analytics action 只有元数据级(`list-sql-dashboards`/`list-analyses` 不含结果数据),唯一带数据的 `get-analysis` 需先知 analysis id。所以 analytics 简报贡献准确定义为:**列最近 dashboards/analyses 作链接 +(可选)若用户维护了约定命名的「每日指标」analysis,则经 `get-analysis` 取其 `resultData` 并入简报**。不承诺「任意今天的指标」。Phase 0 验收测 `get-analysis` 取到 `resultData`(非仅元数据)。analytics 以此口径计入四源。

### 1.5.14 时区与「今天」
cron 与一切「今天」按**长驻进程本地时区**(自托管 = 用户本地)。`compile-briefing` 的 `date` 缺省由 **action 服务端 `new Date()`** 计算;routine 正文不算日期。

### 1.5.15 routine `name` 规则
`name` 直接做文件名 `jobs/{name}.md`:UI 显示名与文件名分离,文件名 slug 化 `[a-z0-9-]+`;`save-routine` 显式区分 create(已存在则拒绝)与 update;模板库 fork 同名追加 `-2/-copy` 避让。

### 1.5.16 数据源 = 你选定的 4 个
数据源 = **mail、calendar、brain、analytics**(你选定的四个)。COS_DESIGN 中提到的 content/plan 不在本次接入范围(非延期 —— 你选了这四个);需要时照同一 A2A fan-out 模式追加即可,无结构改动。

### 1.5.17 Phase C 前置修正
Phase C 前置 = **A2(需 `routine_runs`)+ B3**,不是 A1。§2 图与文字按此更正。

### 1.5.18 验收通用原则(替换所有主观措辞)
凡下列模糊词,一律按右侧客观断言重写:
- 「真连上/真实数据」→ 集成健康检查返回 `connected` **且**返回 ≥1 个带真实对象 id 的非空记录;空环境视为不通过。
- 「自动刷新」→ fake timer 推进至 ≤ 2× 当前 poll interval 常量内完成一次 refetch,无显式 reload。
- 「不死循环」→ 自调用时 `invokeAgent` 同步返回 `code:"self-call"`,其余 target 调用次数 == `targets.length-1`。
- 「叙述非拼接」→ 桩 agent 经 `update-briefing` 写入可识别 marker;断言最终 `summaryMd` 含该 marker **且** `!= deterministicDigest(sources)` **且** `compile-briefing` 内 LLM spy == 0。
- 「有上限」→ 具名常量 `MAX_PER_SOURCE_CHARS`、`MAX_BRIEFING_BYTES` 被测试引用;超限截断 + 标记。
- 「view-screen 让 agent 说出…」→ 断言 `view-screen` 的**结构化返回**与 `application_state` 一致,不断言 agent 措辞。

### 1.5.19 补充负向/边界验收
- **JWT 过期/篡改**(B2):带过期或错签 JWT 调 mail → `verifyA2AToken` 拒绝,该 source `status:"error"`,无数据泄露。
- **并发写历史**(A2):手动 `run-routine` 与定时 tick 同时命中同一 routine → `routine_runs` 两行 `routineName/owner/threadId` 各自正确、不交叉。
- **明文密钥不外泄**(A2):捕获该次 agent loop 上下文与日志,对密钥明文值子串扫描断言 0 命中(只见 `${keys.X}` 或掩码)。
- **空态**(A1/B1/B3):无 routine→列表空态不报错、tick 不炸;无 briefing→面板空态;四源全空→briefing `status:complete` 且面板显示「今日无事项」不崩。

### 1.5.20 生产可用门(§1 五条)拆成可勾子项
1. 三条 e2e 全绿:正常流 / 部分失败 / 空态。
2. 具名核心模块(`runFanout`、frontmatter 往返、access 隔离、截断、deterministic 执行)行覆盖 ≥80% + e2e 主流程全绿。
3. 存在对应 `actions/*` 与 `skill` 文件 + `view-screen` 返回结构化 state + `navigate` 改变 `application_state`(结构断言)。
4. 跨用户隔离测试通过(A2 第8 / B3 第5 兑现)。
5. 对 `actions/`、`shared/`、`app/` grep `TODO|FIXME|not yet implemented|stub` 命中 0;`prettier --check` 改动文件退出码 0。
A5 与 Phase C 各自逐条引用本 5 子项,不再用「全部满足」概括。

### 1.5.21 Phase 0 骨架补 db.ts + app-skill.json
- chat 模板**无** `server/plugins/db.ts`;两个新 app 各补迁移骨架(对照 `templates/plan/server/plugins/db.ts` 的 `runMigrations`,空迁移列表起步,后续 Phase 追加 `briefings` 等)。
- app 元信息文件名是 `agent-native.app-skill.json`(非 `agent-native.json`)。**chat 模板没有这个文件**(仅 plan/assets/design 有);以 `templates/plan/agent-native.app-skill.json` 为蓝本,改 `id/displayName/local.template/local.defaultUrl`(字段集:`schemaVersion/id/displayName/local.{template,defaultUrl,commands}/surfaces/skills`)。

### 1.5.22 锚点勘误 + provider-api 说明
- `refreshEventSubscriptions` 定义 `dispatcher.ts:190`(调用点 `actions.ts:127`);deterministic 空壳 `dispatcher.ts:~294`;refresh-screen `~:919`;30m JWT 来自 `resolveA2ACallerAuth` 显式传入(`signA2AToken` 默认 15m,务必经 caller-auth 取 token)。
- 本两 app **不引入 provider-api substrate**:CoS 只跨 app 取加工结果,Routines 出站走 `web-request`+`${keys}`;provider 直连是各数据源 app 的职责。

### 1.5.23 跨进程事件桥(Phase A3 完整实现)
让 Routines 进程能对别 app 进程 emit 的事件做反应。**拉取式 durable log + cursor**,无共享 DB、不丢事件、重启不漏。

**core 侧(additive,每个 app 自动获得):**
1. `event_log` 表(各 app 自己 DB):`{ seq INTEGER PK AUTOINCREMENT, owner_email, org_id, name, payload_json, emitted_at }`。
2. `emit()`(`bus.ts`)在进程内派发后**追加**写一行 `event_log`(durable sink;同进程订阅照旧即时,不受影响)。
3. 读取端点 `GET /_agent-native/event-log?since=<seq>&names=<csv>`:返回 `seq > since` 且 name 命中、**owner == 认证用户**的事件,响应 `{ events:[{seq,name,payload,emittedAt}], cursor:<maxSeq> }`。鉴权同 A2A(JWT)/会话。
4. 事件目录端点 `GET /_agent-native/events/catalog`:返回本 app `listEvents()`(name+description),供下拉展示「`plan.created`(plan)」这类带来源的项。

**Routines 侧:**
5. routine frontmatter 加 `sourceApp`(发该事件的 app id;同进程事件留空=self)。
6. `event_cursors` 表(Routines DB):`{ source_app, owner_email, cursor }`,持久化每来源拉取游标。
7. **事件桥 poller**(Routines 进程 `setInterval` 默认 15s,与 scheduler 并列):按 enabled 的跨 app 事件 routine 聚合 `sourceApp`→订阅事件名;对每 sourceApp 用 `resolveA2ACallerAuth()` JWT 拉 `GET <sourceAppUrl>/_agent-native/event-log?since=<cursor>&names=…`;对每条新事件匹配 routine → `condition-evaluator` 评估 → 派发(agentic 走 `dispatchAgentic`,deterministic 走 `runDeterministicStep`)→ 推进并持久化 cursor。
8. `list-trigger-events` 聚合:本进程 `listEvents()` + 每个 discovered 兄弟 app 的 `/events/catalog`,下拉按 `事件名(来源 app)` 展示,选中跨 app 事件时自动写 `sourceApp`。

**不丢/不重**:durable `event_log` + 持久 cursor,重启从 cursor 续拉;同一事件只处理一次(cursor 单调)。

### 1.5.24 数据源未连接时的验收口径(OAuth 不阻塞代码开发)
mail/calendar/brain/analytics 的 OAuth/凭证由用户后续接,**不阻塞代码实施**。未连接期间各阶段照常推进、照常判 pass:
- 所有 fan-out / 合成 / 事件桥逻辑用 **mock 的 invokeAgent / event-log 端点 / 兄弟 app 响应** 做单测与集成测试:并行性(`Promise.allSettled`,墙钟 < 串行)、身份透传(断言 `runFanout` 把 `resolveA2ACallerAuth` 的 userEmail/JWT 传入 `invokeAgent`)、部分失败(`status:partial`)、自调用防护(`invokeAgent` 同步返回 `code:self-call`)、字节上限(`MAX_PER_SOURCE_CHARS`/`MAX_BRIEFING_BYTES` 截断)、深链抽取规则、跨用户隔离 —— 这些**不需要真实数据**,是各阶段的**硬验收**。
- 跨 app 真实 A2A 身份回环可用**自家 routines + chief-of-staff 两 app**(无需 OAuth)端到端验证,不依赖数据源。
- 唯一需要真实数据的是「一次 live 端到端冒烟」(真实邮件/日程进一份真简报)。它**不计入阶段验收门**,逐条登记到 `docs/LIVE_SMOKE_CHECKLIST.md`,待用户接好 OAuth 后手动跑一遍。

---

## 2. 阶段总览与依赖

```
Phase 0  地基与环境(共用,阻塞一切)
   │
   ├── Track A:Routines ──────────────┐
   │   Phase A1  schedule 型成品        │
   │   Phase A2  event 型(同进程)+ 历史 + dry-run + keys
   │   Phase A3  跨进程事件桥 → 跨 app 事件触发完整可用
   │   Phase A4  deterministic 全实现(定时型 + 事件型)
   │   Phase A5  模板库 + 收尾 → Routines 生产可用
   │
   ├── Track B:Chief-of-Staff ────────┤(A、B 可在 Phase 0 后并行)
   │   Phase B1  表 + 面板 + 只读
   │   Phase B2  fan-out(mail+calendar)
   │   Phase B3  合成 + brain/analytics + 深链 → Chief-of-Staff 核心可用
   │
   └── Phase C  咬合 + 自动简报 + 收尾(需 A2 + B3)→ 两 app 全生产可用
```

- **A 轨与 B 轨在 Phase 0 之后相互独立**,可并行推进(不同 agent/不同时间)。
- A 轨内部顺序:A1 → A2 → A3 → A4 → A5(A3 事件桥与 A4 deterministic 都依赖 A2 的 `routine_runs`)。
- Phase C 需要 Routines 到 **A2**(需 `routine_runs`)+ Chief-of-Staff 到 B3(compile-briefing 完整)。
- 执行顺序建议:Phase 0 → (A1, B1) → (A2, B2) → (A3, B3) → A4 → A5 → C。

---

## Phase 0 — 地基与环境(共用)

**目标**:六个 app 本地能同时跑、能互相发现、能互相 A2A,两个新 app 骨架就位。

**范围(in scope)**
1. 在本地把 **mail、calendar、brain、analytics** 四个数据源 app 跑起来并**接好各自集成**:mail/calendar 的 Google OAuth、brain 的至少一个源、analytics 的至少一个源。每个分配固定 dev 端口。
2. scaffold `templates/routines` 与 `templates/chief-of-staff` 两个 app 骨架(从 chat 模板起步:full-page agent chat + 框架 DB/observability/extensions wrapper),各分配固定 dev 端口。
3. 写 `.agent-native/workspace-apps.json` 登记全部 6 个 app。
4. 两个新 app 各写 `agent-native.app-skill.json`(蓝本 `templates/plan/...`,§1.5.21)+ sidebar 占位 + 一条 `hello` action 验证可跑。

**固定 dev 端口(钉死,写进 manifest `url`,避开现有 8099/8100/8105):** mail=8110 · calendar=8111 · brain=8112 · analytics=8113 · routines=8114 · chief-of-staff=8115。manifest 每条 `path` 必填且以 `/` 开头(§1.5.7),否则该 app 被静默丢弃。

**不在本阶段范围**:任何 routine/briefing 业务逻辑;UI 细节;表结构(除骨架默认)。

**实施方案**
- 数据源 app 用各自现成模板,不改它们的代码;只做环境配置(OAuth、源连接)。这是**你的环境准备**,不是写代码 —— 但它是 B 轨能用真实数据的前提,必须先完成。
- 两个新 app 骨架:复制 chat 模板结构,改 app id/name/displayName,清掉示例业务。
- workspace manifest 用绝对 dev URL,确保 `discoverAgents("chief-of-staff")` 能列出 mail/calendar/brain/analytics。

**验收要求**
- [ ] 6 个 app 各自 `dev` 能起、首页能开。
- [ ] **mail + calendar 为 B2 硬前置**:各自集成健康检查返回 `connected` 且 `list-emails`/`list-events` 返回 ≥1 个带真实 id 的非空记录(空环境不通过,§1.5.18)。**brain + analytics 可延后到 B3 前接好**;analytics 验收测 `get-analysis` 能取到 `resultData`(非仅元数据,§1.5.13)。
- [ ] 在 chief-of-staff 进程里调 `discoverAgents("chief-of-staff")`,返回数组**包含** mail/calendar/brain/analytics,且 url 指向各自 localhost 端口。
- [ ] 从 chief-of-staff 用 fan-out 同一函数 `invokeAgent({ target:"mail", prompt:"ping", selfAppId:"chief-of-staff", async:true, ...resolveA2ACallerAuth() })` 调 mail:task 终态 `completed`、mail 端 `verifyA2AToken` 还原 `sub`==发起用户、`responseText` 非空(§1.5.5/1.5.6)。
- [ ] 两个新 app 的 `hello` action 前端能调通、agent 能调通。

---

## Phase A1 — Routines:schedule 型成品

**目标**:可视化建/改/启停**定时** routine,引擎真的按 cron 跑。

**范围**
- Actions(`defineAction`,前端+agent 共享):`list-routines`、`get-routine`、`save-routine`(仅 `kind:"schedule"`)、`delete-routine`、`set-routine-enabled`。
- 存储:写 `jobs/{name}.md` resource,统一用 `buildTriggerContent`(显式 `triggerType:"schedule"`,§1.5.8)序列化、`parseJobFrontmatter` 读取,不手拼 frontmatter。
- UI:`routines` 列表页 + `routines/new`、`routines/:name` 编辑页;cron 输入 + `describeCron`(`cron.ts`)实时人类可读回显 + 常用预设;enabled 开关(乐观)。
- app-state:写 `navigation`;`view-screen` 返回列表/当前编辑项;`navigate` 命令。
- skill:写一篇 `routines` 使用 skill 教 agent 怎么建/改 routine。

**不在本阶段范围**:event 型;运行历史;dry-run;keys 管理;deterministic;模板库。

**实施方案**
- `save-routine` 内:校验 cron(`isValidCron`,非法即拒并返回明确错误,不写坏文件)→ `buildTriggerContent`(`triggerType:"schedule"`,§1.5.8)→ `resourcePut(owner, "jobs/{name}.md")` → 越权校验 `authorizeJobMutation`;name 按 §1.5.15 slug 化、create/update 显式区分。
- 列表读 `resourceListAllOwners("jobs/")`,过滤 owner-scope,只显示 `triggerType` 非 event 的(schedule 型)。
- 编辑页 cron 预设:每天 / 每工作日 / 每小时 / 自定义。

**验收要求**
- [ ] UI 建一条 `30 8 * * *` routine → 落 `jobs/{name}.md`,字段经引擎 `parseJobFrontmatter` 解析与 UI 输入一致。
- [ ] scheduler tick(测试里缩短 interval 或 mock 时间)到点真的进 `executeJob` 并建 chat thread。
- [ ] 非法 cron 在 `save-routine` 被 `isValidCron` 拦,返回明确错误,不产生文件。
- [ ] enabled=false 后,引擎 tick 跳过该 routine(断言不执行)。
- [ ] `view-screen` 能让 agent 说出当前有哪些 routine、正在编辑哪条。
- [ ] 单测:frontmatter 往返(build→parse 等价);越权(他人 routine 改不动)。

---

## Phase A2 — Routines:event 型 + 运行历史 + dry-run + keys

**目标**:补齐事件触发、可观测(历史)、可试跑、密钥自助。Routines 进入"可观测自动化"。

**范围**
1. **event 型 routine(本阶段先做同进程事件,跨 app 事件在 A3 点亮)**:`save-routine` 支持 `kind:"event"`(写 `TriggerFrontmatter`,统一经 `buildTriggerContent`,event 型 `schedule` 置空,§1.5.8),写后调 `refreshEventSubscriptions`(定义 `dispatcher.ts:190`,调用 `actions.ts:127`)即时生效;`list-trigger-events` 暴露本进程 `listEvents()`(`registry.ts:42`)给事件下拉(A3 后追加各兄弟 app 的 `/events/catalog`,§1.5.23);编辑页加事件下拉 + NL condition 文本框 + `mode` 字段(默认 agentic;deterministic 在 A4 落地)。
2. **运行历史(唯一 core 改动)**:
   - core 新增 `routine_runs` 表(`packages/core`,见 ROUTINES_DESIGN §5.2)。
   - 在 `executeJob`(`scheduler.ts:349`)与 `dispatchAgentic`(`dispatcher.ts:354`)的 **`runWithRequestContext` 回调内**各加:开始 insert `running` 行(带 routineName/kind/trigger/threadId);在**成功路径末尾**与 **catch 分支**各更新终态(success/error + finishedAt + error)——**不能用函数级 finally**(catch 不 rethrow,finally 区分不出终态,§1.5.9);`dispatchAgentic` 改 `const thread = await createThread(...)` 拿 `threadId`。**只加这两处,不改其它引擎逻辑。**
   - Routines app 加 `list-routine-runs` action(读 `routine_runs`,owner-scope)+ 历史 UI(抽屉/页):状态、耗时、错误、跳到 `threadId` 看 agent 当时操作。
3. **dry-run / run-now**:`run-routine` action —— 定时型走"立即构造同 prompt 经 run-manager 跑一次"(不改 `nextRun`);事件型**直接调 `condition-evaluator`(用户样例 payload)+ 直接走 `dispatchAgentic` 路径**,不走 `fire-test`(它只能 emit `test.event.fired`,§1.5.11)。编辑页"先试一次"按钮。
4. **keys 管理**:`keys` 页列/建/删 `app_secrets`(写 `/_agent-native/secrets/adhoc`,`secrets/routes.ts:513`),设 per-key URL 白名单;值掩码显示。routine 正文可用 `${keys.X}` 调 `web-request`。

**不在本阶段范围**:跨 app 事件交付(A3 事件桥);deterministic 执行(A4);模板库(A5)。

**实施方案**
- core 钩子改动要**集中、可回看**:单独 commit,附单测证明"每次执行落且仅落一行、终态正确"。
- event 型 condition 评估复用 `condition-evaluator`(Haiku),不自写判断。
- `run-routine` 对定时型:复用 `executeJob` 的 prompt 构造路径,但标记为手动触发(`trigger:"manual"`)写入历史,且**不**推进 `nextRun`。

**验收要求**
- [ ] 建 event routine(订阅同进程事件如 `agent.turn.completed`)→ `refreshEventSubscriptions` 后立即 emit 该事件 → `handleEvent` 命中并(条件满足时)执行。
- [ ] NL condition 不满足时 routine 不执行(用样例 payload 断言 Haiku 评估生效)。
- [ ] 本阶段事件下拉列本进程 `listEvents()` 注册的事件(跨 app 事件在 A3 接入 `/events/catalog` 后出现,§1.5.23)。
- [ ] **每次执行(定时+事件)在 `routine_runs` 落且仅落一行**,终态正确,`finishedAt` 有值,失败时 `error` 有值。
- [ ] `run-routine` 即跑一次定时 routine:产出 thread + 历史新增一行,且 `nextRun` 正常排期**未被改动**。
- [ ] 历史行能跳到对应 `threadId`。
- [ ] ad-hoc key 设白名单后,routine 用该 key 调白名单外 origin 被拒(复用 `substitution.ts` 校验);明文密钥不出现在 agent 上下文/日志。
- [ ] 跨用户隔离:A 看不到 B 的 routine 与 runs。
- [ ] core 钩子改动是 additive,既有 jobs/triggers 单测全绿。

---

## Phase A3 — Routines:跨进程事件桥 → 跨 app 事件触发完整可用

**目标**:Routines 能对别 app 进程 emit 的事件(`plan.created`、`mail.message.received` 等)做反应。完整实现 §1.5.23 的拉取式 durable 事件桥。

**范围**
1. **core(additive)**:`event_log` 表 + `emit()` 追加写入 + `GET /_agent-native/event-log?since=&names=` 读取端点 + `GET /_agent-native/events/catalog` 目录端点(§1.5.23 第 1–4 点)。
2. **Routines**:routine frontmatter 加 `sourceApp`;`event_cursors` 表;**事件桥 poller**(`setInterval` 15s:拉取→匹配→`condition-evaluator`→派发→推进 cursor);`list-trigger-events` 聚合各兄弟 app `/events/catalog`(§1.5.23 第 5–8 点)。
3. 编辑页事件下拉升级:展示 `事件名(来源 app)`,选中跨 app 事件时自动写 `sourceApp`。

**不在本阶段范围**:deterministic 执行(A4);模板库(A5)。

**实施方案**
- `emit()` 的 durable sink 必须**在进程内派发之后**追加,失败不阻断同进程派发(事件桥是增量,不破坏现有同进程路径)。
- poller 用 `discoverAgents` 解析 sourceApp URL;JWT 经 `resolveA2ACallerAuth`;cursor 持久化保证重启续拉、不重不漏。
- 跨 app 事件与同进程事件**走同一 `dispatchAgentic` / condition 评估路径**,只是来源不同。

**验收要求**
- [ ] 在 plan app 进程 `emit("plan.created", …, {owner})` → 该行进入 plan 的 `event_log`;Routines 事件桥 poller 在 ≤15s(fake timer 推进)内拉到并命中订阅 `plan.created`(sourceApp=plan)的 routine → 条件满足则执行,落 `routine_runs`。
- [ ] cursor 正确性:同一事件只处理一次(再 poll 不重复);Routines 重启后从持久 cursor 续拉,期间 emit 的事件不漏。
- [ ] `event-log` 端点 owner-scope:带用户 A 的 JWT 只拉到 A 的事件,B 的不可见。
- [ ] `list-trigger-events` 下拉含各兄弟 app 事件(`plan.*`/`mail.*`/`calendar.*` 带来源标注),数据来自 `/events/catalog`。
- [ ] 跨 app 事件 routine 的 `condition` 用真实事件 payload 经 `condition-evaluator` 评估,满足/不满足分别执行/跳过。

---

## Phase A4 — Routines:deterministic 模式完整实现(定时型 + 事件型)

**目标**:固定单步动作免 LLM 执行,定时型与事件型都支持。完整实现 §1.5.10。

**范围**
1. **core**:`JobFrontmatter` 加 `mode:"agentic"|"deterministic"`(默认 agentic);`executeJob`(scheduler)与 `dispatchAgentic` 的 deterministic 分支各读 `mode`,调共享 `runDeterministicStep(decl, ctx)`,不起 agent loop,仍写 `routine_runs`。
2. **单步声明执行器 `runDeterministicStep`**:解析 routine 正文声明(§1.5.10 schema:`web-request` | `action`);`web-request` 经 `fetch-tool`(`${keys}` 替换 + SSRF + 白名单),`action` 经 action registry 直接调(带 `runWithRequestContext` 身份)。
3. **Routines UI**:编辑页 `mode` 切到 deterministic 时展示单步声明编辑(kind + 字段);`save-routine` 用 Zod 校验声明。

**不在本阶段范围**:多步 deterministic 编排(只支持单步);模板库(A5)。

**实施方案**
- `runDeterministicStep` 是 scheduler 与 dispatcher 共用的纯函数式执行器,单独单测。
- 声明 schema 用 Zod 放 `shared/`,前后端共用。

**验收要求**
- [ ] deterministic「`web-request` 固定 POST 到 `${keys.WEBHOOK}`」routine:执行时对 agent-loop 入口与 Haiku 入口各 spy 断言 **0 次**;出站 `web-request` spy 恰好 **1 次**、URL 为替换后白名单 origin;落 `routine_runs` `success`。对照同义 agentic routine,agent-loop spy ≥1(证明探针有效)。
- [ ] deterministic「`action` 调某具名 action」routine:执行时该 action 被以声明 `params` 调用 1 次,无 agent loop,落 `routine_runs`。
- [ ] **定时型与事件型**各跑一条 deterministic routine,均按上述断言通过(证明两条触发路径都接了 `runDeterministicStep`)。
- [ ] 非法声明(缺字段/未知 kind/多步数组)在 `save-routine` 被 Zod 拒,返回字段级原因,不落 `jobs/*.md`。

---

## Phase A5 — Routines:模板库 + 收尾 → 生产可用

**目标**:开箱模板库 + 收尾打磨,Routines 达到生产可用。

**范围**
1. **模板库**:`templates` 页 + 一组预置 routine,**覆盖全部三类触发**(定时经 A2A、跨 app 事件经桥、deterministic 单步):每日简报触发器(定时)、PR 合并→建 recap(`plan.created` 跨 app 事件)、未读邮件 triage(定时 / `mail.message.received` 事件)、固定 webhook 上报(deterministic)…,一键 fork 到当前用户名下。
2. **收尾**:错误/重试体验、空态(§1.5.19)、Prettier、补齐两 app 单测 + e2e。

**不在本阶段范围**:serverless 可靠调度(自托管长驻不需要)。

**实施方案**
- 模板库 routine 以 `jobs/*.md` 种子文件形式提供,fork = 复制到用户 owner(同名追加后缀,§1.5.15)。

**验收要求**
- [ ] 模板库覆盖三类触发(定时 / 跨 app 事件 / deterministic)各 ≥1 条,fork 后真实可跑。
- [ ] 模板库 fork 出的 routine 归属当前用户、可独立改;同名 fork 自动避让(§1.5.15)。
- [ ] e2e:从模板 fork 一条定时 routine → 缩短 interval 触发 → 历史出现成功行,全程 UI 操作无需开 agent chat。
- [ ] **Routines 生产可用门(§1.5.20 五子项)全部满足**。

---

## Phase B1 — Chief-of-Staff:表 + 面板 + 只读

**目标**:简报数据层 + 今日面板骨架就位(还没 fan-out)。

**范围**
- 表:`briefings`(+ 可选 `briefing_shares`),`ownableColumns()`(见 COS_DESIGN §5)。
- Actions:`list-briefings`、`get-briefing`、`update-briefing`(写 summaryMd/title,`assertAccess`)。
- UI:`_index`(今日面板,渲染最新简报 + 各 source 折叠区骨架)、`briefings/:id`(详情/历史)。顶层挂 `useDbSync()`。
- app-state:`navigation`/`view-screen`/`navigate`。

**不在本阶段范围**:compile-briefing fan-out;A2A 调用;调度。

**实施方案**
- 先用"手动插入一条假 briefing"验证面板渲染 + `useDbSync` 自动刷新链路(`useActionQuery("list-briefings")` 在 action 事件后 refetch)。
- 面板按 `BriefingSource[]` 渲染折叠区 + 状态徽标 + 深链按钮位。

**验收要求**
- [ ] `briefings` 表建好,`accessFilter` list / `assertAccess` 单条生效。
- [ ] 手动插入一条 briefing,面板能列、详情页能开。
- [ ] 调 `update-briefing` 后,面板在一个 poll interval 内自动 refetch(无手动 reload)。
- [ ] `view-screen` 让 agent 能说出当前在看哪份简报。

---

## Phase B2 — Chief-of-Staff:fan-out(mail + calendar)

**目标**:`compile-briefing` 并行 async fan-out 真跑通,接 mail + calendar 真实数据。

**范围**
- `shared/fanout.ts`:可复用 fan-out 原语(`resolveA2ACallerAuth` 签身份 → 并行 `invokeAgent`(async)→ `Promise.allSettled` → 归并 `BriefingSource[]`)。**留干净边界,日后给 orchestrator 抽取。**
- `compile-briefing` action(COS_DESIGN §6.1):接 mail + calendar 两 app;`deterministicDigest` 无 LLM 兜底拼接;写 briefing 行 + `refresh-screen`。
- `buildAppPrompt(appId,...)`:mail/calendar 各自定制 NL 问法(`shared/app-prompts.ts`)。
- 面板"立即编译"按钮 = `sendToAgentChat("编译并润色今天的简报")`(走本 app agent chat,§1.5.3),**非**前端直调 action;乐观插入 `compiling` 占位。

**不在本阶段范围**:agent 智能合成;brain/analytics;深链抽取(基础即可);调度。

**实施方案**
- fan-out **必须并行 async**(`async:true` + allSettled),不串行 await;单 app `withTimeout`(~35s)超时记 `status:timeout`。
- 身份:`resolveA2ACallerAuth()` 自动签 30m JWT;依赖"认证 A2A 进对方 loop 拿全量工具"(`agent-chat-plugin.ts:4553-4573`)—— 不需要对方 expose 特定 action。
- 自调用防护:targets 含自身时被 `invokeAgent` self-call 防护拦掉(`invoke.ts:102-112,228-238`)。

**验收要求**
- [ ] 一键编译产出含 mail + calendar **真实数据**的 briefing(非 mock)。
- [ ] fan-out 真并行:mock invokeAgent 各 sleep 200ms,2 app 总墙钟 < 400ms。
- [ ] 身份转发:集成测试断言被叫 app `verifyA2AToken` 还原 email == 发起用户。
- [ ] 部分失败:1 app 抛错 → briefing `status:partial`,另一 app 数据照常入 sources,面板正常渲染。
- [ ] 自调用防护命中,不死循环。
- [ ] 单 app 返回 50KB 文本被截断,简报总体积有上限。

---

## Phase B3 — Chief-of-Staff:合成 + brain/analytics + 深链 → 核心可用

**目标**:agent 智能合成 + 四数据源齐全 + 深链可点。Chief-of-Staff 核心可用。

**范围**
- agent 合成:`compile-briefing`(作为 agent 工具被调用)返回结构化 sources 后,**调用方 agent** 调 `update-briefing` 写润色 `summaryMd`(守"AI 不内联"约束)。
- 接 **brain**(用 `search-everything` 当"该问谁"的路由起点,可驱动二级 fan-out)+ **analytics**。
- 深链抽取:按 §1.5.12 规则(markdown 链接 ∪ 裸 http(s) 并集、去重、只留源 app origin、相对路径补全、抽不到则纯文本无死按钮)从 `responseText` 抽 `deepLinks`,面板按钮跳回源 app。
- per-app NL 问法可在设置页覆盖。
- 产出 `chief-of-staff` skill **初版**:教 agent「先 `compile-briefing` 拿 sources、再 `update-briefing` 写 `summaryMd`」两步序列 + §1.5.3「润色只走 update-briefing」。B3 验收的 summaryMd 润色靠它,**不能拖到 Phase C**。

**不在本阶段范围**:自动定时简报(Phase C);分享 SSR(Phase C)。

**实施方案**
- brain 路由:先问 brain `search-everything` 拿 delegation 提示 → 据提示对正确下游 app 二级 fan-out(仍走 `shared/fanout.ts`)。
- 合成质量兜底:`sourcesJson` 原文永远保留可展开核对。

**验收要求**
- [ ] 四数据源(mail/calendar/brain/analytics)都能进一份简报。
- [ ] briefing 的 `summaryMd` 是 agent 润色的叙述(非纯拼接),且各 source 原文可展开核对。
- [ ] brain 路由:`search-everything` 提示能驱动到正确下游 app 的二级 fan-out。
- [ ] 深链:面板按钮跳回对应源 app 的正确对象。
- [ ] **跨用户隔离:用户 A 的简报绝不含用户 B 的邮件/事件**(两套数据访问测试)。

---

## Phase C — 咬合 + 自动简报 + 收尾 → 两 app 全生产可用

**目标**:Routines 定时驱动 Chief-of-Staff,早/晚自动简报;两 app 收尾到生产可用。

**范围**
1. **自动简报**(机制见 §1.5.2):建跑在 **Routines 进程**的 schedule routine(如 `30 8 * * 1-5`),正文经 A2A `invokeAgent("chief-of-staff", "编译并润色今天的晨间简报", { selfAppId:"routines" })`;CoS 的 agent 在自己 loop 里调 `compile-briefing`+`update-briefing` 完成;晚间 recap 同理(`kind:evening`)。这是统一 A2A 胶水,**非「无胶水」**。
2. **分享 SSR**:`briefings/:id` 当 `visibility:public` 时 SSR 真内容(SEO/OG);登录页保持 CSR。
3. **收尾**:错误/超时/部分失败 UX 打磨;设置页选 app + per-app 问法;补齐两 app 的单测 + e2e;Prettier;清 TODO。
4. 两篇 skill 补全收尾(`chief-of-staff` 初版见 B3、`routines` 初版见 A1),教 agent 完整用法。

**验收要求**
- [ ] 一条 `30 8 * * 1-5` routine 到点(测试触发)产出当日 morning 简报,且 `update-briefing` 写了非空 `summaryMd`;`routine_runs` 落成功行。
- [ ] 晚间 recap 同样可跑。
- [ ] 公开简报页 SSR 出真内容(查 HTML 源含简报正文)。
- [ ] e2e(Chief-of-Staff):一键编译 → 面板渲染四源 → 点深链跳转。
- [ ] e2e(Routines):建定时 routine → 触发 → 历史成功行(已在 A3,此处回归)。
- [ ] **两 app 的"生产可用门(§1)各 5 条全部满足**。
- [ ] 四区齐全(两 app 各自 UI/action/skill/app-state 完整)。

---

## 3. 风险与边界(执行时已知,不重新发明对策)

| 风险 | 边界/对策(已定) |
|---|---|
| serverless 调度不可靠 | **明确排除**。仅长驻自托管;hosted 不在范围。 |
| event-bus 进程内、不重放 | 关键自动化用 schedule 兜底;不引入持久事件队列(范围外)。 |
| 改 core 两处 | 仅 `routine_runs` 写入钩子,additive,单独 commit + 单测;不碰其它引擎逻辑。 |
| 跑 6 个 dev server 成本 | 固有代价,已接受;workspace manifest 一次配好。 |
| 数据源未连集成 | Phase 0 验收强制四源真连;未连则 B 轨不准进 B2。 |
| token 膨胀 | `buildAppPrompt` 强约束"只回要点+深链" + `responseText` 截断。 |
| deterministic 声明歧义 | A3 开工前先把单步声明 schema 敲死写进 skill,执行 agent 不准猜。 |

---

## 4. 仍需你确认的剩余歧义

**当前无阻塞性歧义、无待定项、无推迟项。** 全部结构/范围/写入/运行模型/跨进程事件桥/deterministic 声明 schema 均已在 §0 + §1.5 定死。所有功能 —— 定时型、跨 app 事件型(经事件桥)、deterministic(定时 + 事件)、fan-out 简报、自动简报 —— 都在 Phase 范围内完整实现。

执行入口建议:先做 **Phase 0**(尤其把四个数据源 app 连好),再并行起 **A1 + B1**。
