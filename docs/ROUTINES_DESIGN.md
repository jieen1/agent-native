# Routines 个人自动化引擎 — 设计文档

状态:设计稿 · 全部 API/schema 锚点带 `文件:行`,可验证。

> **审查修订 —— 以 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) §1.5 为准,覆盖本文冲突项:**
> - **进程拓扑 + 事件桥**(§1.5.1/§1.5.23):六 app 各自独立进程、各自单进程 event-bus。跨 app 事件经 **Phase A3 的拉取式 durable 事件桥**(`event_log` + cursor poller)完整交付;同进程事件直接派发。Routines 是**所有** routine 的中枢(定时经 A2A、跨 app 事件经桥)。
> - **deterministic 完整实现**(§1.5.10,Phase A4):定时型 + 事件型都支持,`JobFrontmatter` 加 `mode`,单步声明(`web-request`\|`action`)经 `runDeterministicStep` 免 LLM 执行。
> - **frontmatter 统一**(§1.5.8):`save-routine` 一律 `buildTriggerContent` + 显式 `triggerType`,event 型 `schedule` 置空,切 kind 清另一套字段。
> - **`routine_runs` 钩子落点**(§1.5.9):写在 `runWithRequestContext` 回调内的成功路径末尾 + catch 分支;`dispatchAgentic` 接住 `createThread` 拿 `threadId`;表在 core 迁移集注册。
> - **dry-run 事件型不走 fire-test**(§1.5.11);**name 规则**(§1.5.15);`refreshEventSubscriptions` 定义在 `dispatcher.ts:190`。

---

## 1. 背景与现状(基于代码实证)

框架的自动化**引擎底座齐全**,但**没有成品 app**。盘点真实状态:

| 子系统 | 实现 | 文件锚点 |
|---|---|---|
| 定时(cron) | ✅ 内置 `setInterval(60s)` → `processRecurringJobs`,`cron-parser` 解析,经 run-manager 跑 agent loop | `scheduler.ts:184`、`agent-chat-plugin.ts:7693`、`cron.ts` |
| 事件总线 | ✅ `registerEvent/emit/subscribe`,进程内同步,schema 校验 payload | `event-bus/bus.ts:38-118`、`registry.ts:28` |
| 事件触发 | ✅ dispatcher 订阅 `jobs/*.md` 中 `triggerType:event` 的规则 | `triggers/dispatcher.ts:179-243` |
| NL 条件评估 | ✅ `claude-haiku-4-5`,yes/no,5min 缓存,防注入 | `triggers/condition-evaluator.ts:70-153` |
| 出站请求 | ✅ `web-request`,含 SSRF 防护 | `extensions/fetch-tool.ts:88-425` |
| 密钥替换 | ✅ `${keys.NAME}` 服务端替换,`app_secrets` 表 + per-key URL 白名单 | `secrets/substitution.ts:70`、`secrets/schema.ts` |

**但缺口同样实证清楚(这就是要做的):**

1. **两套割裂的工具/存储语义**:定时用 `manage-jobs`(create/list/update/delete,`tools.ts:255`),事件用 `manage-automations`(list-events/list/define/update/delete/fire-test,`triggers/actions.ts:220`)。二者**共用 `jobs/*.md` resource 存储但 frontmatter 不同**(`JobFrontmatter` vs `TriggerFrontmatter`),是两套独立心智模型。
2. **没有创建/编辑 UI**:框架级 `AutomationsSection.tsx` 只能**列出 + 开关 + 删除**,**改正文/建新的只能靠 agent chat**。HTTP `GET/PATCH /_agent-native/automations`(`triggers/routes.ts:176,194`)也只读+切 enabled。
3. **没有运行历史**:每次跑只把 `lastRun/lastStatus/lastError` **覆盖写回** frontmatter(`scheduler.ts:540`),只留最近一次。无历史明细表。最接近的可复用底座是 `progress_runs` 表(run-manager 每次 run 写一行)。
4. **`deterministic` 模式是空壳**:dispatcher 里 `console.warn(...not yet implemented...) → skip`(`dispatcher.ts:292`)。当前一切自动化都得跑完整 LLM agent loop。
5. **没有 dry-run / 立即运行**:事件型有 `fire-test`(emit 测试事件),定时型**没有**"现在跑一次"入口。
6. **没有模板库**:仓库内无预置 `jobs/*.md` 示例。
7. **mail 的 automations 是模板私有 SQL 引擎**(`automation_rules` 表 + 自有 UI),**与 core triggers 不是一回事,不可当框架能力复用**。

**结论:不是造引擎,是在现成引擎上盖一个统一、可视、可观测的成品 app**,并补三个真实空洞:统一抽象、运行历史、dry-run(+ 选做 deterministic 模式)。

---

## 2. 目标 / 非目标

### 目标
1. **一个统一的 Routine 概念**收口"定时"与"事件"两类,用户不必懂 jobs vs automations。
2. **完整 CRUD UI**:建、改正文、cron 选择、事件下拉、NL 条件、启停 —— 不必开 agent chat。
3. **运行历史**:每次执行落一行,可见状态/耗时/错误/产出线程,可重看。
4. **dry-run / 立即运行**:定时型可"现在跑一次"看效果;事件型可"用样例 payload 触发"。
5. **出站 + 密钥**:UI 化管理 ad-hoc keys 与 per-key URL 白名单,routine 里用 `${keys.X}` 调 `web-request`。
6. **模板库**:一组开箱即用的个人 routine(每日简报、PR 合并建 recap、未读邮件 triage…)。

### 非目标
- 不替换底层引擎(scheduler/dispatcher/event-bus)—— 复用,不分叉存储。
- 不解决 serverless 多实例可靠调度(单进程 `setInterval` 是已知架构边界;个人自托管/长驻进程足够,见 §13)。
- 不内联 LLM(条件评估走框架 `condition-evaluator`;agentic 执行走 agent loop)。
- 不做 mail 那种 app 私有过滤引擎 —— 本 app 是**通用**自动化层。

---

## 3. 架构总览

```
┌────────────────── Routines app ──────────────────┐
│ UI: routines 列表 / 创建编辑表单 / 运行历史抽屉    │
│   useActionQuery("list-routines")                 │
│   useActionMutation("save-routine"/"run-routine") │
│   useDbSync()                                      │
│                                                   │
│ actions(统一抽象,前端+agent 共享):              │
│   list-routines / get-routine                     │
│   save-routine (建/改, kind: schedule|event)      │
│   delete-routine / set-routine-enabled            │
│   run-routine (立即跑一次 / dry-run)               │
│   list-routine-runs (运行历史)                     │
│   list-trigger-events (事件下拉数据源)             │
│                  │ 读写                            │
│                  ▼                                │
│   存储:jobs/{name}.md resource(复用引擎!)        │
│     ├ schedule 型 → JobFrontmatter                │
│     └ event 型    → TriggerFrontmatter            │
│   历史:routine_runs 表(新增,见 §5.2)            │
└───────────────────────────────────────────────────┘
        │ 不改写引擎,只写它读的 resource
        ▼
  框架引擎(已存在):
   scheduler setInterval(60s) → processRecurringJobs → run-manager → agent loop
   event-bus emit → dispatcher handleEvent → Haiku 条件 → agent loop
   agent loop 里可调:web-request(${keys}) / 任意 action / 发消息
```

**核心设计:本 app 的 CRUD actions 操作的就是引擎读取的 `jobs/*.md` resource**(不另起存储),写完调 `refreshEventSubscriptions`(`actions.ts:127`)让事件订阅即时生效。引擎不动,产品层包一层统一 UX + 补历史/dry-run。

---

## 4. 关键设计决策

| # | 决策 | 依据 / 替代方案为何不取 |
|---|---|---|
| D1 | **统一 `Routine` 抽象,底层仍写 `jobs/*.md` resource** | 引擎(scheduler/dispatcher)只认 `jobs/*.md` + frontmatter。若另建 SQL 表存 routine 就得重写引擎。复用 = 零引擎改动,自动获得调度/事件/条件/执行全链路。 |
| D2 | **新增 CRUD `defineAction`,而非直接暴露 `manage-jobs`/`manage-automations`** | 那两个是 agent 工具(LLM 判别式 schema),不适合前端 `useActionMutation`。新 action 是 UI + agent 共享的单一真相,内部复用引擎的解析/序列化(`parseTriggerFrontmatter`/`buildTriggerContent` 等)与越权校验(`authorizeJobMutation`,`tools.ts:64`)。 |
| D3 | **运行历史落新表 `routine_runs`,在引擎执行点写行** | 这是唯一真缺的数据层。`executeJob`(`scheduler.ts:349`)与 `dispatchAgentic`(`dispatcher.ts:354`)是仅有的两个执行入口 —— 在此各加一次"start 写行 / finally 更状态"。改动 additive、集中两处。替代(从 `progress_runs` 反推)拿不到 routine 名/触发原因,语义不全。 |
| D4 | **dry-run/run-now:定时型走"立即构造同样 prompt 跑一次";事件型复用 `fire-test`** | 定时型当前无即跑入口,需新 action;事件型 emit 测试事件已存在(`triggers/routes.ts:273`),直接包装。 |
| D5 | **agentic 优先,`deterministic` 作为 P3 优化** | agentic 模式已可覆盖一切(agent 能 `web-request`/调 action)。deterministic 是"固定动作免 LLM"的成本/延迟优化,当前是空壳(`dispatcher.ts:292`),P3 再补"固定 web-request/调某 action"的确定执行路径。 |
| D6 | **密钥沿用 `app_secrets` + `${keys}`,UI 化管理** | 引擎已有完整密钥替换 + SSRF + per-key 白名单(`fetch-tool.ts`/`substitution.ts`)。本 app 只加管理 UI,不碰替换逻辑。 |

---

## 5. 数据模型

### 5.1 Routine 本体 — 不新建表,复用 `jobs/*.md`

`Routine` 是 `JobFrontmatter`(`scheduler.ts:25-35`)与 `TriggerFrontmatter`(`triggers/types.ts:9-29`)的统一视图:

```ts
type Routine = {
  name: string;                       // = resource 文件名 jobs/{name}.md
  kind: "schedule" | "event";         // = triggerType(schedule 型 triggerType 缺省)
  enabled: boolean;
  instructions: string;               // = .md 正文(NL 指令)
  // schedule 型:
  schedule?: string;                  // cron 5-field
  // event 型:
  event?: string;                     // 订阅的事件名
  condition?: string;                 // Haiku 评估的 NL 条件
  mode?: "agentic" | "deterministic";
  domain?: string;                    // 分组标签
  // 通用 / 引擎写回:
  runAs?: "creator" | "shared";
  scope?: "personal" | "shared";      // owner = email | __shared__
  lastRun?: string; lastStatus?: string; lastError?: string; nextRun?: string;
};
```

读写经引擎现成函数,**不重新发明 frontmatter 解析**:
- 解析:`parseJobFrontmatter`(`scheduler.ts:39`)/ `parseTriggerFrontmatter`(`dispatcher.ts:32`)。
- 序列化:`buildJobContent`(`scheduler.ts:110`)/ `buildTriggerContent`(`dispatcher.ts:123`)。
- 落盘:`resourcePut(owner, "jobs/{name}.md", content)`(`tools.ts:116`)。
- 列举:`resourceListAllOwners("jobs/")`。
- 越权校验:`authorizeJobMutation`(`tools.ts:64`)。

### 5.2 运行历史 — 新增 `routine_runs`(唯一新表)

```ts
// 引擎侧(packages/core),additive
export const routineRuns = table("routine_runs", {
  id: text("id").primaryKey(),               // run_<nanoid>
  routineName: text("routine_name").notNull(),
  kind: text("kind", { enum: ["schedule","event"] }).notNull(),
  trigger: text("trigger"),                  // event 型:触发它的事件名/eventId
  threadId: text("thread_id"),               // 执行所建 chat thread(引擎已建)
  status: text("status", { enum: ["running","success","error","skipped"] }).notNull(),
  error: text("error"),
  startedAt: integer("started_at",{mode:"timestamp"}).notNull(),
  finishedAt: integer("finished_at",{mode:"timestamp"}),
  ...ownableColumns(),                        // owner_email, org_id
});
```

写入点(两处,集中):
- `executeJob`(`scheduler.ts:349`):进入时 insert `running` 行(带 `threadId`,引擎本就 `createThread`),`finally` 更新终态。
- `dispatchAgentic`(`dispatcher.ts:354`):同上,`trigger` 填事件名。

索引:`(owner_email, routine_name, started_at)`。

> 注:这是 **additive schema 变更**,符合 CLAUDE.md"只增不改"。它是本设计唯一触碰 `packages/core` 的地方,且高度局部(两个执行函数各加几行)。因为用户拥有该框架仓库,改 core 是正当且必要的。

---

## 6. Actions(UI + agent 共享单一真相)

| Action | 读/写 | 作用 | 内部复用 |
|---|---|---|---|
| `list-routines` | R | 列当前用户 routine(`accessFilter` 范围)| `resourceListAllOwners("jobs/")` + 解析 |
| `get-routine` | R | 取单条(正文 + frontmatter)| `parse*Frontmatter` |
| `save-routine` | W | 建/改;`kind` 决定写哪种 frontmatter;写后 `refreshEventSubscriptions` | `build*Content` + `resourcePut` + `authorizeJobMutation` + `isValidCron`(`cron.ts`) |
| `delete-routine` | W | 删 + 退订 | `resource` DELETE + `refreshEventSubscriptions` |
| `set-routine-enabled` | W | 切 enabled | 同上 |
| `run-routine` | W | 立即跑一次(定时型构造同 prompt 经 run-manager;事件型 `fire-test`)| `executeJob` 路径 / `triggers/routes.ts:273` |
| `list-routine-runs` | R | 运行历史(`routine_runs` 范围查)| §5.2 表 |
| `list-trigger-events` | R | 可订阅事件清单(给创建表单的事件下拉)| `listEvents()`(`registry.ts:42`)|

全部 `defineAction`,前端 `useActionQuery/useActionMutation`,agent 同样可调(满足四区中的 action 区)。

**cron 校验**用 `isValidCron`(`cron.ts`),**人类可读**用 `describeCron`(`cron.ts`)在表单实时显示"每个工作日 8:30"。

---

## 7. 前端

- `app/routes/_index.tsx` → **Routines 列表**:`useActionQuery("list-routines")`。每行:名称、kind 徽标(⏰/⚡)、`describeCron` 或事件名、enabled 开关(乐观)、`lastStatus` 徽标、最近运行时间。顶部 `useDbSync()`。
- `app/routes/routines.new.tsx` / `routines.$name.tsx` → **创建/编辑表单**:
  - kind 选择(schedule / event)。
  - schedule:cron 输入 + `describeCron` 实时回显 + 常用预设(每天/每工作日/每小时)。
  - event:事件下拉(`list-trigger-events`)+ NL `condition` 文本框(下方提示"由 AI 判断是否满足")+ `mode` 切换(agentic 默认;deterministic 标"实验/P3")。
  - `instructions` 正文(NL 指令)+ 插入 `${keys.X}` 的密钥引用助手。
  - "保存" → `save-routine`;"先试一次" → `run-routine`(dry-run)。
- `app/routes/routines.$name.runs.tsx` 或抽屉 → **运行历史**:`list-routine-runs`,每行状态/耗时/错误,点开跳对应 chat thread(`threadId`)看 agent 当时干了啥。
- `app/routes/keys.tsx` → **ad-hoc keys 管理**:列/建/删 `app_secrets`,设 per-key URL 白名单(写 `/_agent-native/secrets/adhoc`,`secrets/routes.ts:513`)。值掩码显示。
- `app/routes/templates.tsx` → **模板库**:一键 fork 预置 routine 到自己名下。
- shadcn 组件;无自绘弹层;`alert/confirm` 用 shadcn dialog。登录页 CSR。

---

## 8. application_state 接线

- 路由/选中写 `navigation = { screen:"routines"|"routine-edit"|"runs", routineName? }`。
- `view-screen` 返回当前 routine 列表/正在编辑的 routine,供 agent "帮我把这条 routine 改成每周一"。
- `navigate` 让 agent 带用户去某条 routine 或其历史。

---

## 9. 出站动作与密钥(复用,不重写)

- routine 正文里指示 agent 用 `web-request`(`fetch-tool.ts:88`)调外部,URL/headers/body 写 `${keys.SLACK_WEBHOOK}` 等。
- 替换在**服务端、tool call 之后**发生,明文密钥从不进 agent 上下文(`secrets/SKILL.md:210`)。
- per-key URL 白名单(`app_secrets.url_allowlist`)由 keys 管理页设置,`web-request` 用到该 key 时按 origin 校验(`substitution.ts:243`、`agent-chat-plugin.ts:4057-4069`)。
- SSRF 防护(私网/metadata/DNS-rebinding)由 `url-safety.ts` 提供,本 app 不碰。

---

## 10. 安全与硬约束

**硬约束:**
1. 不分叉引擎存储 —— routine 一律写 `jobs/*.md` resource,经引擎解析/序列化函数,不手拼 frontmatter。
2. 写 routine 后必 `refreshEventSubscriptions`,否则 event 订阅不生效。
3. 条件评估只走框架 `condition-evaluator`(Haiku),**禁止**自己内联 LLM 判断。
4. agentic 执行走 run-manager + agent loop,**禁止**绕过 run-manager 直跑(否则丢心跳/软超时/abort)。
5. 密钥只存 `app_secrets`(加密),`${keys}` 引用;**禁止**明文密钥进 routine 正文或日志。
6. `routine_runs` 与 routine resource 均按 owner 隔离;shared routine 的改/删过 `authorizeJobMutation`(仅 creator/org admin)。
7. schema 只增不改(`routine_runs` 为唯一新增);TypeScript only;shadcn/Tabler。
8. `run-routine` 的越权:只能跑自己/有权的 routine,先 `assertAccess`/`authorizeJobMutation`。

**安全要点:**
- `web-request` 的 SSRF + per-key 白名单是出站安全边界,务必经它,不要自写 fetch。
- 事件 payload 注入:`condition-evaluator` 已用标签包裹 + 转义防注入(`:124-153`),复用即可。

---

## 11. 阶段实施

| 阶段 | 范围 | 产出 |
|---|---|---|
| **P0** | scaffold;`list-routines`/`get-routine`/`save-routine`/`delete-routine`/`set-routine-enabled`(schedule 型)+ 列表/编辑 UI + cron 校验回显 + app-state | 可视化建/改/启停定时 routine,引擎按点跑 |
| **P1** | event 型(本阶段同进程事件):`list-trigger-events`、事件下拉、NL condition;写后 `refreshEventSubscriptions` | 可视化建事件触发 routine |
| **P2** | `routine_runs` 表 + 在 `executeJob`/`dispatchAgentic` 写行;`list-routine-runs` + 历史 UI;`run-routine`(定时即跑 + 事件直接走 dispatchAgentic);keys 管理页 | 可观测 + 可试跑 + 密钥自助 |
| **P3** | **跨进程事件桥**(§1.5.23):`event_log` + emit sink + 读取/目录端点 + 事件桥 poller + `sourceApp`/`event_cursors` | 跨 app 事件触发完整可用 |
| **P4** | **deterministic 完整实现**(§1.5.10):`JobFrontmatter.mode` + `runDeterministicStep`(定时 + 事件) | 固定单步动作免 LLM |
| **P5** | 模板库(覆盖三类触发)+ 与 Chief-of-Staff 组合 + 收尾 + 单测/e2e | 生产级 |

---

## 12. 严格验收标准(可测)

**P0**
- [ ] UI 建一条 `30 8 * * *` schedule routine → 写出 `jobs/{name}.md` 且 frontmatter 字段与引擎 `parseJobFrontmatter` 解析一致。
- [ ] scheduler tick 到点(mock 时间/缩短 interval)真的进 `executeJob` 并建 thread。
- [ ] 非法 cron 被 `isValidCron` 拦在 `save-routine`,返回明确错误,不写坏文件。
- [ ] 切 enabled=false 后,引擎 tick 跳过该 routine。

**P1**
- [ ] 建 event routine(订阅同进程事件如 `agent.turn.completed`)后 `refreshEventSubscriptions` 后 emit 即命中 dispatcher `handleEvent`。(跨 app 事件经事件桥,见 §1.5.23 / Phase A3。)
- [ ] NL condition 经 `condition-evaluator` 评估:condition 不满足时 routine 不执行(用样例 payload 断言)。
- [ ] 本阶段事件下拉列本进程 `listEvents()` 注册的事件(跨 app 事件在 A3 接入 `/events/catalog` 后出现)。

**P2**
- [ ] 每次执行(定时与事件)在 `routine_runs` 落且仅落一行,终态正确(success/error),`finishedAt` 有值。
- [ ] `run-routine` 立即跑一次定时 routine,产出 thread 且历史新增一行,**不**改变 `nextRun` 的正常排期。
- [ ] 历史行能跳到对应 `threadId` 看 agent 实际操作。
- [ ] ad-hoc key 设 URL 白名单后,routine 用该 key 调白名单外 origin 被拒(复用 `substitution.ts` 校验)。
- [ ] 跨用户隔离:用户 A 看不到 B 的 routine 与 runs。

**P3/P4**
- [ ] deterministic routine"固定 POST 到 ${keys.WEBHOOK}"执行**不**触发 LLM(断言无 agent loop / 无 Haiku 调用),但仍落 `routine_runs`。
- [ ] 模板库 fork 出的 routine 归属 fork 用户,可独立改。
- [ ] 四区齐全:UI / actions / skill(写 `routines` 使用 skill)/ app-state。

---

## 13. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| serverless 调度不可靠 | scheduler 是单进程 `setInterval` | 自托管长驻进程可靠;serverless 不在目标环境 |
| 跨进程事件丢失 | 进程内 event-bus 不跨进程 | **Phase A3 事件桥**:durable `event_log` + 持久 cursor 拉取,重启续拉、不丢不重(§1.5.23) |
| 改 core 执行函数 | `routine_runs` 写入 + `mode` 读取进 `executeJob`/`dispatchAgentic`;`emit` 加 durable sink | 均 additive、局部;充分单测;不改其它引擎逻辑 |
| deterministic 声明 | 需定义"固定动作"schema | 单步 `web-request`\|`action`,Zod 校验,`runDeterministicStep` 共享执行(§1.5.10);不做多步编排 |
| 与 mail 私有引擎混淆 | mail 有自己的 `automation_rules` | 文档/UI 明确:Routines 是通用层,mail 收件箱过滤仍走 mail 自己的;两者不合并 |
| NL 条件误判 | Haiku yes/no 可能错 | UI 提供 dry-run + 历史可见判定结果;condition 留空=无条件,鼓励先 dry-run |

---

## 14. 与 Chief-of-Staff 的组合

Routines 是"何时/因何触发 + 跑什么"的通用层;Chief-of-Staff 提供 `compile-briefing` 这个"跑什么"。早/晚自动简报 = 一条**跑在 Routines 进程**的 schedule routine,正文经 A2A `invokeAgent("chief-of-staff", …, { selfAppId:"routines" })` 让 CoS 的 agent 调 `compile-briefing`+`update-briefing`(机制见 §1.5.2)。**非「无胶水」** —— scheduler 的 agent loop 只有宿主进程工具,调不到跨进程的 `compile-briefing`,必须经 A2A。
