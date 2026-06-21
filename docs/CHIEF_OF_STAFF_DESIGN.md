# Chief-of-Staff 跨 App 日常指挥台 — 设计文档

状态:设计稿 · 目标读者:实现该 app 的工程/agent · 全部 API 锚点均带 `文件:行`,可验证。

> **审查修订 —— 以 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) §1.5 为准,覆盖本文冲突项:**
> - **`invokeAgent` 必传 `selfAppId:"chief-of-staff"`**(§1.5.5):否则 self-call 防护失效、自身入 targets 会递归。§6.1 示例据此补 `selfAppId`。
> - **精修简报唯一路径**(§1.5.3):面板「立即编译」按钮 = `sendToAgentChat("编译并润色")` 走本 app agent chat,**非**前端直调 action;`compile-briefing` 只产出 sources+`deterministicDigest`,润色一律 CoS agent 调 `update-briefing`。
> - **`runFanout` 契约**(§1.5.6):身份在 `runFanout` 内部签发,缺失 app→`status:"skipped"`,`latencyMs` 用 `Date.now()` 差。
> - **生产模式**(§1.5.4):六 app 以 `AGENT_MODE=production` 跑,A2A handler 才暴露 native 工具(dev 模式换 bash)。
> - **深链抽取规则**(§1.5.12)、**analytics 准确口径**(§1.5.13,只元数据+可选指定 analysis 的 `resultData`)、**字节上限常量**(§1.5.18 `MAX_PER_SOURCE_CHARS`/`MAX_BRIEFING_BYTES`)、**时区/date**(§1.5.14,date 由 action 服务端 `new Date()` 算)。
> - **数据源 = mail/calendar/brain/analytics 四个**(§1.5.16,你选定);本文出现的 content/plan 不在本次接入范围,需要时照同模式加。

---

## 1. 背景与现状(基于代码实证)

框架有三层楼,前两层盖好,**顶楼是空的**:

| 层 | 是什么 | 现状 |
|---|---|---|
| ① 管道 | A2A 协议(client/server/discovery/invoke/JWT/async 队列) | ✅ 完整实现,非占位 |
| ② 治理 | dispatch:连接/密钥/审批/审计 + **1→1** 单跳 `ask_app` | ✅ 齐全 |
| ③ **日常编排产物** | 跨 app **1→N→合成** 的简报 / 今日待办 / 统一指挥台 | ❌ **空** |

全仓库**没有任何代码**会"同时问多个 app 再合成一份给用户看的东西"。现有的全是单 app 自总览(`dispatch/overview` 只查 dispatch、`analytics/overview` 只查 analytics)。dispatch 的 `ask_app`(`mcp-gateway.ts:298`)解析**单个** target、`callAgent` 打一次、返回单条回复 —— 没有 fan-out、没有合成。

**本 app 就是盖这层顶楼。** 它不是另起炉灶,而是在现成管道上加"并行 fan-out + 合成 + 成品面板",且这恰是 orchestrator 的核心能力的第一个落地场景。

---

## 2. 目标 / 非目标

### 目标
1. 一个动作把当前用户在 **N 个兄弟 app**(mail / calendar / brain / analytics / content / plan …)里"今天需要我注意的东西"并行拉回来,合成一份**带深链**的简报。
2. 一块"今日"面板:看最新简报、一键重新编译、agent 写完自动刷新(零手动 reload)。
3. 可被 **Routines**(见 `ROUTINES_DESIGN.md`)定时驱动:每天早/晚自动编译,无需手动点。
4. 跨用户/跨租户数据**严格隔离** —— 指挥台永远看不到别人的数据。

### 非目标
- 不做新的数据连接器 / 密钥金库 / 审批(那是 dispatch 的职责,治理层②已有)。
- 不直连第三方 API(mail/calendar 等各自的集成已在各 app 内,指挥台只跨 app 取**已加工结果**)。
- 不在 app 代码里内联 LLM 调用(所有合成走 agent loop,见 §10 硬约束)。
- 不替代各 app 的深度操作界面 —— 简报里给深链,跳回源 app 操作。

---

## 3. 架构总览

```
┌─────────────── Chief-of-Staff app ───────────────┐
│  面板 /(today)                                    │
│   useActionQuery("list-briefings") ── 渲染简报    │
│   sendToAgentChat("编译并润色") ── 一键编译        │
│   useDbSync() ── agent 写完 → 自动 refetch         │
│                                                   │
│  action: compile-briefing  (fan-out 编排器)        │
│   1. resolveA2ACallerAuth()  → 签 30m JWT 转发身份 │
│   2. discoverAgents(self)    → 解析目标 app URL    │
│   3. 并行 invokeAgent(target, NL-prompt, async)   │
│        ├─ mail agent   ──┐                         │
│        ├─ calendar agent ─┤ 各自在 runWithRequest  │
│        ├─ brain agent   ──┤ Context({user,org}) 里 │
│        └─ analytics …   ──┘ 用【全量工具】取数      │
│   4. 收集 responseText(含 fully-qualified URL)    │
│   5. 写 briefings 行 + refresh-screen             │
│                                                   │
│  table: briefings (ownableColumns + accessFilter) │
└───────────────────────────────────────────────────┘
        │ JWT(sub=user, org_domain)
        ▼  POST /_agent-native/a2a  (各兄弟 app)
   兄弟 app 的 agent loop(已认证 → 完整 action 工具面)
```

**核心机制(三条,全部代码实证):**

1. **不是 RPC 调对方某个 action,而是发自然语言 prompt 给对方 agent。** 对方 agent 在已还原的 `{userEmail, orgId}` 上下文里,用**自己的全套工具**取数、把结果文本(含深链)回来。依据:认证 A2A 进入 handler 后跑的是"与交互 chat 相同的完整工具集"(`agent-chat-plugin.ts:4553-4573`,注释 `:4495-4496` "Use the SAME agent setup as the interactive chat — identical tools")。

2. **`requiresAuth: true` 不挡认证调用。** mail/calendar 的 `list-emails`/`get-event` 标了 `requiresAuth:true`,只导致它们**不出现在匿名 agent-card 上**(`filterPublicAgentCardSkills`,`a2a/server.ts:407`);但带 JWT 的调用进入 loop 后,该 agent 仍能调用这些工具。这是本设计成立的命脉。

3. **fan-out 用 async+poll 并行,不串行 await。** 每个 `tasks/get` fetch 快速返回,长任务在**各被叫 app 的独立 function execution**(`_process-task` 路由)里跑,各自拿满 timeout(`a2a/handlers.ts:81-199`);本端只是并行轮询。配合 run-manager 40s 软分块(`run-manager.ts:58`)。

---

## 4. 关键设计决策(每条给定论 + 依据)

| # | 决策 | 依据 / 替代方案为何不取 |
|---|---|---|
| D1 | **NL-prompt fan-out**,非直接 action RPC | A2A 的语义就是"发消息给 agent";直接 RPC 会绕过对方 agent 的工具编排和访问控制。NL-prompt 让对方 agent 自行决定调哪些工具,且天然走 `accessFilter` 隔离。 |
| D2 | **并行 `Promise.allSettled` + async invokeAgent** | 串行会 N 倍延迟且更易撞软超时。allSettled 让单 app 失败不拖垮整份简报(→ `status:partial`)。 |
| D3 | **身份用 `resolveA2ACallerAuth()` 自动签 JWT** | 它从当前请求上下文取 `userEmail/orgId/orgDomain/orgSecret` 并签 30m token(`caller-auth.ts:18-56`);`signA2AToken` 把 `sub`/`org_domain` 在 extraClaims **之后**展开,调用方无法伪造身份(`client.ts:39-82`)。 |
| D4 | **合成的 prose 由 agent 写,action 只存原始 sources + 兜底拼接** | 硬约束"所有 AI 走 agent chat"。`compile-briefing` 是 agent 工具,由 Chief-of-Staff 的 agent(或 Routine 的 cron agent loop)调用;action 返回结构化 per-app 结果并写一行 raw,**调用它的 agent** 再 `update-briefing` 写润色后的 `summaryMd`。不在 action 里内联 LLM。 |
| D5 | **目标 app 列表可配置 + `discoverAgents` 解析** | 默认编译一组,用户可在设置里增减;不可达的 app 自动跳过并记入 `sources[].status`。 |
| D6 | **每次编译写一行 briefing(不覆盖)** | 保留历史,可回看"昨天的早报";`sourcesJson` 留全链路证据 + 深链可追溯。 |

---

## 5. 数据模型

复用框架 `ownableColumns()`(`sharing/schema.ts:36-46`)+ `accessFilter`/`assertAccess`(`sharing/access.ts:91,308`)。普通 Drizzle 表即可(§调研 D.3 已确认)。

```ts
// server/db/schema.ts
export const briefings = table("briefings", {
  id: text("id").primaryKey(),                  // gen: brief_<nanoid>
  briefingDate: text("briefing_date").notNull(), // YYYY-MM-DD(用户本地日)
  kind: text("kind", { enum: ["morning", "evening", "adhoc"] })
        .notNull().default("adhoc"),
  title: text("title").notNull(),
  summaryMd: text("summary_md").notNull().default(""), // agent 润色后的叙述
  sourcesJson: text("sources_json").notNull().default("[]"),
  status: text("status", { enum: ["compiling", "complete", "partial", "failed"] })
        .notNull().default("compiling"),
  focus: text("focus"),                          // 可选:本次编译的关注点
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  ...ownableColumns(),                           // owner_email, org_id, visibility
});

export const briefingShares = createSharesTable("briefing_shares"); // 可选分享
```

`sourcesJson` 元素结构(每个被叫 app 一条):
```ts
type BriefingSource = {
  app: string;            // 目标 app id
  prompt: string;         // 实际发给它的 NL 问题
  responseText: string;   // 它 agent 回的原文(可含深链 markdown)
  deepLinks: string[];    // 从 responseText 抽出的 fully-qualified URL
  status: "ok" | "error" | "skipped" | "timeout";
  error?: string;
  latencyMs: number;
};
```

索引:`(owner_email, briefing_date)` 复合索引(按 `performance` skill,列表是热路径)。

---

## 6. 核心 Actions

### 6.1 `compile-briefing`(fan-out 编排器 · 写动作)

```ts
defineAction({
  name: "compile-briefing",
  readOnly: false,            // 写动作,不进匿名 card
  requiresAuth: true,
  schema: z.object({
    kind: z.enum(["morning","evening","adhoc"]).default("adhoc"),
    apps: z.array(z.string()).optional(),  // 不传 → 用默认配置集
    focus: z.string().optional(),
    date: z.string().optional(),           // 不传 → 今天
  }),
  run: async ({ kind, apps, focus, date }) => {
    const auth = await resolveA2ACallerAuth();           // caller-auth.ts:18
    const discovered = await discoverAgents("chief-of-staff"); // agent-discovery.ts:299
    const targets = resolveTargets(apps ?? defaultApps, discovered);

    const briefingId = `brief_${nanoid()}`;
    await insertBriefing({ id: briefingId, kind, focus, date,
                           status: "compiling", /* ...ownable from ctx */ });

    // 并行 async fan-out —— 不串行
    const results = await Promise.allSettled(
      targets.map((t) => withTimeout(
        invokeAgent({                                    // a2a/invoke.ts:142
          target: t.id,
          prompt: buildAppPrompt(t.id, kind, focus),
          userEmail: auth.userEmail,
          orgDomain: auth.orgDomain,
          orgSecret: auth.orgSecret,
          async: true,                                   // client.ts:517 默认
          timeoutMs: PER_APP_TIMEOUT_MS,
        }), PER_APP_TIMEOUT_MS)
      )
    );

    const sources = results.map((r, i) => toSource(targets[i], r));
    const status = deriveStatus(sources);                // complete/partial/failed
    await updateBriefing(briefingId, {
      sourcesJson: JSON.stringify(sources),
      summaryMd: deterministicDigest(sources),           // 兜底拼接,agent 随后润色
      status,
      title: defaultTitle(kind, date),
    });
    await refreshScreen();                               // agent-chat-plugin.ts:917
    return { briefingId, url: `/briefings/${briefingId}`,
             itemCount: sources.filter(s => s.status === "ok").length, status };
  },
});
```

要点:
- `buildAppPrompt(appId, kind, focus)`:按 app 定制 NL 问题。例 mail → "列出我今天需要处理的未读/重要邮件,每条给线程深链,只列要我行动的"。未知 app 用通用问法。模板存 `shared/app-prompts.ts`,可被用户在设置里覆盖。
- `withTimeout`:单 app 硬上限(如 35s,贴着兄弟 app 软分块上沿),超时 → `status:timeout`。
- 合成 prose:`deterministicDigest` 只做"分节拼接 + 深链列表"的**无 LLM 兜底**;真正的"帮我把这三件事按优先级讲清楚"由调用方 agent 在拿到返回后调 `update-briefing`(D4)。

### 6.2 配套读/改 actions
- `list-briefings`(readOnly, `accessFilter` 范围查,按日期倒序) — 面板数据源。
- `get-briefing`(readOnly,`assertAccess(briefingId,"viewer")`)。
- `update-briefing`(写 `summaryMd`/`title`,`assertAccess(...,"editor")`) — agent 润色 + 用户编辑。
- `view-screen` / `navigate`(context-awareness 必备,§8)。

---

## 7. 前端

- `app/routes/_index.tsx` → **今日指挥台**:顶部 `useDbSync()`;`useActionQuery("list-briefings",{date:today})` 渲染最新一份;每个 `BriefingSource` 一个可折叠 section(app 名 + 状态徽标 + 原文 + 深链按钮)。"立即编译"按钮 = `sendToAgentChat("编译并润色今天的简报")`(走本 app agent chat,§1.5.3),**非**前端直调 action;乐观插入 `status:compiling` 占位卡。
- `app/routes/briefings.$id.tsx` → 单份简报详情(可回看历史 / 分享)。
- `app/routes/settings.tsx` → 选哪些 app 入简报、每个 app 的 NL 问法覆盖、早/晚编译时间(写一条 Routine,§9)。
- 组件:shadcn `Card`/`Collapsible`/`Badge`/`Button`,Tabler 图标。无自绘弹层。
- 乐观更新:编译时立即显示骨架卡,`compile-briefing` 返回或 `useDbSync` 事件到达后替换。失败回滚 + toast。
- 登录页 CSR;公开分享页(`/briefings/:id` 若 `visibility:public`)SSR 真内容(SEO/OG)。

---

## 8. application_state 接线(context-awareness)

- 路由变化时写 `navigation = { screen: "briefing", briefingId?, date }` 到 `application_state`,让 agent 知道用户在看哪份。
- `view-screen` action 返回当前简报摘要 + 可见条目,供 agent "就这份简报答问题"。
- `navigate` 命令支持 agent 把用户带到某份历史简报。
- 满足框架四区要求(UI / action / skill / app-state)。

---

## 9. 调度(与 Routines 组合)

指挥台**不自己实现定时** —— 那是 Routines 的职责。早/晚自动简报 = 一条 schedule 型 Routine:

```md
---
schedule: "30 8 * * 1-5"
enabled: true
runAs: creator
---
调用 compile-briefing,kind=morning。拿到各 app 返回后,按"今天必须我处理的"
优先级把它们合成一段简洁叙述,调 update-briefing 写回 summaryMd。
```

**注:该 routine 跑在 Routines 进程**(由 Routines app 管理),正文经 A2A `invokeAgent("chief-of-staff", …, { selfAppId:"routines" })`(§1.5.2)。CoS 的 agent 收到后在自己 loop 里 `compile-briefing` → fan-out → `update-briefing` 润色。**非「无胶水」** —— Routines 进程的 scheduler agent loop 没有跨进程的 `compile-briefing`,必须经 A2A 调 CoS。

---

## 10. 安全与硬约束

**身份与隔离(核心):**
- 跨 app 调用只携带 `resolveA2ACallerAuth()` 签的 30m JWT;接收端 `verifyA2AToken`(`server.ts:82`)只信任验签后的 `sub`/`org_domain`,**绝不信 caller 的 `metadata.userEmail`**(`handlers.ts:326-349`)。
- 接收 app 在 `runWithRequestContext({userEmail, orgId})` 内跑,其 action 经各自 `accessFilter` 取数 → **指挥台永远只拿到当前用户有权看的数据**,跨用户隔离由框架保证,不由本 app 自实现。
- 本 app 自己的 `briefings` 表用 `ownableColumns()` + `accessFilter`(list)/`assertAccess`(单条)。

**硬约束(违反即返工):**
1. 跨 app 一律 `invokeAgent`,**禁止**在 app 代码手写 `fetch` 第三方 / 兄弟 app 路由。
2. 合成的自然语言由 agent loop 产出,**禁止**在 action 内联 LLM SDK 调用。
3. schema 只增不改;`briefings` 走 `ownableColumns`。
4. 不硬编码任何密钥;JWT secret 由框架 `A2A_SECRET`/org secret 提供。
5. TypeScript only;shadcn/Tabler;公开分享页 SSR。
6. 单 app 返回过大时,`buildAppPrompt` 要求对方"只回要点 + 深链",并对 `responseText` 截断(防 token 膨胀)。

---

## 11. 阶段实施

| 阶段 | 范围 | 产出 |
|---|---|---|
| **P0** | 从 chat 模板 scaffold;建 `briefings` 表 + `list/get-briefing` + 面板骨架 + app-state 接线 | 能手建空简报、面板能列 |
| **P1** | `compile-briefing` 并行 async fan-out;接 **mail + calendar** 两个 app;`deterministicDigest` 兜底;面板渲染 + `useDbSync` 自动刷新 | 一键编译出含两 app 真实数据的简报 |
| **P2** | agent 合成(`update-briefing`);接 **brain(用 search-everything 做"该问谁"路由)+ analytics + content**;per-app NL 问法配置;深链抽取 | 多 app + 智能叙述简报 |
| **P3** | 与 Routines 组合:早/晚自动编译;晚间 recap kind;分享页 SSR | 全自动日常简报 |
| **P4** | 部分失败 UI、超时/重试体验、设置页选 app、单测 + e2e | 生产级 |

---

## 12. 严格验收标准(可测)

每条都要有自动化测试佐证,不接受"看起来能用"。

**P1**
- [ ] fan-out 真并行:mock `invokeAgent` 各 sleep 200ms,3 个 app 总墙钟 < 400ms(证明非串行)。
- [ ] 身份转发:集成测试断言被叫 app 收到的请求里 `verifyA2AToken` 还原出的 email == 发起用户。
- [ ] 部分失败:1 个 app 抛错 → briefing `status:partial`,另两个 app 数据照常入 `sources`,面板正常渲染。
- [ ] 面板自动刷新:agent 调 `refresh-screen` 后,面板在一个 poll interval 内 refetch,**无手动 reload**。

**P2/P3**
- [ ] 跨用户隔离:用户 A 编译的简报内容**绝不**含用户 B 的邮件/事件(用两套数据的访问测试)。
- [ ] brain 路由:`search-everything` 的 delegation 提示能驱动二级 fan-out(问到正确的下游 app)。
- [ ] 定时:一条 `30 8 * * 1-5` Routine 在 scheduler tick 到点时执行,产出当日 morning 简报且 `update-briefing` 写了非空 `summaryMd`。

**贯穿**
- [ ] 自调用防护:`compile-briefing` 把自己列入 targets 时被 `invokeAgent` 的 self-call 防护拦掉(`invoke.ts:102-112,228-238`),不死循环。
- [ ] token 边界:单 app 返回 50KB 文本时被截断,简报总体积有上限。
- [ ] 四区齐全:UI / action / skill(写一篇 `chief-of-staff` skill 教 agent 怎么用)/ app-state 都 touch。

---

## 13. 风险与边界

| 风险 | 说明 | 缓解 |
|---|---|---|
| serverless 调度不可靠 | scheduler 是单进程 `setInterval`,serverless 不常驻则 60s tick 不保证(`scheduler.ts` 已知边界) | 个人自托管/长驻进程下无碍;hosted 需外部 cron 兜(超出本 app 范围) |
| 发现依赖 manifest | 兄弟 app 发现靠 `devPort`/workspace manifest/`apps/*` 扫描(`agent-discovery.ts`),不是运行时注册中心 | 本地 dev 多 app 同跑即可;部署时配 `AGENT_NATIVE_WORKSPACE_APPS_JSON` |
| token 膨胀 | N 个 app 各回大段文本 | prompt 强约束"只回要点+深链" + `responseText` 截断 |
| 兄弟 app 宕机/超时 | 拖慢或缺数据 | per-app timeout + allSettled + `status` 标注,简报降级不失败 |
| 合成质量 | agent 润色可能漏要点 | 保留 `sourcesJson` 原文可展开核对;deterministicDigest 永远在 |

---

## 14. 与 orchestrator 的关系

`compile-briefing` 的"1→N→合成 + 身份转发 + 并行编排"正是 orchestrator 的最小内核。建议把 fan-out 编排逻辑(`invokeAgent` 并行 + allSettled + 身份签发 + 结果归并)抽成可复用模块,Chief-of-Staff 是它的第一个消费者,orchestrator 是第二个。两者共用同一编排原语,不重复造。
