# Orchestrator「智能体」与「资源池」页面设计评审(2026-07-17)

> 性质:**只读调研 + 设计结论 + 后续工作规划**。本文不伴随任何代码或数据改动;
> 所有引用的文件路径与行号均为本次评审逐一核实所得(repo:
> `/home/bot/project/agent-native`,分支 `r3-workitem-s4-parity`)。
> 工作包编号沿用《SDLC 实施规划(R1–R5 执行版)》的 WP 风格,新增前缀
> `WP-AG.*`(智能体)与 `WP-PL.*`(资源池),供后续排期文档引用或改编号收纳。

## §0 结论速览

| 发现 | 结论 | 核心依据 | 量级 | 优先级 |
|---|---|---|---|---|
| 智能体页(`/agents`)对非 owner 账号完全空白 | **改成应用级共享注册表**(全用户可见),不保持 per-user 归属模型;用框架原生 `visibility="public"` + `includePublic` 实现,不复制 workflowList 的"整表去 scope"偏离 | 派发器 `agent-loader.ts` 解析 agent def 时**本来就不做任何访问过滤**——执行语义早已全局,只有 UI 读面在装作私有 | WP-AG.1+AG.2 合计 1–2 天 | 缺陷级,填缝优先(不抢 Sprint 主线) |
| 资源池页(`/pool`)是废弃架构遗留 | **直接移除页面与入口**;`poolStatus`/`dispatchQueue` 两个 action **保留**(健康页容量区在消费);不重建 | 04 章 §10 已裁定"容量区(合并现 pool 页)",且 `health.tsx` 的 `CapacitySection` 已实现该合并;页面引用的 "design §8.7" 出自旧 `v3-DESIGN.md`,当前产品设计 v2.x 全文零匹配"资源池" | WP-PL.1 约 0.5 天 | 债务清理,可与 WP-AG 同周随行 |

---

## §1 智能体页(`/agents`):从"用户私有资源"改为"应用级共享注册表"

### 1.1 症状与直接原因

- 表 `orchestrator_agent_defs`(`templates/orchestrator/server/db/schema.ts:344`)
  使用 `ownableColumns()` + 分享表 `agentDefShares`,读面
  `actions/list-agent-defs.ts:33` 用框架标准
  `accessFilter(schema.agentDefs, schema.agentDefShares)`——per-user 可见。
- 种子插件 `server/plugins/agent-defs-seed.ts:119-121` 把三条内置行
  (vllm / claude-code / brain)写成
  `ownerEmail: "local@localhost"`、`orgId: null`、`visibility: "private"`。
  在 101 这样的多用户托管部署里,**没有任何真实账号是 `local@localhost`**,
  所以内置行天然对所有真实用户不可见——空白页不是数据事故,是种子身份 +
  private 可见性的必然结果。框架 `ownerScopeFilter` 对 NULL org 的兼容
  (`packages/core/src/sharing/access.ts:167-183`)确认无 bug,此判断维持。
- 101 生产库 5 条记录的完整解读:
  - `agdef_brain`(kind="brain")——被 `list-agent-defs` 的 worker 过滤正确排除,
    与本问题无关;
  - `agdef_claude-code`(builtin,owner=local@localhost)——对所有真实账号不可见;
  - `agdef_7g6u2pmtn2f4ia5l`(name="vllm",owner=413343998@qq.com)——**用户创建行
    抢占了内置名**:种子逻辑"同名已存在即跳过"(agent-defs-seed.ts:102),所以
    内置 vllm 从未在 101 落库,事实上的系统 dev 工人是一条 builtin=0 的私有行;
  - `auditor` / `reviewer`(owner=413343998@qq.com)——dogfood 多轮评审 DAG 使用的
    工人角色。
- 由此,**连主运营账号 413343998@qq.com 也只能看到 3 条**(看不到 claude-code),
  而种子工作流模板恰恰引用 `claude-code` 做 review 节点
  (`server/engine/workflow-library-seed.ts:36-37`:`DEV="vllm"`,
  `REVIEW="claude-code"`)。生产环境里**没有任何一个账号能看到自己 DAG 实际在用的
  完整工人注册表**;其他任何账号则整页空白。

### 1.2 定性判定:这是系统级 worker 注册表,per-user 归属模型是错的

三层证据,层层独立:

1. **执行语义早已全局。** 派发路径 `server/agent-loader.ts:210-217` 的
   `loadAgent(name)` 明确注释"no access filtering (name is globally unique)",
   按名字裸查——任何用户的 DAG 节点写 `agent: "vllm"`,解析到的都是同一条行,
   **不管这条行归谁、可见性是什么**。当前模型的实际效果是三重不一致:
   - *可见 ≠ 可用*:看不到 vllm 的用户照样能在 DAG 里用它(还执行了一条他看不到的
     systemPrompt);
   - *私有 ≠ 隔离*:vllm 行的 owner 改 systemPrompt/model,**所有人**的 DAG 节点
     行为跟着变——私有归属 + 全局执行,两头的坏处都占了;
   - *跨租户名字冲突*:`save-agent-def.ts:33-37` 先按名全局查再 `resolveAccess`,
     用户 A 想创建与用户 B 私有 agent 同名的定义,得到的是错误信息
     `Agent 'x' not found`(误导),若撞上 builtin 名则收到
     `Builtin agent is read-only`(顺带泄露行存在性)。
2. **产品设计从未把它当用户内容。** `docs/sdlc-product-design/04-orchestrator.md`
   §8 给智能体页的数据源定义是"真实 `.claude/agents/*.md` 解析 + spawn 统计聚合"
   ——repo 文件天然是应用级的,没有 per-user 概念;§7 引擎注册表同属系统设施层。
   agent defs 的 SQL 化(v3-DESIGN §7 "SQL-first, file fallback")是存储介质迁移,
   `ownableColumns()` 是随手套用框架惯例,不是产品决策。11 屏原型基准
   (`prototypes/screenshots/`)中也没有 agents 屏——本页无原型视觉基准约束。
3. **同域先例已经这么做了。** 工作流库(04 §4)同样是"系统级模板 + 用户可增改":
   `actions/v3-workflow.ts:82-95` 的 `workflowList` 不做 owner scope,并在注释里
   写明了理由(共享模板库对能进应用的人全体可见);种子用
   `workflow-templates-seed.ts` 的非破坏性 insert-or-tag 模式打 `meta.builtin`。
   agent defs 比它条件更好——`builtin` 是真实列而非 meta JSON,种子插件已存在,
   UI 已渲染「内置」徽标和只读横幅(`agents._index.tsx:347-354, 387-392`)。

**结论:改。5 条(以及未来新增的)worker agent 定义应对每个用户/每个 org 可见。**

### 1.3 方案比较

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 保持现状 + 给新用户逐个共享 | 用 shares 表把 5 条行 share 给每个账号 | 驳回:每新增一个账号都要补共享;跨租户名字冲突、"私有但全局可执行"的不一致原样保留;运维负担换不来任何产品价值 |
| B. workflowList 式整表去 scope | `list/get-agent-defs` 去掉 `accessFilter` | 可行且与工作流库对称,但违反"`ownableColumns()` 表必须 scoped reads"的框架红线,需要在 `docs/agent-native-alignment-audit.md` §5 新登记一条偏离;放弃了行级角色语义 |
| **C. 框架原生 public 可见(推荐)** | worker 行 `visibility="public"`;读面 `accessFilter(..., { includePublic: true })` | `accessFilter` 明文支持此用法(`packages/core/src/sharing/access.ts:88-92`:"Pass `{ includePublic: true }` for the rare list endpoint that wants cross-user public discovery (a public template gallery, for example)")——语义完全对口;**零框架改动、零偏离登记**;写面 owner/admin 角色语义原样保留 |

推荐 **方案 C**。它和方案 B 的用户可见效果相同,但走的是框架给这个场景预留的
正门,不新增审计负债;将来若真要收紧(比如按 org 隔离 agent 注册表),
visibility 字段还在,退路完整。

### 1.4 推荐设计细节

**不加任何新字段。** `builtin`(只读标记)、`kind`(worker/brain 过滤)、
`visibility`(可见性)、`ownerEmail`(归属与写权)四者已足够表达目标模型。

1. **读面**(`list-agent-defs.ts` / `get-agent-def.ts`):
   `accessFilter` 增加 `{ includePublic: true }`(list);`get-agent-def` 走
   `resolveAccess`,框架对 public 行的 read-by-id 本来就放行,无需改动。
   `kind="worker"` 默认过滤、`includeBrain` 参数语义均不变。
2. **写面:完全不变。** builtin 行只读(已有);非 builtin 行更新/删除仍走
   `resolveAccess` 的 owner/admin 判定(`save-agent-def.ts:65-69`、
   `delete-agent-def.ts:35-39`)。public 可见性只授予 viewer 读,不授予写——
   这是框架语义,天然正确。
3. **新建语义:一律共享,不提供"私有智能体"选项。**
   `save-agent-def.ts:109` 的 `visibility: "private"` 改为 `"public"`。
   理由:name 全局唯一 + 派发全局按名解析,"私有 agent"在当前引擎下是一个
   **无法兑现的承诺**(别人看不见但用得上)。若未来出现真实的私有 agent 需求,
   正确的实现是派发器按 run owner 解析定义——那是引擎层立项,不是可见性开关,
   本次明确不做。
4. **legacy 5 条数据迁移:一次幂等回填,不动归属、不动 builtin。**
   在 `agent-defs-seed.ts` 内追加(或并列新建)一段启动回填,模式照抄
   `workflow-templates-seed.ts` 的 insert-or-tag:
   `UPDATE orchestrator_agent_defs SET visibility='public'
   WHERE kind='worker' AND visibility='private'`(幂等、纯 additive、每次启动
   自愈)。要点:
   - **不把 101 的 vllm/auditor/reviewer 翻成 builtin=1**——它们是真实 dogfood
     作品,owner 还要继续维护;翻 builtin 会把它们锁死只读。归属保持
     413343998@qq.com,只是全员可见;
   - `agdef_brain`(kind="brain")不在回填范围,继续对列表不可见;
   - 未来新部署里种子行直接以 `visibility: "public"` 落库,回填对其自动 no-op。
5. **UI/CRUD 交互变化**(`agents._index.tsx`):
   - 列表行与详情头部增加**创建者标注**(内置行显示「内置」——已有;非内置行
     显示 owner,如「由 413343998@qq.com 创建」);
   - 详情面板:builtin 只读横幅已有;新增第二种只读态——**非 builtin 且当前用户
     非 owner/admin** 时同样隐藏保存/删除按钮并显示"由他人创建,只读"横幅。
     实现上让 `list-agent-defs` 每行多返回一个服务端算好的 `canEdit` 布尔
     (返回 shape 是 map 出来的,加字段无破坏);
   - 「新建智能体」按钮对所有用户保留;
   - 名字冲突错误信息修正:`save-agent-def` 对"存在同名但无写权"的分支返回
     「该名称已被占用」而不是 `not found`(顺带消除存在性泄露的措辞差异)。
6. **审计**:action-seam 自动审计已覆盖 save/delete,共享化后"谁改了全局 worker
   定义"可用 `list-audit-events` 追溯,无需新表。

### 1.5 工作包拆分

#### WP-AG.1 worker 注册表共享读面(种子 + 回填 + 读 action)

- **目标**:任何登录账号在 `/agents` 都能看到全部 `kind="worker"` 定义
  (含 builtin 与他人创建的),brain 行继续隐藏。
- **涉及文件**:`templates/orchestrator/actions/list-agent-defs.ts`(includePublic)、
  `templates/orchestrator/server/plugins/agent-defs-seed.ts`(种子行
  visibility=public + 幂等回填段)、`templates/orchestrator/actions/save-agent-def.ts`
  (新建默认 public)。
- **依赖**:无(与 R3 各 WP 正交)。
- **验收判据**:①101 上用一个**既非 5 条记录 owner、也未被共享**的真实账号登录,
  `/agents` 列表出现 ≥5 条 worker 定义(vllm/claude-code/auditor/reviewer/…),
  页面不空白;②同账号调 `list-agent-defs` action 与页面一致(页面与 API 双验,
  按验收纪律用 `pnpm action`/UI,不用 SQL);③`includeBrain:false` 默认输出仍无
  brain 行;④回填幂等:重启两次容器,行数与字段不再变化。
- **量级**:0.5–1 天。

#### WP-AG.2 CRUD 交互适配与文案修正

- **目标**:共享可见后,编辑权边界在 UI 上诚实呈现;冲突错误不再误导。
- **涉及文件**:`templates/orchestrator/app/routes/agents._index.tsx`
  (创建者标注、canEdit 只读态)、`actions/list-agent-defs.ts`(canEdit 字段)、
  `actions/save-agent-def.ts`(冲突文案)、`actions/delete-agent-def.ts`
  (访问检查先于 builtin 检查的顺序微调,消除存在性泄露)。
- **依赖**:WP-AG.1。
- **验收判据**:①非 owner 账号打开他人定义:表单只读、无保存/删除按钮、有来源
  横幅;owner 账号功能不变;②新建与他人重名时收到「名称已被占用」;
  ③builtin 行为回归(徽标、只读)不变。
- **量级**:0.5–1 天(可与 WP-AG.1 同一 PR)。

#### WP-AG.3(defer)04 §8 接真对齐:spawn 统计与详情 tabs

- **目标**:04 §8 规划的近 30 天 spawn 数/成功率/中位耗时列、详情页
  运行记录/用量 tabs。属于"智能体页接真"的完整版,与本次访问模型修复无耦合。
- **处置**:**明确推迟**,待 R4/R5 后按 04 §8 单独立项;本文只登记,不排期。

---

## §2 资源池页(`/pool`):移除

### 2.1 证据链:这是废弃架构的遗留页,且设计已裁定其归宿

1. **数据是包装出来的。** `actions/v3-pool-status.ts` 自述 best-effort:
   `capacity` 是本文件内**复制**的常量 `DEFAULT_POOL_CAPACITY = 8`(:19,与
   `server/engine/v3-reconciler.ts:102` 的同名常量人工镜像,改一处不改另一处即
   漂移);`warm_idle = capacity − busy`(:51)——用"虚拟机预热池"的语言包装
   "8 减去在跑 spawn 数",而注释承认"Actual microVM pre-warm state requires the
   msb pool API (not yet wired)"(:67)。
2. **设计出处已死。** 页面与两个 action 引用的 "design §8.7" 指
   `templates/orchestrator/docs/v3-DESIGN.md` §8.7(旧 V3 架构文档的
   Pool/Dispatch Inspection);当前产品设计 `docs/sdlc-product-design/` 全文
   **零匹配**"资源池";04 §0 的信息架构侧栏里**没有**资源池入口。
3. **归宿已在设计里写明并且已经实现了。** 04 §10 健康页:"容量区(**合并现
   pool 页**):spawn 并发上限(滑杆,写 set-concurrency)、dispatch queue 表
   (waiting_for 分组)、microVM 区仅在 ORCH_FORCE_MICROVM 启用时显示(避免
   inert 概念干扰)"。而 `app/routes/health.tsx:616-726` 的 `CapacitySection`
   **已经消费同样的 `poolStatus` + `dispatchQueue`** 渲染容量摘要与排队表,并对
   set-concurrency 未接线、数据为 DB 推导等事实做了诚实的 DataSourceNote。
   唯一的倒挂是它还反链回 `/pool`("完整 VM 管理见 资源池",:671-675)。
4. **派发队列表格无业务上下文**:pool 页只展示截断 run/node ID
   (`pool._index.tsx:221-243`),不接 tags(工作项深链),用户拿到的信息不可
   行动——即便数据为真也不构成保留理由。
5. **无隐藏依赖。** 全库检索:`poolStatus`/`dispatchQueue` 的消费方只有
   pool 页与 health 页;brain 提示词、`orchestrating-v3` 技能、
   `agent-native.json` 的 A2A dispatch/readback 清单均不引用;tracker 侧零引用。
   移除页面不影响任何 agent 工作流。

### 2.2 维度边界澄清:三个并发上限,资源池页没有独占任何一个

| 上限 | 真实来源 | 现有 UI 承接 |
|---|---|---|
| Brain 线程并发(brain_tasks 槽) | `brain-queue-status` action(读 `brain_tasks` + driver 心跳) | Brain 控制台「并发槽」卡(`brain.tsx:2004-2030`)+ 健康页「Brain 槽」卡(`health.tsx:391-450`)✔ |
| V3 spawn 派发上限(G18) | reconciler `poolCapacity=8`(`v3-reconciler.ts:102,142`);`poolStatus` 真正反映的就是这个维度 | 健康页容量区 `CapacitySection` ✔ |
| microVM 供给信号量 | `backpressure.ts` 的 `VmSemaphore`(`maxConcurrentVMs=4`,`engine/types.ts:118`),仅在 `ORCH_FORCE_MICROVM=1` + `ORCH_MSB_BRIDGE_URL` 时是常态路径(`v3-dispatcher.ts:605-615`) | 任何页面都未呈现——但 04 §10 裁定它**只应**在开关启用时显示,当前部署非常态,不显示是对的 |

即:资源池页想覆盖的是第 2、3 个维度(V3 spawn 级执行资源,与 brain 并发无关的
判断正确),但第 2 维已被健康页容量区承接,第 3 维按设计就不该常态显示。
**资源池页没有任何独占信息,重建没有对象。**

### 2.3 结论与移除范围

**结论:移除页面与全部入口;两个 action 保留。**

移除清单(精确到落点):

| 项 | 位置 |
|---|---|
| 路由文件 | `templates/orchestrator/app/routes/pool._index.tsx`(整文件删除) |
| 侧栏入口 | `app/components/layout/Sidebar.tsx:104-110`(`nav.pool` 项,含 `view:"pool"`) |
| 布局高亮 | `app/components/layout/Layout.tsx:40` 的 `pathname.startsWith("/pool")` 分支 |
| 首页链接网格 | `app/routes/_index.tsx:19` NAV_ITEMS 的 `/pool` 项 |
| i18n | `app/lib/i18n.ts:55`(en "Pool")与 `:765`(zh "资源池") |
| 健康页反链 | `health.tsx:666-676` DataSourceNote 中"完整 VM 管理见 资源池"改写为不再指向已删页面(直接删句或改述容量区即全部事实) |

保留决策:

- **`poolStatus` / `dispatchQueue`(含 `v3-pool-status.ts` / `v3-dispatch-queue.ts`
  与两个同名 shim)保留**——健康页容量区正在消费;它们同时是 agent 可读的
  队列快照工具,删除反而拆掉 04 §10 已交付面。
- `/pool` 直接 404 即可接受;若求平滑可在路由层做一次性 redirect 到
  `/health`,不强制。

### 2.4 工作包拆分

#### WP-PL.1 移除资源池页与全部入口

- **目标**:侧栏、首页、路由、i18n、健康页反链六处清干净;健康页容量区行为不变。
- **涉及文件**:见 §2.3 移除清单。
- **依赖**:无。
- **验收判据**:①侧栏与首页不再出现「资源池」;②直接访问 `/pool` 得到 404
  (或跳转 `/health`);③健康页容量区照常渲染 `poolStatus`/`dispatchQueue` 数据;
  ④`grep -rn "/pool\|资源池"` 在 `templates/orchestrator/app` 下零命中
  (docs/v3-DESIGN.md 的历史记载不清理);⑤按验收纪律用真实浏览器页面核对,
  不以 API 正常代替页面正常。
- **量级**:0.5 天。

#### WP-PL.2(defer)`poolStatus` 语义诚实化

- **目标**:action 描述与字段不再冒用"microVM 热池"概念——它报告的是 G18 spawn
  派发上限占用。具体:描述改写;`capacity` 改从 reconciler 配置单一出处读取
  (消除双份常量漂移);`warm_idle` 字段与"热机"措辞移除或更名(消费方只剩
  健康页一处,协调重命名成本极低);可选:桥接配置存在时附带
  `VmSemaphore` 真实占用。
- **处置**:低优先级,排 WP-PL.1 之后任意填缝;不阻塞任何主线。量级 0.5 天。

#### WP-PL.3(条件触发,明确 deferred)msb 池 API 接入 + 门控 microVM 区

- **目标**:04 §10 原文的"microVM 区仅在 ORCH_FORCE_MICROVM 启用时显示"——
  接入 msb 池管理 API,把真实预热状态呈现在**健康页**的门控区内。
- **触发条件**:microVM 成为 101 常态执行路径(当前不是)。在此之前**不做**,
  避免再造一个 inert 概念页。

---

## §3 优先级建议(相对 Sprint 驾驶舱 / Sprint 规划工作台主线)

1. **两项都不该抢 Sprint 驾驶舱(s6)/ Sprint 规划工作台(s2)等大功能主线的
   排期**,它们合计 2–3 天、无主线依赖,属于《R1–R5 执行版》§6"工程卫生并行轨"
   定义的填缝型工作。
2. **组内顺序:WP-AG.1 + WP-AG.2 先行。** 智能体空白页是**缺陷级**体验
   (真实账号已经撞上;且 R4 工作流族建设会把更多用户引向 `/agents`),按
   "缺陷先于新功能打磨"的项目纪律应最先填缝;两个 WP 建议同一 PR 交付,
   部署后立即用非 owner 账号做 101 页面级验收。
3. **WP-PL.1 随行同周**——半天量级、零风险、设计上早已裁定,拖着只会持续误导
   ("容量 8""热机空闲"至今在生产侧栏可点)。可以和 WP-AG 拼一个"orchestrator
   页面卫生"批次。
4. **WP-AG.3、WP-PL.2 defer 到 R4/R5 之后**;**WP-PL.3 条件触发**,microVM 未
   常态化之前不启动。
5. 发布口径:两处都属于用户可见变化(空白页修复 = fixed;移除死页 = improved),
   合入时按 changelog 纪律各记一条。

## §4 本次评审明确不建议做的事

- **不改派发器**:`loadAgent` 的全局按名解析是正确的系统注册表语义,是 UI 读面
  要向它对齐,不是反过来。
- **不做 per-user 私有 agent**:在全局名解析引擎下这是假承诺;真有需求时按
  run-owner 解析另行立项。
- **不重建资源池页**:它没有独占信息维度(§2.2)。
- **不顺手改 `v3_workflow_templates` 的 scoping**:workflowList 注释里登记的
  "六个模板 action 统一 scoping"是另一个独立后续项,与本文两项无耦合。
- 本文档暂只落 repo 本地版本(便于 git 追踪);如需同步到 content 文档库,
  走既有 101 MCP 发布通道另行执行(本次任务禁数据写入,不发布)。
