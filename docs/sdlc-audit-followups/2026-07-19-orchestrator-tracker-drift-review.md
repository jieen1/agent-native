# Orchestrator + Tracker 架构对齐复审(2026-07-19)

> 范围:对照 `CLAUDE.md`/`AGENTS.md` 架构契约与 `docs/agent-native-alignment-audit.md`(2026-07-05,下称"原审计")§5 已论证的既定例外,对 `templates/orchestrator` 与 `templates/tracker` 做一次真实代码状态复审。所有条目均为本次亲自读码核实的证据,`file:line` 均为复审时的真实位置。原审计 §5 "已拉回"表格中的部分条目,经复审证明**并未真正拉回**或**已再次出现同类问题**,下面逐条列出。

## 一、绕过 actions 直写 REST — 未发现新增违规

- 复审范围:`templates/tracker/app/**`、`templates/orchestrator/app/**` 的前端 `fetch(` 调用,以及两个应用 `server/routes/**` 下新增的 Nitro 路由。
- 结果:前端侧仅有框架自身基础设施调用(`templates/tracker/app/hooks/use-db-status.ts:15` 调 `/_agent-native/env-status`),没有发现任何绕过 action 直接读写业务数据的新增 REST 调用。`server/routes/api/*`(`db-health.get.ts`、`deploy-version.get.ts`)均为健康检查/部署版本这类框架基础设施端点,不承载业务数据。此项本次复审未发现新违规,但见下面第三节关于"跨应用客户端仍是手写 REST/JWT"的既有问题仍未消除。

## 二、ownable 表应走 accessFilter/ownerScope 却未走(呼应 SDLC-032/033)

### 2.1【新发现】F9 回写通道两个"窄 action"读 `tracker_work_items` 时未套 `ownerScope()`,与同批第三个 action 的做法不一致

- `tracker_work_items` 表在 `templates/tracker/server/db/schema.ts:35-61` 定义,`ownableColumns()` 在第 61 行展开,是标准 ownable 表。
- `templates/tracker/actions/writeback-run-meta.ts:61-72`:查询该表时只用 `eq(schema.workItems.id, args.workItemId)`,**没有** `ownerScope(schema.workItems)` 或任何 org/owner 过滤。
- `templates/tracker/actions/writeback-exec-state.ts:53-59`:同样只用 `eq(schema.workItems.id, args.workItemId)`,**没有**任何 owner/org 域过滤。
- 对照组:同一批 F9 回写 action 里的 `templates/tracker/actions/advance-stage.ts:369-377`(scope=item)与 `:430-441`(scope=sprint)**都**用了 `and(eq(...), ownerScope(schema.workItems))` / `ownerScope(schema.sprints)`。
- `templates/orchestrator/server/tracker-client.ts:30-35` 的设计注释明确写道:回写身份的 `org_id` claim 是靠"`ownerScope()` 现有的 OR 语义"放行的,即"org_id 声明本身就是这个通道的访问域边界"。但这个边界只在 `advance-stage.ts` 里被真正强制执行,`writeback-run-meta.ts`/`writeback-exec-state.ts` 两个 action 完全没有引用 `ownerScope`,也没有做任何等价的 org_id 一致性校验(`server/lib/writeback-actor.ts:50-54` 的 `assertWritebackCaller` 只校验调用者身份是不是回写哨兵,不校验目标工作项的 org)。
- 影响:只要能构造出合法签名的回写哨兵 JWT(`sub=writeback@orchestrator.internal`),`org_id` claim 填哪个组织号都不影响 `writeback-run-meta`/`writeback-exec-state` 能否写入——它们会跨组织写任意 `workItemId` 的行,而同批 `advance-stage.ts` 明确不会(会被 `ownerScope` 挡成 `Work item not found or not accessible`)。这是同一个 F9 特性内部三个 action 访问域实现不一致造成的越权面,应作为 SDLC-032/033 同类问题登记跟进。

## 三、偏离 `docs/agent-native-alignment-audit.md` §5 已论证的既定例外,但未走复核流程的改动

### 3.1【核心发现】原审计 §5 声称已合并的 tracker 跨应用 MCP 客户端,实际仍是两份独立的手写 JWT 客户端

- 原审计 §5 "已拉回"表格明确写:"两份 ~180 行手写 MCP 客户端合并为共享 `mcp-client.ts`"(对应 T‑E/T‑F,`docs/agent-native-alignment-audit.md:272`)。
- 复审结果:`templates/tracker/server/lib/orchestrator-client.ts` 与 `templates/tracker/server/lib/content-client.ts` **仍是两个独立文件**,仓库内**不存在**任何 `mcp-client.ts`(已用 Glob 核实 `templates/tracker/server/lib/*` 全量文件列表)。
- 两份文件里 `base64url`/JWT 签名/`callXxxTool` 请求发送/`parseMcpResponse` 的实现**逐行重复**:
  - `orchestrator-client.ts:35-41`(`base64url`)与 `content-client.ts:45-51` 完全相同实现。
  - `orchestrator-client.ts:44-67`(`mintOrchestratorJwt`)与 `content-client.ts:54-77`(`mintContentJwt`)是同一段 HS256 手写签名代码的复制粘贴。
  - `orchestrator-client.ts:179-193`(`parseMcpResponse`)与 `content-client.ts:173-187` 是同一份 SSE/JSON 解析代码的复制粘贴。
- 更值得注意的是:后续新增的 `templates/orchestrator/server/tracker-client.ts`(F9 回写通道,orchestrator→tracker 方向)在文档注释里**直接引用了一个不存在的文件名**——第 26 行写"NOT a hand-rolled HMAC like the tracker's own `mcp-client.ts` sibling-app clients use",第 97-98 行写"Mirrors the tracker's own `mcp-client.ts`"。这两处注释把 tracker 侧两个独立文件当成已经合并的单一 `mcp-client.ts` 在引用,与磁盘上的真实文件名不符——说明"已合并"这个认知已经写进了新代码的设计注释里,但对应的合并动作实际上从未发生,也没有人重新打开原审计的这条结论去核实。
- 结论:这不是一处孤立的文档笔误,而是"审计记录 vs 代码现状"出现了真实分叉——原审计把 T‑E 标记为已解决并写入 §5,后续开发在此基础上又长出了新代码(`tracker-client.ts`),但都没有人回头验证 §5 的"已拉回"断言是否仍然成立。建议:要么真正把 `orchestrator-client.ts`/`content-client.ts` 合并成共享 `mcp-client.ts`,要么修正 `docs/agent-native-alignment-audit.md` §5 与 `tracker-client.ts` 注释,不要让两者继续互相印证一个不存在的文件。

### 3.2【新发现】新增的 `v3-lifecycle.ts` 重新引入了原审计 O10 明确禁止的裸 SQL 字符串拼接模式

- 原审计 O10(`docs/agent-native-alignment-audit.md:110`,🔴 P0)明确指出 reconciler 用 `.replace(/'/g,"''")`/模板串拼 SQL 是注入面 + 移植锁定问题,§5 "已拉回"表格(`:270`)声称"reconciler 裸 SQL 参数化"已完成,§3.4 P0 修复项也把"裸 SQL"列为必须参数化的安全修复。
- 复审发现:`templates/orchestrator/server/lib/v3-lifecycle.ts`(标注为 "P4-A",原审计执行记录 §5 从未提及这个文件,应是审计之后新增的数据生命周期清理模块)在 `listExpiredRuns` 函数里三次把一个 id 数组直接字符串拼接进原生 SQL,完全没有走 drizzle 的参数化查询构造器(该文件顶部第 9 行已经 `import { sql, eq, and, or } from "drizzle-orm"`,`eq`/`and`/`or` 却在这三处一次都没被用上):
  - `templates/orchestrator/server/lib/v3-lifecycle.ts:105`:`` WHERE run_id = ANY('{${ids.join(",")}}'::text[]) ``
  - `templates/orchestrator/server/lib/v3-lifecycle.ts:111`:同样的 `` ANY('{${ids.join(",")}}'::text[]) `` 拼接
  - `templates/orchestrator/server/lib/v3-lifecycle.ts:120`:同样的 `` ANY('{${ids.join(",")}}'::text[]) `` 拼接
  - 另外第 34-47 行、第 66-69 行、第 89-96 行也都用 `sql.raw` 模板串拼 `ttlDays`/`archiveAfterDays`(这两个数值经过 `Number()` 转换,注入面较小,但同样是同一种"裸拼 SQL 而非参数化"的写法惯性)。
- 这些 `ids` 目前来自内部生成的 `v3_runs.id`(`newId()` 生成),不是直接的外部用户输入,实际可利用性有限;但这正是原审计点名要求"reconciler/queue 全部参数化"(§3.4)之后新写的代码,却完整复刻了同一种被判定为 🔴 P0 的写法,且没有任何评审记录或 changenote 提及这是对已有安全整改结论的重新评估——属于"既定整改结论之外,静默引入同类架构问题"。

### 3.3【复现】原审计声称已修复的硬编码内网 IP,在 `content-client.ts` 中仍以默认兜底值形式存在

- 原审计 §5 "已拉回"表格(`docs/agent-native-alignment-audit.md:273`)把 T‑J(硬编码内网 IP)列入"去硬编码 IP"已完成项。
- 复审发现:`templates/tracker/server/lib/content-client.ts:27-32` 的 `contentPublicBaseUrl()` 函数,在 `process.env.CONTENT_PUBLIC_BASE` 未设置时,**仍然**兜底返回字面量 `"http://192.168.1.101"`,并且这个内网 IP 会被拼进每一条投递到 content 应用的证据文档 URL(`contentDocumentUrl`,第 34-39 行)。这与原 O13/T‑J 条目里点名的同一个内网地址完全一致,说明"去硬编码 IP"这条整改在 tracker→content 方向并未真正完成,只是把它从"唯一值"降级成了"env 未设置时的兜底值"——对于没有配置 `CONTENT_PUBLIC_BASE` 的部署(复审未发现任何地方强制要求配置该环境变量),行为和整改前完全一样。

## 四、四位一体检查(UI / actions / 技能指令 / application state)遗漏

### 4.1【新发现】F9 回写通道(`advance-stage` 的回写身份分支、`writeback-run-meta`、`writeback-exec-state`、`server/tracker-client.ts`)完全没有写进任何一侧的 `CLAUDE.md`

- 已用 Grep 核实:`templates/tracker/CLAUDE.md` 全文对 `advance-stage`/`writeback` 零匹配;`templates/orchestrator/CLAUDE.md` 全文对 `advance-stage`/`writeback`/`tracker-client` 同样零匹配。
- `templates/tracker/CLAUDE.md` 的"Orchestrator Dispatch"一节列出了 `dispatch-to-orchestrator`、`bulk-dispatch-to-orchestrator`、`list-tracker-activities`、`enqueue-work-item`、`dequeue-work-item`、`pause-scheduler`、`resume-scheduler`、`reorder-queue`、`get-queue-health`,但完全没有提到 `advance-stage`(F9 回写驱动阶段推进的主入口)、`writeback-run-meta`、`writeback-exec-state` 这三个已经上线、被 `server/tracker-client.ts` 实际调用、且有独立守卫机制(`writeback-actor.ts`)的 action。
- 这三个 action 都不是内部私有函数——它们是通过 `defineAction` 注册的、可被 agent 工具面看到的一等 action(`writeback-run-meta.ts`/`writeback-exec-state.ts` 未设置 `agentTool:false`),按照 `CLAUDE.md` 自身"四位一体"的要求(功能要触及 UI/actions/技能指令/application state 四个方面),这个已经在生产回写路径上运行的新特性,在"技能指令"这一面完全空缺,后来者(无论是人还是 agent)读 `CLAUDE.md` 都无法知道这条回写通道的存在、语义与访问域规则。

### 4.2【新发现】`v3-lifecycle.ts`(数据保留/归档清理模块)在四个方面全部缺失,是一个未接线的孤立模块

- 已用 Grep 全仓核实:`cleanupArtifacts`/`cleanupEvents`/`listExpiredRuns`/`v3-lifecycle` 这些导出符号和文件名,除了 `templates/orchestrator/server/lib/v3-lifecycle.ts` 自身之外,在整个仓库(含所有 `actions/`、`server/plugins/`、`server/queue/`、测试文件)**没有任何一处被引用或调用**。
- 逐项对照"四位一体":
  - **Actions**:没有任何 action 包装或暴露这三个函数,agent 和前端都无法触发它们。
  - **UI**:没有任何设置页/运行详情页展示 artifact/event TTL 配置或"已归档 N 个 run"这类状态。
  - **技能指令**:`templates/orchestrator/CLAUDE.md`、`.agents/skills/orchestrating-v3/SKILL.md` 均未提及 artifact/event 生命周期清理这件事。
  - **application state**:没有写入任何 `application_state` 键。
  - **调度**:也没有被任何 `server/plugins/*` 里的周期性 sweep/定时任务调用——`V3_ARTIFACT_TTL_DAYS`/`V3_EVENT_TTL_DAYS`/`V3_ARCHIVE_AFTER_DAYS` 这三个 env 变量在代码里读取(`v3-lifecycle.ts:16/20/24`)但没有任何生产路径会真正触发这几个清理函数运行。
- 结论:这是一个声明了完整保留策略(30/7/90 天)、写了函数签名和文档注释、但从未真正接入系统任何一环的"幽灵模块"——本质上是四位一体检查单四项全部为零,而不是遗漏了某一项。
