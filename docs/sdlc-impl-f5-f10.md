# F5–F10 详细落地方案(前端 + 后端 + 原型)

> 本文档是路线图(`docs/sdlc-implementation-roadmap.md`)§1 地基 F5–F10 六项的
> 实施细化,体例与 `docs/sdlc-impl-f1-f4.md` 一致:纲(五段式)在路线图,
> 目(文件级改动、action schema 字段级、控件级交互、五字段测试用例)在这里。
> 设计权威:02 章 §3.10/§7/§8/§9,03 章 §2 评审卡/§6 规划工作台/§11,
> 04 章 §6/§7/§10/§13。
>
> **执行基线:F1–F4 已落地。** 本方案把 F1–F4 的交付物当作已有接口直接消费,
> 每处消费点显式标注「依赖 F_x 交付物」:
> ①F3 的 `transition-guard.ts`(守卫纯函数)/`transition-work-item`(唯一人工写入口)/
> `exec_state` 列(v24);②F1 的工作区就绪断言与 `DiffBaseUnresolvableError`;
> ③F2 的 spawn threadId(实际交付为 `spawn:<node.id>`——非 spawnId,不影响 F5–F10 消费方)与 OM 压缩通道;④F4 的相位工具面与
> `runVerdict` 工具、`tool.denied` spawn 事件。
>
> 三条红线贯穿全部六项,实施时不得绕过:**加性迁移**(只加不改,tracker 接
> v25 起、orchestrator 一律命名迁移)/**ownerScope 贯穿**(一切新表新查询)/
> **机制优先于提示词**(00 §P13:凡约束必有机制背书)。
>
> 迁移号/名预分配(并行实施防撞,02 §8 标识权威的自我践行):tracker 版本号
> **F5=v25、F6=v26、F8=v27**;orchestrator 命名迁移
> **f7-telemetry=`version:4`、f10-spawn-conduction=`version:5`**(接 F2 已占的
> `version:3 / name:"f2-spawn-context"`;F9 无 schema 变更)。
>
> **基线多树实核(2026-07-11,R2 亲验;2026-07-12,R3 复核 101 更新为准)**:
> ①**tracker**——**F3 已合入 tracker 主干**(101 dogfood `main` 复核:`265ec04a2` 状态迁移守卫本体 +
> 评审修复轮 `2d2fc5498`「封死全部残留 done 直写通道 + done 源态约束」均已合并,
> `server/plugins/db.ts` 顶格实测 **v24**——`exec_state`/`closed_reason`/`closed_at` 三列;
> R2 当时所据的 `9027753a5` v23 顶格 + `impl/f3-transition-guard` 未合并是彼时快照,现已推进);
> v25/v26/v27 与 v24 只需号唯一即无撞(v20 已因 `eb7d7d5a` 改号成永久空号,不复用即可)。
> ②**orchestrator——两棵分叉的树,F7/F10/F9-orch 落在「交付主干」那棵**:交付主干
> (`main`=76a4213 → F1/F2/F4 worktree → F2 的 `04d47225e`)已在
> `1ccf7a027(refactor #1:migrate V3 off its own pool onto the framework DB layer)` **退役
> `server/db/v3.ts`**(R3 复核:101 `an-orchestrator` 容器内 `/app/templates/orchestrator/server/db/`
> 仍是独立 `v3-migrations/0001_init.sql` 式旧结构、`v3_migrations` 表仅应用到 version 2,
> 未见此重构——101 当前所跑是更早的第三棵树,**不代表**交付主干;「交付主干」的唯一权威锚点是
> 本仓 `main` 分支 + F1/F2/F4 worktree 链,F5–F10 落地对齐这条线,不对齐 101 现跑版本),
> V3 迁移改由 `server/plugins/db.ts` 的
> `migrateV3 = runMigrations(V3_MIGRATIONS, { table: "v3_migrations" })` 驱动——**与 tracker 用同一个
> core `runMigrations`**:带 `name:` 的项按名单点登记于伴表 **`v3_migrations_named`**
> (`name TEXT PRIMARY KEY`,同名只应用一次;**列表内重名启动即抛错=内置并行防撞**),无名项走
> `MAX(version)` 旧门。F2 已按此登记 `f2-spawn-context`。**新迁移 = 追加 `V3_MIGRATIONS` 数组一项
> (带 `version:`+`name:`)+ drizzle 表/列定义进 `server/db/v3-schema.ts`**;`server/db/v3.ts` 与
> `v3-migrations/*.sql` 在此树**已不存在**。这正是 02 §8「命名空间登记身份 + 数字序仅合并线性化」的
> 现成实现,也印证 **F2 实施者的实核成立、101 的 `v3_migrations_named`(行 `v3-schema-init`/
> `v3-p4-additive-columns`)是该伴表早期迭代产物**。而 **R1 据以改写前言/F6 的「orchestrator 无
> 登记表、`v3.ts` 只幂等重放」是另一棵树**——本文所在的 `claude/awesome-wing` 文档分支(`5df52832c`)
> 与 dogfood/main,均**早于** `1ccf7a027`、仍留旧 `v3.ts` 与不含 name-tracking 的旧 core;R1 把
> pre-refactor 树的机制误加到落在 post-refactor mainline 的 F7/F10 上。**F0「交付主干统一」把实施收敛到
> mainline,故本文一律按交付主干(migrateV3)陈述,F7/F10 的 C 节据此可照做。** 残留弱点=同名/同号
> 异内容仍静默跳过(无内容哈希),与 tracker 对称,归 F6 §2A 对齐项。
>
> **吸收 F3 修复轮收紧语义**(下游 F6/F9 必须一致):done 源态收紧为仅「待人工评审」
> (= DB 阶段 **验收**;守卫层把 DB 的 `验收` 归一化为 `待人工评审`,DB 侧无同名
> `待人工评审` 阶段——`VALID_STAGES = 待办/分析/设计/实施/测试/验收/交付`);
> `advance-stage`/`get-activity` 的自动回写**封顶「验收」**(不得越到 `交付`/`done`——现状
> advance-stage 的 `isFinalDelivery` 到 `交付` 直写 `status=done` 的旁路即由此封死);
> `bulk-dispatch` 依「派发不推进」同法收紧(派发不再把阶段推到 `实施`)。

---

## 1. F5 任务拆分阈值(规划前置契约)

### 1A. 后端实施(tracker,dogfood 主干)

| 文件 | 改动 |
|---|---|
| `server/lib/scale-estimate.ts`(**新**) | 规模估算纯函数(可测):`estimateScale(briefText) -> {files: number, crossLifecycle: boolean, signals: string[]}`。启发式:①文件路径样式计数(反引号内 `xx/yy.ts(x)` 去重);②生命周期关键词共现(schema/迁移 + action + 页面/组件 + 调度器/插件 ≥3 类即 crossLifecycle);③`verdict = files > 6 \|\| crossLifecycle ? 'split-required' : 'ok'`。纯文本进、结构出,无 I/O。 |
| `actions/estimate-brief-scale.ts`(**新**) | schema `{workItemId: string}`;读工作项 description(ownerScope),调 `estimateScale`,把结果写 `scale_estimate` 列(JSON:`{files,crossLifecycle,verdict,signals,at}`)并返回。幂等:同文本重估结果相同。 |
| `actions/split-work-item.ts`(**新**) | schema `{workItemId, children: [{title, description, nature?}] (min 2)}`。校验:父项 execState ∈ {null,queued}(已派发不可拆,结构化错误 `already-dispatched`,复用 F3 错误语汇);每个 child 建为同 project/sprint 的新工作项(itemKey 走 F8 序列器——F8 未合并前暂沿现状计数,文档标注消费点),写 `split_parent_id`;child 间按给定顺序建 blocked-by 链(**复用既有 `add-link`**,schema `{fromItemId,toItemId,linkType}`,`linkType='blocked-by'` 与 `validateDependencyGraph`/`advance-stage` 依赖图门读取的语汇一致;不存在名为 `link-work-items` 的 action,`decompose-epic` 亦是同款直插 `schema.links` 的先例);父项写活动 `split.performed`(children ids)。**父项不自动关闭**——由人经 F3 的 transition-work-item(target=closed,未派发)收口,保持守卫唯一写入口。 |
| `actions/dispatch-to-orchestrator.ts` | 派发前置检查(在 F3 改造后的成功路径之前):读 `scale_estimate`;无估算→现场调 `estimateScale`;`verdict==='split-required'` 且未带 `overrideScale:true` → 结构化错误 `{code:'scale-exceeded', estimate, suggestion:'split-work-item'}`,**不写任何状态**。schema 加 `overrideScale: z.boolean().optional()`(人工覆盖=02 §3.10 决策序①,写活动 `scale.overridden`)。**依赖 F3 交付物**:本检查插在 F3「不推进阶段」改造后的 dispatch 里,错误路径同样零状态残留。 |
| `server/lib/scale-runtime-signal.ts`(**新**) | 运行期定性:orchestrator 回写(F9)携带的 spawn 预算耗尽事件 ≥2 次 → 置 `scale_estimate.verdict='split-required'`(覆盖 ok)+ 活动 `scale.exceeded-at-runtime`。F9 未落地前由人工评审触发同一函数(action `mark-scale-exceeded`,同文件导出)。**依赖 F2 交付物**(预算耗尽事件的可观测性)。**完备性缺口(R3 实核)**:F2 现状代码(engine-loop.ts/v3-dispatcher.ts)与 F9 本方案均**未定义**任何"预算耗尽"事件的产生点——本行运行期自动通道缺生产者,不在本批可交付;**本批实际可用路径只有人工触发的 `mark-scale-exceeded`**,自动通道留后续硬化项(需先在 F2/F7 usage-suspect 或新增专门信号点补一个"输出预算耗尽"事件)。 |

### 1B. 前端实施(S2 规划工作台,控件级)

| 控件 | 规格 |
|---|---|
| 规模徽标(Briefs 列表行) | 每行尾部:`ok`=灰色 `st-icon mut` 小圆点;`split-required`=`badge b-warn` 内容「規模 N 文件」。数据源 `scale_estimate`,无估算显示「未估算」浅字。 |
| 告警条(brief 详情/派发面板顶部) | `verdict==='split-required'` 时出现:warning 表面(`color-mix(--warning 15%)`背景、无左侧竖条),文案「预估涉及 N 个文件 / 跨生命周期协同——超过单节点阈值(>6),建议拆分」+ 两按钮:`一键拆分`(主)/`仍然派发`(ghost,hover 提示"人工覆盖将记录审计")。 |
| 拆分对话框(shadcn Dialog,560px) | 标题「拆分 <itemKey>」;子单列表编辑器:每行 title(Input,必填)+ 简述(Textarea 2 行)+ 删除 IconButton,`+ 添加子单`;底部依赖开关(Switch)「子单按顺序 blocked-by 链接」默认开;初始预填:按 `signals` 里的文件簇分组建议(每组 ≤6 文件)生成 2–3 行草稿;校验:≥2 行、title 非空;提交=`split-work-item`,成功 toast「已拆分为 N 个子单」+ 跳转父项(显示 children 链接);失败(already-dispatched)红条提示不关框。 |
| `仍然派发` | AlertDialog 二次确认(「超阈值派发失败率高——M3-D 三次预算耗尽实证。确认覆盖?」),确认后 dispatch 带 `overrideScale:true`。 |

### 1C. 数据与迁移(tracker,加性,v25)

```sql
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS scale_estimate TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS split_parent_id TEXT;
```

### 1D. 顺序与依赖

F3 已合并(dispatch 改造点+错误语汇+closed 通道)→ 本项可独立开工;
F8 合并后 `split-work-item` 的 itemKey 分配切到序列器(一行改动,文档内标注);
运行期信号完整体依赖 F9(事件运载)与 F2(事件产生),先交付静态估算+人工触发。

### 1E. 测试规格(T-F5-01 … T-F5-08)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F5-01 | estimateScale 纯函数 | 估算可预测(SDLC 簇九) | test.each:6 组固定 brief 文本(3/6/7/12 文件、跨生命周期、零路径) | files/crossLifecycle/verdict 与期望逐项相等;7 文件与跨生命周期均 split-required |
| T-F5-02 | estimate-brief-scale 幂等 | 重估不漂移 | 同一工作项连调两次,比对两次返回与列值 | 两次结果深相等,列只有一份 JSON |
| T-F5-03 | 派发拦截 | 超阈值不可静默派发 | 12 文件级 brief 的工作项直接 dispatch | 结构化错误 code='scale-exceeded';execState 仍为 null/queued,零活动残留 |
| T-F5-04 | 人工覆盖 | P12 逃生口+审计 | 同上但 overrideScale:true | 派发成功;活动流有 scale.overridden(含估算快照) |
| T-F5-05 | split-work-item 建链 | 拆分产物正确 | 拆 3 子单,开依赖开关 | 3 新工作项同 sprint、split_parent_id=父 id、blocked-by 链 2 条;父项活动 split.performed |
| T-F5-06 | 已派发不可拆 | 拆分窗口正确 | 对 execState='dispatched' 的项调 split | 结构化错误 already-dispatched;零新建 |
| T-F5-07 | v25 迁移冒烟 | 建列真实(B5 教训) | **扩展**(非新建)`server/plugins/__tests__/db-migration.test.ts` 既有 it() 块(T-F3-12 承接者):在其列存在性断言旁追加 `scale_estimate`/`split_parent_id` 两列 | information_schema 断言通过;删 v25 重跑→红 |
| T-F5-08 | S2 告警与拆分 UI(两阶段) | 交互按规格 | 阶段 A:原型 file:// 点击"一键拆分"检查预填/校验/置灰;阶段 B:真实页面 Playwright 对 12 文件项走完拆分 | A:≥2 行且 title 空时提交置灰;B:提交后列表出现子单、父项显示 children |

改动↔用例对账:scale-estimate.ts→01/02;dispatch 拦截→03/04;split→05/06;迁移→07;S2 UI→08。**零遗漏。**

---

## 2. F6 迁移对账 + 迁移冒烟 + 迁移号防撞

### 2A. 后端实施(tracker 为主)

| 文件 | 改动 |
|---|---|
| `server/lib/migration-audit.ts`(**新**) | 纯函数对账:`auditMigrations(schemaSource: string, migrationsSource: string) -> {tables: [{name, hasCreate: boolean}], missing: string[]}`——正则提取 schema.ts 的 `table("xxx")` 全集,与迁移 SQL 里 `CREATE TABLE IF NOT EXISTS xxx` 全集比对(初始 initSql 里的建表也计入)。同函数导出 `auditColumns`(新列↔ALTER ADD COLUMN 对账,输入 git diff 文本)。 |
| `actions/audit-migrations.ts`(**新**) | schema `{diff?: string}`;不带 diff=全量对账(读当前 schema/迁移源文本——从部署产物内嵌副本或仓库检出,方案:构建时把两文件文本快照进 `server/generated/migration-snapshot.ts`)。**完备性缺口(R3 实核,未定案)**:tracker `package.json` 现无任何 prebuild/codegen 步骤,此快照无先例;101 容器实测两种部署形态并存(orchestrator 侧留有完整 `.ts` 源树,但同时也有 `.output` 编译产物;101 `an-tracker` 容器内**只找到 `.output/**/*.mjs` 编译 chunk、无裸 `schema.ts`**)——故不能默认"运行时 `fs.readFile` 源码"总是可行,`migration-snapshot.ts` 构建期快照仍是更保险的默认选择,但需先确认部署管线里加一步快照生成不冲突,列为实施前置澄清项,不在本轮单方定案;带 diff=增量对账(评审卡机器预填用)。返回 `{missing, checklist: [{key,label,state:'pass'\|'fail'\|'needs-human'}]}`。 |
| `server/lib/review-checklist.ts`(**新**) | 按 nature 装配核对清单(03 §2):`assembleChecklist(nature: string[], diffMeta) -> ChecklistItem[]`。内置规则:含 schema 变更→「新表/新列↔迁移对账」(机器预填=audit-migrations)+「迁移冒烟证据在场」;多表级联写(diff 中 ≥2 表写点)→「事务包裹」;所有单必含审查三问。每项 `{key, label, source:'machine'\|'human', state, anchor}`,锚定 `set-artifact-review`(B5 交付物,artifactId+version)。 |
| `actions/get-review-checklist.ts`(**新**) | schema `{workItemId}`;组合 nature+diff 元数据→装配清单+机器预填结果;供 S5 评审卡消费。**依赖 F3 交付物**:批准动作(transition done)由前端在「全部确认」后才可用——服务端双保险:transition-work-item 的 done 分支增加可选 `checklistComplete` 校验钩(读 set-artifact-review 锚点,不全→evidence-missing need=['checklist'])。 |
| `server/plugins/db.ts` | ①**hash 防撞——须知 `runMigrations` 是 core 函数**(`@agent-native/core/db`),登记表 `tracker_migrations` 由 core 建为 `(version INTEGER PRIMARY KEY)`、**只按 `MAX(version)` 判已应用,无 hash、无内容比对**——SDLC-037「同号异内容」正因 core 的 `version > MAX` 跳过而侦测不到。故**不改 core**(避免 packages/core changeset),在 tracker 侧**包裹** core `runMigrations`:先给 `tracker_migrations` 加 `hash TEXT`(v26),包装层每次启动做一遍**独立全量校验 pass**——对已登记的每个 version 取本地迁移数组 `sha256(sql)` 与表内 hash 比对,不同→**显式抛错**(`migration-hash-conflict: v<N>`)阻断启动;历史行 hash 空=以当前数组回填(首次信任);core 应用新迁移后包装层补写其 hash。(此校验独立于 core 的 version-skip,否则同号异内容永不重跑、永不被发现。)②迁移冒烟:**扩展** F3 已交付的 `server/plugins/__tests__/db-migration.test.ts`(承接 T-F3-12,现为 SQLite best-effort + 真 Postgres 延到 101 验收),勿另建 `migration-smoke.test.ts` 双维护;断言 schema.ts 声明的每张表存在(表名集从 migration-audit 纯函数取)。 |

orchestrator 侧本 F6 无代码改动。**订正 R1**:交付主干的 orchestrator 迁移用**同一个 core `runMigrations`**(见前言基线实核),带 `name:` 的项按名单点登记于 `v3_migrations_named`、同名只应用一次、**列表内重名启动即抛错**——这正是 02 §8 的「命名空间登记身份」,防的是重复应用与并行分支撞名(F2 的 `f2-spawn-context` 即先例)。故 orchestrator **有**登记机制,非「无机制补文档约定」。残留弱点与 tracker 同构:core 的 `MAX(version)`(无名项)与按名门(有名项)都**只判身份不比内容**,同号/同名异内容仍会静默跳过(SDLC-037 的对称面)。本 F6 的 hash 包装只落 tracker(`tracker_migrations`);**orchestrator 对齐**(给 `v3_migrations`/`v3_migrations_named` 加 hash 校验、同法包装 `runMigrations`)列为后续硬化项,不在本 F6 交付。

### 2B. 前端实施(S5 收件箱·评审卡核对清单控件)

| 控件 | 规格 |
|---|---|
| 核对清单分组 | 评审卡在「审查三问」下新增「核对清单(按 nature 装配)」组:每项一行=Checkbox + label + 来源徽标(`机器`=`badge b-info`/`人工`=灰)+ 状态(`st-icon ok/err/mut`)。机器项预填:pass=勾选且锁定(disabled,title「机器对账通过」),fail=红叉+展开详情(缺失表清单,mono)且**不可人工勾过**(必须返工)。 |
| 批准置灰联动 | `批准合并` disabled 条件追加:存在未勾选核对项或机器 fail 项;hover tooltip 列出未完成项 key。驳回不受限。 |
| 持久化 | 每次勾选调 set-artifact-review(anchor=artifactId+version+checklist key);重进页面状态还原;产物出新版本自动重置(B5 交付语义)。 |

### 2C. 数据与迁移(tracker,加性,v26)

```sql
ALTER TABLE tracker_migrations ADD COLUMN IF NOT EXISTS hash TEXT;
```

(核对清单持久化复用 `tracker_artifact_reviews`(B5),reviewKey 命名空间 `checklist:<key>`,零新表。)

### 2D. 顺序与依赖

F0 先行(对账的"迁移源文本"以交付主干为准);消费 B5 的 set-artifact-review(已合并)、
F3 的 done 守卫钩(已合并);与 F5/F7/F8/F10 无耦合,可并行。

### 2E. 测试规格(T-F6-01 … T-F6-09)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F6-01 | auditMigrations 纯函数 | 对账确定性 | test.each:①全对账 ②schema 多一表 ③迁移多一表(允许) ④列级 diff 对账 | missing 精确等于缺失集;③不误报 |
| T-F6-02 | 重放 B5 场景 | 防住 SDLC-061 | 构造 schema 加表、迁移不加的 diff → get-review-checklist | 机器项 state='fail' 且缺失表名=tracker_artifact_reviews 式精确名单 |
| T-F6-03 | 冒烟档:删迁移必红 | 冒烟真实有效 | 注入:临时删 v23 建表迁移块,跑 migration-smoke | 断言失败点名缺失表;恢复后全绿 |
| T-F6-04 | hash 防撞 | 防住 SDLC-037 | 注入:单进程、零源码改动——向 `tracker_migrations` 直接 `UPDATE` 已登记版本(如 v21)的 `hash` 列为任意错误值(非其 SQL 真实 `sha256`),重启同进程内的 runMigrations 包装层(core 只存 `(version)`、无 hash,故此列是 F6 包装层自建;伪造它等价于模拟"内容已与登记漂移") | 启动显式抛 migration-hash-conflict: v21,进程不静默继续;与 T-F6-05(hash 为空→静默回填)走不同分支,互不干扰 |
| T-F6-05 | hash 首次回填 | 老库无损接入 | 对已有 tracker_migrations 行(hash 为空)启动 | 全部回填 hash,零报错零重跑 |
| T-F6-06 | done 守卫钩 | 清单未全不得批准(服务端) | 钩点:`actions/transition-work-item.ts` 的 `effectiveTarget==='done'` 分支(assertTransition 通过后、`patch.status='done'` 写入前)——checklist 有未确认项时人工 transition done(证据齐) | evidence-missing need 含 'checklist';全确认后同调用成功 |
| T-F6-07 | 核对清单持久化+重置 | 状态锚定产物版本 | 勾选两项→重读;create-sprint-artifact 出新版本→重读 | 重读还原;新版本后全部回到未确认 |
| T-F6-08 | v26 迁移冒烟 | 建列真实 | **扩展**同一个 `db-migration.test.ts` it() 块(同 T-F5-07 所指):追加 `tracker_migrations.hash` 列存在性断言——不新建 `migration-smoke.test.ts` 或第二个 it() | 通过;删 v26 重跑→红 |
| T-F6-09 | S5 清单 UI(两阶段) | 交互按规格 | 阶段 A 原型:机器 fail 项不可勾、批准置灰;阶段 B 真实页面:勾完全部→批准解锁 | A/B 断言均过 |

改动↔用例对账:migration-audit→01/02;冒烟→03;hash→04/05/08;守卫钩→06;set-artifact-review 复用→07;UI→09。**零遗漏。**

### 2F. 落地披露(实施后据实回填,R3 独立评审整改)

以下三点在实施/评审中确定,与 §2A–2E 的规划口径有出入,据实记录:

1. **hash 防撞落在独立表,非 `tracker_migrations` 加列**(§2A/§2C 原写「加 hash
   列」)。实测:core `runMigrations` 的登记 INSERT 无显式列名、按位置传参,
   `tracker_migrations` 一旦加第二列,SQLite 硬崩(→`process.exit(1)`)、
   Postgres 不崩但静默把 hash 记为 NULL(守卫在生产 dialect 上失明)——两者
   都令加列方案不可用,且修它需改 core(违「不改 core」红线)。改为新增独立表
   `tracker_migration_hashes(version PK, hash)`,v26 唯一新迁移,零 core 改动。

2. **核对清单门在完整 S5 评审卡真实页面落地前,靠「惰性锚 + 守卫只读判定」
   运作**。T-F6-09 阶段 B(真实 S5 React 页面)**未建**——收件箱/评审卡整条
   前端页在 tracker `app/` 中尚不存在(与 B5/F3 前端同状,从未接真实页面),
   非本 F6 引入的回归,需单独立项。当前门的牙来自:①`get-review-checklist`
   渲染时**惰性建锚**(sprint 内项直插一行 `tracker_sprint_artifacts`
   `docKey=review:<workItemId>`,并给人工项建 checked=0 占位行);②done 守卫走
   **纯只读** `isChecklistComplete`,只读评审时持久化的机器判定+人工确认。
   **SDLC-061 的前端呈现部分待 S5 页面单独立项**;后端门本身已由 T-F6-02/06/07
   真冒烟覆盖并生效。

3. **sprint 外项(无 sprintId 的 quick-task/hotfix/from-audit)用合成锚点**
   `wi-review:<workItemId>`(`tracker_sprint_artifacts.sprint_id` 为 NOT NULL,
   无法为其建 sprint 产物行;`artifact_reviews.artifactId` 是自由字符串)。代价:
   恒 version 1、无「出新版本自动重置」(sprint 外项本不产生版本化 sprint 产物,
   重做后重新评审由人工触发)。这是有意限制,换取门对所有交付项(含 sprint 外)
   同样有牙,而非只对 sprint 内项。

---

## 3. F7 遥测与身份单一事实源

### 3A. 后端实施(orchestrator)

| 文件 | 改动 |
|---|---|
| `server/db/v3-schema.ts`(drizzle 表/列定义)+ `server/plugins/db.ts`(`V3_MIGRATIONS` 数组,见前言基线实核) | 追加命名迁移项 **`{ version: 4, name: "f7-telemetry" }`**(接 F2 的 `version:3/f2-spawn-context`):①新表 `v3_model_registry`(id, real_name, alias UNIQUE, tier, endpoint, is_claude_weight INTEGER, created_at + ownable 三列);②`v3_spawns` 加列 `model_real_name TEXT`、`usage_suspect INTEGER DEFAULT 0`;③`brain_threads` 加列 `closing_anomaly TEXT`。列用 `ADD COLUMN IF NOT EXISTS`、新表 `CREATE TABLE IF NOT EXISTS`;drizzle 侧同步加表/列定义供类型与冒烟对账。 |
| `actions/registry-upsert-model.ts`(**新**) | schema `{realName, alias, tier?, endpoint?, isClaudeWeight: boolean}`。**假名拒绝**:`alias.startsWith('claude-') && !isClaudeWeight` → 结构化错误 `alias-forbidden`(04 §7);同 alias 改指向=更新+写 `v3_events kind='registry.alias-changed'`(别名漂移可见)。配套 `actions/registry-list-models.ts`(S9 消费)。 |
| `server/runtime/executors/engine-loop.ts` + `server/runtime/executors/types.ts` + `server/engine/v3-dispatcher.ts` | **现状实核(R2 三文件追踪,SDLC-051 真根订正)**:engine-loop 已 `const usage = await runAgentLoop(...)` 取**返回值级 usage**(非 chunk 累加)并内部分别累加 `usage.inputTokens`,**但**在返回处塌缩为单标量 `tokensSpent = input+output+cacheRead+cacheWrite`——`RuntimeExecResult`(`types.ts`)**只有 `tokensSpent`、无 input/output 拆分**,故 `v3-dispatcher.ts` 落库处**硬编 `tokensInput:0, tokensOutput: tokensSpent`**,`v3_spawns.tokens_input` 恒 0(真根=拆分在 `RuntimeExecResult` 边界丢失,非仅「未填」)。用量采集契约(**须改三处,缺一恒 0**):①`RuntimeExecResult` 增 `tokensInput`/`tokensOutput` 两字段(engine-loop 不再只并入 tokensSpent);②`v3-dispatcher.ts` 落库改写真实 `tokensInput = usage.inputTokens`(**必填**,undefined 记 0 并置 suspect)、`tokensOutput = usage.outputTokens`,删 `tokensInput:0` 硬编;③suspect 判定 `inputTokens===0 \|\| outputTokens > elapsedSec*MAX_TPS`(env `ORCH_MAX_TPS` 默认 60)→ `usage_suspect=1`,`model_real_name`=registry 反查(查不到=原名+suspect)。「只取流终 usage、禁按 chunk 累加」作守恒注释固化(点名 SDLC-051)。**依赖 F2 交付物**:F2 实际用 `runAgentLoop`(本地续传封装,非 `runAgentLoopDirectWithSoftTimeout`——该 core 导出模板不可达),usage 形状不变;F2 已把 `maxOutputTokens` 收敛为 `devMaxOutputTokens()`(默认 32_000,env `ORCH_DEV_MAX_OUTPUT_TOKENS`),dogfood/main 仍留 `200_000` 属 F0 收敛项。 |
| `server/brain/brain-session.ts` | ①turn 终态判定契约(04 §6):收尾整理时若本 turn 已落最终 assistant 交付文本,后续 `result: error_during_execution` **不覆盖**线程为 error——终态 done + `closing_anomaly` 记原始 error 文本(SDLC-060);error 仅在无交付摘要时成立。②降级显式化:`ORCH_BRAIN_HARNESS=1` 且 ACP 初始化失败 → `console.error` + `v3_events kind='capability.degraded'`(payload 含缺件),**每次唤醒都写**(不去重,静默期可见);健康 action 暴露。 |
| `actions/health-telemetry.ts`(**新**) | S10 遥测可信卡数据源:`{suspectSpawns, aliasDriftEvents, degradedEvents, conductionFixes, configInconsistencyEvents}`(conductionFixes 待 F10、configInconsistencyEvents 待事件源,均先返回 0 并标 pending)。任一非零=黄。**补 04 §10 配置生效一致性**:设计要求「声明的配置值≠实际生效值(maxOutputTokens 被钳制/env 覆盖被忽略)必须产生告警事件并计入本卡」——现状 F0/F2 的钳制只 `console.warn`(changeset `output-tokens-clamp-warn`)**未落持久事件**;故 `configInconsistencyEvents` 的事件源(钳制点持久化一条 `v3_events kind='config.clamped'`)是**跨 F 依赖**(归 F0/F2 钳制点补一行),本 action 先读该 kind 计数、无源时 0+pending。 |

### 3B. 前端实施(S9 + S10)

| 控件 | 规格 |
|---|---|
| S9·模型注册表区(右栏新组) | 表格三列:真名(mono)/别名(badge 列表)/档位;is_claude_weight=false 且别名含 claude-* 的行**不可能存在**(注册即拒),表尾「+ 登记模型」(小对话框:realName/alias/tier/isClaudeWeight Switch;alias 违规提交→红条 alias-forbidden 不关框)。别名漂移事件:区块顶部黄条「N 条别名变更(7 天)」点开时间线。 |
| S9·降级告警 | `capability.degraded` 事件存在时:页顶 CapabilityBanner(error 表面)「Harness 声明开启但初始化失败——正以 raw-spawn 兜底运行」+ 受影响线程行 degraded 徽标。 |
| S10·遥测可信卡 | 健康页新卡:五行计数(suspect spawn/别名漂移/降级/传导修正/**配置未生效**——04 §10),全零=绿 st-icon,任一非零=黄 + 行级「查看」深链;卡底注「suspect 数据不入度量聚合」。(原型现为 3 行呈现四指标、缺配置行与全零绿态——见 §8 末原型差异表,留实施补。) |

### 3C. 数据与迁移

见 3A 首行(命名迁移项 `{ version:4, name:"f7-telemetry" }`,一次包含三件套;登记于 `server/plugins/db.ts` 的 `V3_MIGRATIONS`,drizzle 定义进 `server/db/v3-schema.ts`)。

### 3D. 顺序与依赖

F0 先行;用量采集改动落在 **F2 同文件集**(`engine-loop.ts` + `v3-dispatcher.ts` + `types.ts`,F2 已改前两者)——本项在 F2 合并后实施
(唯一同文件顺序约束,§7 全局顺序图);registry/brain-session/health 与其他项并行安全。

### 3E. 测试规格(T-F7-01 … T-F7-10)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F7-01 | 假名拒绝 | 防 SDLC-054 再发 | registry-upsert alias='claude-x' isClaudeWeight=false | 结构化错误 alias-forbidden,零写入 |
| T-F7-02 | 别名漂移事件 | 漂移可见 | 同 alias 两次 upsert 指向不同 realName | 第二次成功且 v3_events 出现 registry.alias-changed |
| T-F7-03 | usage 采集:input 必填 | 修 tok_in 恒 0 | **挂点(R3 实核,已有硬件):`v3-dispatcher.spec.ts` 既有 `createMockDb()`(返回 `{db, artifacts, spawns}`,`spawns` 数组已在但现测试未用)+ 注入 fake `RuntimeExecutor`(`{kind:'test', run: vi.fn().mockResolvedValue({tokensInput:1234, tokensOutput:…})}`)经 `new V3Dispatcher(mockDb.db, executor)` 跑一次 spawn——挂在 executor.run() 返回值这一层,不下钻 engine-loop/runAgentLoop(该层已由 T-F7-08 等单独覆盖)** | `mockDb.spawns[0].tokensInput===1234`(camelCase 字段,内存 mock 断言,非 live DB 列名);`usageSuspect` 为假/0 |
| T-F7-04 | suspect:input=0 | 坏数据不混入 | 同 T-F7-03 挂点,mock `RuntimeExecutor.run()` 返回 `tokensInput:0` | `mockDb.spawns[0].usageSuspect===1`;health-telemetry 对该字段的计数逻辑单独覆盖(读同一张表) |
| T-F7-05 | suspect:超物理速率 | 防 10M/90s 类膨胀 | 同 T-F7-03 挂点,mock `RuntimeExecutor.run()` 返回 `tokensOutput:1e6`;`latencyMs`(dispatcher 现有入参,由真实 `startedAt`/`completedAt` 算出,可直接冻结)控制为约 10_000ms,无需假计时器 | `mockDb.spawns[0].usageSuspect===1` |
| T-F7-06 | 真名反查 | 归因到权重 | registry 登记 qwen3.6→ThinkingCap;spawn model_ref='qwen3.6' | model_real_name='ThinkingCap-Qwen3.6-27B';未登记名→原名+suspect |
| T-F7-07 | turn 终态契约 | 防 B5 error 误标(SDLC-060) | 单测 brain-session 收尾:先落交付摘要,再注入 error_during_execution result | 线程 status='done',closing_anomaly 含原始 error;无摘要时同注入→error |
| T-F7-08 | 降级显式化 | 防 SDLC-049 静默 | 注入:置 ORCH_BRAIN_HARNESS=1 且 mock ACP import 抛错,触发一次唤醒 | console.error + capability.degraded 事件落库;health-telemetry 计数+1 |
| T-F7-09 | f7-telemetry 迁移冒烟 | 建表建列真实 | 空库跑 v3 命名迁移,断言 registry 表+三新列存在 | 通过;移除该命名迁移→红 |
| T-F7-10 | S9/S10 UI(两阶段) | 呈现按规格 | 阶段 A 原型:注册表区/降级横幅/可信卡渲染与置灰;阶段 B 真实页面待部署后 | A 断言过;B 留验收 |

改动↔用例对账:registry→01/02/06;engine-loop 采集→03/04/05;brain-session→07/08;迁移→09;UI→10。**零遗漏。**

---

## 4. F8 回链完整性 + itemKey 分配权威

### 4A. 后端实施(tracker)

| 文件 | 改动 |
|---|---|
| `server/db/schema.ts` + `server/plugins/db.ts` | v27 加性迁移:①新表 `tracker_work_item_runs`(id, work_item_id, run_id, thread_id, branch, dispatched_at, superseded INTEGER DEFAULT 0, created_at + ownable 三列;UNIQUE(work_item_id, run_id));②新表 `tracker_project_seq`(project_id PRIMARY KEY, next_seq INTEGER NOT NULL);③回填 SQL:`INSERT INTO tracker_project_seq SELECT project_id, COALESCE(MAX(CAST(SUBSTR(item_key, LENGTH(key)+2) AS INTEGER)),0)+1 FROM ...`(以现存最大号+1 起步,方言差异在迁移内写 Postgres 版本、SQLite 测试档降级为应用层初始化)。 |
| `actions/create-work-item.ts` | itemKey 分配改**序列器单点**:Postgres `UPDATE tracker_project_seq SET next_seq=next_seq+1 WHERE project_id=$1 RETURNING next_seq`(原子);行不存在→先 INSERT(on conflict do nothing)再 UPDATE。删除现状「count 现有条数」逻辑(SDLC-038 重号根因)。**历史重号现已追溯性修复**:SDLC-038 的一次性、幂等 boot-time dedup 迁移已上线(见 `server/lib/dedupe-item-keys.ts`)——后续独立审计发现的实际重号集合是 **8 个 key / 16 行**(SDLC-027/032/033/034/035/036/056/057,不仅仅是最初记录的 032~036),重号现通过同一个原子序列器(`allocateItemKey`)重新分配新号、不再原样保留;`itemKeyDisplay`(4B)仅作为纵深防御的安全网保留,用于兜住未来可能漏过的新重号。 |
| `actions/dispatch-to-orchestrator.ts` | 成功路径 INSERT `tracker_work_item_runs`(run_id 可先空、thread_id 即时,run 起后由 F9 回写补 run_id/branch);重派=新行,旧行 `superseded=1`(**追加式历史**,禁 UPDATE 单槽——SDLC-053)。`orchestrator_run_id` 旧列保留(兼容读),写路径同步维护但语义降为"最新一条"。 |
| `actions/get-work-item.ts` | 返回体加 `runs: [{runId, threadId, branch, dispatchedAt, superseded}]`(按 dispatched_at 倒序);S4 执行组消费。 |
| itemKey 消歧(读路径) | `list-work-items`/`get-work-item` 对同 project 重号 itemKey 追加显示后缀:返回体 `itemKeyDisplay = item_key + (重号 ? '·' + id.slice(0,4) : '')`——纯读侧计算,零写。**完备性缺口(R3 实核)**:除这两个 action,`itemKey`/`item_key` 至少在 `advance-stage.ts`/`bulk-dispatch-to-orchestrator.ts`/`decompose-epic.ts`/`list-epic-children.ts`/`validate-dependency-graph.ts`/`run-acceptance.ts`/`enqueue-work-item.ts` 等后端文件与看板/队列/Sprint 详情/工作项详情等前端页出现——多数只是透传已取的工作项对象(消歧因此自动生效),但看板/队列页若有独立 list 取数路径,需逐一核实是否绕开本消歧,不能只当"两个 action 就够"。 |

### 4B. 前端实施(S4 执行组接真,原型已备)

执行组「关联运行」从单值改列表:每行 run 深链(orchestrator run 页)+ superseded 行灰显 strike;「分支」行显示最新非空 branch(mono,可复制);重号项 itemKey 显示 `itemKeyDisplay`(tooltip「历史重号,已消歧显示」)。无新弹窗。

### 4C. 数据与迁移(tracker,加性,v27)

见 4A 首行(两新表+序列回填)。

### 4D. 顺序与依赖

F0 先行;branch 回填的运载依赖 **F9 交付物**(回写通道)——本项先交付表结构+
dispatch 写入+读路径,branch 列在 F9 合并前允许为空(T-F8 用例分两档);
F5 的 split-work-item 在本项合并后切换 itemKey 分配(见 1D)。

### 4E. 测试规格(T-F8-01 … T-F8-08)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F8-01 | 序列器原子性 | 20 并发零重号(路线图验收③) | 同 project 并发 Promise.all(20×create-work-item) | 20 个 itemKey 唯一且连续;重跑 3 轮均零重号 |
| T-F8-02 | 序列器接管存量 | 老项目无缝 | 对已有 38 单的 project(号至 N)建新单 | 新 itemKey=N+1,不回头复用 |
| T-F8-03 | 追加式 run 历史 | 防 SDLC-053 单槽覆盖 | 派发→取消→重派(模拟 B2) | work_item_runs 两行,旧行 superseded=1,新行在;get-work-item.runs 长度 2 |
| T-F8-04 | UNIQUE(work_item,run) | 幂等回写不重复 | 同 run 回写两次 | 第二次 no-op,仍一行 |
| T-F8-05 | 重号消歧读路径 | 历史双号可区分 | 对实测重号对(两条 SDLC-033)调 list/get | 两条 itemKeyDisplay 不同且稳定;无重号项不带后缀 |
| T-F8-06 | v27 迁移冒烟+回填 | 建表与序列起点真实 | 空库→全量迁移→断言两表;带存量库→断言 next_seq=max+1 | 均通过;删 v27→红 |
| T-F8-07 | 旧列兼容 | 存量读不破 | 老调用方读 orchestrator_run_id | 值=最新 run,与 runs[0] 一致 |
| T-F8-08 | S4 执行组接真(两阶段) | 场景①③深链地基 | 阶段 A 原型已备(核对数据形状);阶段 B 真实页面:重派项显示两行、灰显正确、深链可点 | B:跳转 orchestrator run 页成功 |

改动↔用例对账:序列器→01/02;runs 表→03/04;消歧→05;迁移→06;兼容→07;UI→08。**零遗漏。**

**测试环境(F8,承接 F1–F4 §6 口径)**:**T-F8-01 的「20 并发零重号」必须跑真 Postgres**——
序列器用 `UPDATE tracker_project_seq SET next_seq=next_seq+1 … RETURNING next_seq` 的行级原子性,
内存 libsql/SQLite 写串行化会让 20 个「并发」退化为顺序、恒过而**测不到竞态**(假绿);具体机制**复用
F1–F4 轮已验证的一次性容器手法**(非抽象要求)——`docker run -d postgres:16`(一次性容器,cid/port
本机缓存)+ 一个 tsx 脚本设置 `DATABASE_URL` 后直接 `import` 真实 `server/plugins/db.ts` 插件跑迁移
建表,随后对同一库直接发 `Promise.all(20×create-work-item)` 制造真连接级并发,`psql` 断言
itemKey 唯一性(不新引入 testcontainers/docker-compose,仓内无此依赖)。T-F8-06 的迁移冒烟同 §F6:
SQLite best-effort + 同一套一次性 Postgres 容器机制断言 `information_schema`(本地 SQLite 档用
`sqlite_master`/PRAGMA)。

---

## 5. F9 确定性回写通道(M4-D)

### 5A. 后端实施(orchestrator 为主 + tracker 一处)

| 文件 | 改动 |
|---|---|
| `server/tracker-client.ts`(**新,orchestrator**) | 确定性回写客户端:以服务身份(A2A JWT,run tags 携带的 ownerEmail/org)调 tracker actions。导出 `onRunTerminal(run, nodes, spawns)`:①成功终态(done 且交付分支存在)→ 依次调 tracker `update-work-item-runs-backfill`(补 run_id/branch,消费 F8 表)、`advance-stage`(scope=item,fromStage=当前,expectedRunId 断言——已实核 advance-stage 有 `expectedRunId` 幂等参数比对 `orchestratorRunId`;推进「实施→测试」「测试→待人工评审」两次调用。**词汇**:守卫态「待人工评审」= DB 阶段 **验收**,advance-stage 操作的是 DB 的 `验收`,本行两次调用最高只到 `验收`,自身不触 `交付`/`done`),证据载荷 runId+branch+diff 统计+测试证据引用;②失败终态(zero-delivery:无 workflow 产物 commit)→ tracker `writeback-exec-state`(execState→'queued')+活动 `dispatch.failed`(T-F3-06 async 半边在此闭合)。**回写只写授权给回写通道的行:execState、runs 回填、实施→测试、→验收(待人工评审);绝不写 done/closed/交付/回退**。**一致性机制**(非「同一守卫」——`advance-stage` 不调用 transition-guard,它另有自己的门判定):(a)done/closed/交付/回退由 F3 的 `transition-work-item`(唯一人工写入口,内部走 transition-guard)独占;(b)`advance-stage` 由 **F3 修复轮「回写封顶验收」** 保证不越到 `交付`/`done`(**R3 复核 101 dogfood main `2d2fc5498`:advance-stage.ts 已加 `GUARDED_FINAL_STAGE="交付"` 门,`isFinalDelivery→status='done'` 旁路已移除、推进入交付一律 `{noop:true, reason:'delivery-guarded'}`——本白名单在机制层已成立,非设计期待;T-F3-18 覆盖该断言**)。幂等:expectedRunId 不符→no-op(02 §8)。 |
| `server/engine/v3-reconciler.ts` | run 进终态的收敛点挂 `onRunTerminal`(收敛点=已实核的 `finalizeRun(runId, 'done'\|'failed', …)`,v3-reconciler.ts 内;fire-and-forget+重试 3 次退避;失败落 `v3_events kind='writeback.failed'`,健康页可见)。**依赖 F10 交付物**:终态信号可靠(spawn→node→run 传导完备后,本挂点才不漏)。 |
| `actions/brain-task-slot.ts`(**新,orchestrator**) | 暴露 brain_tasks 槽位状态(threadId→{status,runId,updatedAt}),ownerScope;替代 tracker 裸 SQL。 |
| `actions/writeback-exec-state.ts` + `actions/writeback-run-meta.ts`(**新,tracker**) | 回写通道专用窄 action:①execState 迁移(仅 dispatched→queued/running/returned 集合内)——**注:F3 的 `transition-guard.ts` 不含 execState 转移函数**(实核其导出仅 `allowedTransitions`/`assertTransition`/`currentGuardState`/`guardStateToStageName`/`isValidCommitRef`,`execState` 仅在 guard 的 `closed` 分支被读作「未派发」判据,无 execState 白名单);故此 execState 集合白名单**由本 F9 窄 action 自身定义**,消费的 F3 交付物只是 **v24 `exec_state` 列**(不是「transition-guard 的 execState 白名单」);②runs 行回填(run_id/branch,UNIQUE 幂等——**依赖 F8 交付物**)。两者均要求调用身份带 `writeback` 标记(A2A JWT claim),人工/普通 agent 调用拒绝。 |
| `actions/get-activity.ts`(tracker) | 删裸 SQL `readBrainTaskSlot`(SDLC-034b),改调 orchestrator `brain-task-slot`(A2A HTTP,失败降级为 null,渲染不破)。 |

**成功回写的阶段起点契约(R1 观察项落定)**:回写的推进序列以**「实施」为起点**(实施→测试→验收)。工作项在被 dev 类 run 派发时应**已处于「实施」**——sprint 内经 executing 相位批量派生(02 §1 相位→阶段映射),sprint 外(quick-task/from-audit/hotfix)由 `plannedStages=实施→测试` 的初始阶段保证;回写**不负责把工作项「搬进」实施**(与「派发不推进」对称)。若终态回写时工作项不在「实施」(异常/漂移),`advance-stage` 的 `fromStage` 断言按现状 **no-op(幂等,02 §1.2)**,回写落一条 `writeback.stage-mismatch` 事件(S10 可见)而非强推,交人工在收件箱纠正。`plannedStages` 以**交付**收尾的类型(docs-task=实施→交付、spike=分析→交付)**同样封顶「验收」**——验收→交付由人经 `transition-work-item`(或 PASSED gap-analysis)完成,回写通道自身绝不触交付/done(与本节白名单一致)。

### 5B. 前端实施

无新控件(F9 的可见效果=S4 阶段自动推进+runs/branch 自动补全)。S10 健康页
「调度器」卡加一行「回写:最近成功/失败计数」(数据源 v3_events writeback.*)。

### 5C. 数据与迁移

无 schema 变更(消费 F8 的表、F3 的列;v3_events 复用既有表)。

### 5D. 顺序与依赖

**F3+F8+F10 合并后开工**(消费三者交付物;§7 全局顺序图的终点);
get-activity 改造可与主体并行(仅依赖 brain-task-slot action)。

### 5E. 测试规格(T-F9-01 … T-F9-09)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F9-01 | 成功终态回写全链 | 重放 B1 全自动(路线图 F9 验收) | 集成:mock run done(有 branch)→onRunTerminal→读 tracker | 60s 内:runs 行 branch 非空、阶段 实施→测试→待人工评审、证据载荷完整;**"无 brain 参与"取可判定断言**——本窗口内 `brain_threads` 新增行数为 0、无新增 CC/ACP 类 spawn(全链只有 onRunTerminal 一条确定性调用) |
| T-F9-02 | expectedRunId 幂等 + 阶段起点契约(fromStage 不符→no-op,R3 补覆盖) | 防错序/重放;防"阶段起点契约"沦为无测试的散文段 | ①同 run 回写两次;陈旧 runId 回写一次;②工作项终态回写时**不在「实施」**(如仍处「待办」,模拟漂移/异常)→触发 onRunTerminal | ①第二次全程 no-op;陈旧 runId 零写入;②`advance-stage` 的 `fromStage` 断言 no-op(幂等),业务阶段纹丝不动,落一条 `writeback.stage-mismatch` 事件(S10 可见)而非强推——与 5A 契约段逐字对应 |
| T-F9-03 | zero-delivery 失败路径 | T-F3-06 async 半边闭合 | mock run failed(无产物 commit) | execState='queued',活动 dispatch.failed,业务阶段纹丝不动 |
| T-F9-04 | 回写权限边界 | 守卫一致性(02 §8) | 用回写身份尝试写 done/closed/回退 | 全部拒绝(守卫 actor 判定);白名单集合内成功 |
| T-F9-05 | 非回写身份调窄 action | 通道不可冒用 | 人工 JWT 调 writeback-exec-state | 结构化拒绝;活动零残留 |
| T-F9-06 | 回写失败可见 | 不静默(P13) | 注入:tracker 端点 503,触发 onRunTerminal | 3 次退避后 v3_events writeback.failed 落库;S10 计数+1 |
| T-F9-07 | get-activity 去裸 SQL | SDLC-034b 关闭 | 代码级断言(grep 无 brain_tasks 字面量)+功能:orchestrator 停机时 get-activity | grep 零命中;降级返回 null 且页面渲染不破 |
| T-F9-08 | brain-task-slot action | 替代查询等价 | 同 threadId 新旧两路对比(迁移期) | 字段级一致 |
| T-F9-09 | 回写与人工并发 | 与 F3 CAS 协同 | 回写推进与人工回退并发发起 | 恰一成功一冲突,终态可解释,活动各留痕 |

改动↔用例对账:tracker-client→01/02/03/06;窄 action→04/05;get-activity→07/08;并发→09。**零遗漏。**

---

## 6. F10 引擎终态传导完备

### 6A. 后端实施(orchestrator)

| 文件 | 改动 |
|---|---|
| `server/engine/v3-reconciler.ts`(tick/`finalizeRun`)+ `server/queue/v3-run-reconcile-sweep.ts`(周期 sweep) | **传导不变量(02 §4 R9)落码**:新增规则——`spawn ∈ 终态(failed/cancelled/done) && node ∈ 非终态 && node.current_spawn_id=该 spawn` → 按重试策略迁移节点:未超限 → node 置 ready 重新入队(新 spawn);超限 → node failed(error 带 spawn 摘要)。**加宽而非重写**:dogfood **`f9b72161b` 的 stuck ready/pending 扫描实核在 `server/queue/v3-run-reconcile-sweep.ts`(不在 v3-reconciler.ts)**,保留;本条补 spawn→node 边(B2 卡死的精确修复,SDLC-050)。**关键落点**:该 tick 是纯事件驱动(节点完成/显式 trigger 才跑),而 B2 恰是「node running + spawn 终态、无事件再触发」——故本规则的**探测**须放在周期 sweep 侧(现 sweep 只捕 ready/pending,须加宽到「running 节点其 current_spawn 已终态」),由 sweep 经既有 `triggerTickSafe` 唤起 tick 执行迁移;只落在事件 tick 里则 B2 永不自愈。**重试计数源**见 6C。每次修正写 `v3_events kind='conduction.fixed'`(S10 可信卡计数源)。 |
| `server/queue/v3-spawn-reconcile.ts`(**实核路径**,非 `server/engine/…`;现有 spawn sweep) | ①启动扫描:boot 时全部非终态 spawn(in-process registry 必为空)→ `failed reason='orphaned-restart'`(该文件已处理「重启后 running spawn 变孤儿」,本项在其上补驱动节点迁移);②运行期判活:无句柄可查,以 `v3_events` 最后事件时间 > `ORCH_SPAWN_STALL_MS`(默认 120s,与现有 ~2m 语义一致)判 stranded——**不新增心跳列**(spawn 事件流即心跳,F2 已保证事件持续落);两者置 spawn failed 后须 `triggerTickSafe` 使上一行的迁移规则跑到。 |
| `actions/nodeRetry.ts`→impl `actions/v3-run-detail.ts`(现有 `nodeRetry`) | 放宽准入:现状实核准入为 node ∈ **{failed, cancelled}**(非仅 failed),且**已**在接受时 `status='ready'` + `currentSpawnId=null`;本项加 **或(node ∈ 非终态 && current spawn ∈ 终态)** 一支(B2 悬挂形态),复用同一「置 ready+清 current_spawn_id」写法;健康 running 节点仍拒。 |
| `actions/runCancel.ts`→impl `actions/v3-runs.ts`(现有 `runCancel`) | **现状订正**:B2 的「成功却报错」根因(`sql.raw` 把 runId 当列名 → "Failed query")**已在 dogfood/main 修好**(改用 `sql` 标签模板参数化)。本项因此降级为**防御性**改动:run 先置 cancelled、再更 spawns;若置 cancelled 后的后续更新/查询抛错,返回 `{cancelled: true, warning}` 而非把已生效的取消报成失败(幂等 + 不误导)。T-F10-07 仍以「取消生效 + 后续查询注入抛错」验此防御路径。 |

### 6B. 前端实施

无新控件(复用 S7 节点/spawn 状态视图;conduction.fixed 计数进 S10 可信卡——F7 交付物)。

### 6C. 数据与迁移

**现状已实核(v3-schema.ts)**:`v3_nodes` 有 `iteration`/`fanout_index`/`current_spawn_id`,
**无 `attempt` 列**;`attempt` 列在 **`v3_spawns`** 上(`integer("attempt").notNull().default(1)`,
起始值 **1** 而非 0,dispatcher 用)。且现有 G19 节点重试是**进程内同步 while 循环**
(`maxAttempts = (retry.max ?? 0) + 1`,`attempt` 为局部变量,**不落库**)——进程重启后计数即丢,
无法支撑本项「跨 tick/重启」的传导重试封顶。故二选一(交付说明写明所选):

- **(A) 复用 `v3_spawns.attempt`(推荐,零 schema 变更)**:传导规则命中时,以「该 node 触发过的
  spawn 数」或失败 spawn 的 `attempt` 值判封顶,`maxAttempts` 沿用 G19 的 `(retry.max ?? 0)+1`
  语义(注意起始 1);此路 `f10-spawn-conduction` **无迁移**。
- **(B) 新增 `v3_nodes.attempt INTEGER DEFAULT 0`**:则追加 `V3_MIGRATIONS` 一项
  **`{ version: 5, name: "f10-spawn-conduction", sql: { postgres: "ALTER TABLE v3_nodes ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0" } }`**
  (`server/plugins/db.ts`,接 F7 的 `version:4`)+ drizzle 列定义进 `server/db/v3-schema.ts`;**无独立 `.sql` 文件**
  (该树 `v3-migrations/*.sql` 已随 `v3.ts` 退役,见前言基线实核)。**注意与 `v3_spawns.attempt`(default 1)
  语义/起始值区分**,避免读错计数器。

无论 A/B,T-F10-02 的 `attempt=maxAttempts-1` 与 `=maxAttempts` 两态断言须按所选计数器的
**起始值**(spawn 为 1)对齐,否则边界差一。

### 6D. 顺序与依赖

F0 先行(f9b72161b 在 dogfood、传导补丁必须落在统一主干);与 F5-F8 无耦合可并行;
**F9 依赖本项**(终态信号可靠)。

### 6E. 测试规格(T-F10-01 … T-F10-08)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F10-01 | spawn失败→节点迁移 | B2 悬挂根治(SDLC-050) | 单测 reconciler:构造 spawn=failed & node=running | tick 后 node ∈ {ready(重试内)/failed(超限)},conduction.fixed 事件落 |
| T-F10-02 | 重试策略 | 不无限重派 | attempt=maxAttempts-1 与 =maxAttempts 两态 | 前者 ready+attempt+1;后者 failed 且 error 含 spawn 摘要 |
| T-F10-03 | 启动扫描 | 重启不留孤儿 | 注入:DB 预置非终态 spawn 行,启动 orchestrator(隔离靶位) | 60s 内该 spawn failed(orphaned-restart)且节点被驱动;S7 视图状态一致 |
| T-F10-04 | 运行期 stall 判定 | 断流可检 | 注入:阻断 :9000 使 spawn 事件停(R3 两法之一) | STALL_MS 后 spawn stranded→failed→节点迁移;恢复网络后 nodeRetry 复活成功 |
| T-F10-05 | CC 节点 kill 注入 | 另一类节点同保障 | **仅适用于 none-runtime/无 microVM 隔离靶位**:kill claude 子进程 PID(R3 实核:`claude-code-executor.ts`/`claude-code-worker.ts`/`none-runtime.ts` 持有 `node:child_process` 真实句柄、已有 `child.kill()`;microVM 生产路径下 kill 走 `msb-bridge` 句柄、非裸 PID)。**与 F1–F4 §6 前言"没有 kill spawn"不冲突**——那条针对的是 vLLM/OM 网络式 spawn(确无本地句柄),两者是不同 spawn 实现路径,F10 只对 CC-kind 走此法 | 同 T-F10-01 链路;节点不悬挂 |
| T-F10-06 | nodeRetry 放宽 | B2 形态可复活 | 对"node running+spawn failed"直接 nodeRetry | 接受并置 ready;对健康 running 节点调用仍拒绝 |
| T-F10-07 | runCancel 语义 | 成功不报错 | mock 取消生效+后续查询抛错 | 返回 cancelled:true+warning,无异常抛出 |
| T-F10-08 | 重放 B2 全场景 | 端到端确认 | 集成:**构造与 `v3r_ehy1aca2zoy2njaj`(B2 原始故障 run)历史时间线同构的合成 fixture**——R3 复核:101 该行现已 `status=cancelled` 且 node/spawn 均为终态,是本方案落地前人工兜底的产物,**不可字面重放**;按其原始故障形态(node=running & 其 current spawn 已终态)手工建构 run/node/spawn 记录 | 无需 runCancel 整 run 作废;节点自动重派或 failed 可 retry;run 不卡 cancelled |

改动↔用例对账:reconciler 传导→01/02/08;启动扫描→03;stall→04/05;nodeRetry→06;runCancel→07。**零遗漏。**

---

## 7. 全局实施顺序(F5–F10 合并视图)

```
F0(前置,豁免台账在案)
├─ F6(tracker,独立)────────────┐
├─ F5(tracker,依赖 F3 已合并)──┤
├─ F7(orchestrator,F2 合并后:engine-loop 同文件)─┤
├─ F10(orchestrator,独立)──────┤
│                               ├─→ F8(tracker,表结构先行)─→ F9(消费 F3+F8+F10,终点)
└───────────────────────────────┘
```

- **并行组**:F5/F6/F7/F10 四线并行(文件互不相交;tracker 迁移号已预分配 v25/v26/v27;orchestrator 命名迁移由 core `runMigrations` 按名登记于 `v3_migrations_named`——同名只应用一次、列表内重名启动即抛错,故 f7-telemetry/f10-spawn-conduction 名唯一即防撞,`version:4/5` 仅供合并线性化排序)。
- **串行链**:F8 → F9(F9 是本批终点,合并后跑 T-F9-01 的 B1 全自动重放作为批次收口验收)。
- **同文件约束**:F7 的 engine-loop 采集改动排在 F2 合并后(唯一跨批次同文件点)。
- 部署批次建议:批次一 F6+F10(纯防护,零行为变化);批次二 F5+F7;批次三 F8+F9(回写链一起上,含 T-F9-01 线上重放)。

## 8. 原型交付清单(本方案随附完成)

| 屏 | 新增 | 对应 |
|---|---|---|
| s2-sprint-studio.html | Briefs 规模徽标+告警条+拆分对话框(Alpine 演示预填/校验/置灰) | F5·1B |
| s5-inbox.html | 评审卡核对清单组(机器预填 pass 锁定/fail 红叉不可勾/批准置灰联动) | F6·2B |
| s9-brain-console.html | 模型注册表区(含假名拒绝演示)+降级 CapabilityBanner | F7·3B |
| s10-health-insights.html | 遥测可信卡(计数行,非零黄) | F7·3B |

**原型↔B 节规格差异表(R2 实核;R3 已按下表落实修复,状态更新如下)**——B 节规格与现原型不一致处,以 B 节为准:

| 屏 | 差异(现原型 → B 节规格应为) | 定性 |
|---|---|---|
| s2 | 依赖控件为 Checkbox → 应为 shadcn Switch(**R3 已修**:拆分对话框「子单按顺序 blocked-by 链接」改为 `.sw` Switch 组件);`一键拆分/仍然派发` 现挂告警条(对话框自有 `取消/确认拆分`)——按钮归属与 1B 描述略偏,两套皆在(**未改,仍轻**);规模徽标仅单条 rail step,非「Briefs 列表逐行」(**未改,仍轻**,03 §6 权威原文明确逐 brief 呈现) | 控件/呈现,轻,**Switch 项已修** |
| s5 | 核对项为可点 `st-icon` 行 → B 节 2B 写 **Checkbox + label**(行为已对:机器 pass 锁定、机器 fail 不可勾、批准置灰);标题 `↔` 为文字标点非图标 | 控件型别,轻(R2 核为行为已对,无需改,R3 未动) |
| s9 | 模型注册表为 `prop-row`+散 badge → 应为真名/别名/档位三列表格;`登记模型` 为内联展开面板 → 应为对话框;登记面板嵌在 `.sp-card` 内=卡中卡(**R3 已修**:改为 `table.fd` 三列表格 + 独立 `.ovl`/`.dlg` 对话框——x-data 作用域上移到共享外层 div,对话框不再嵌套在 `.sp-card` 内;Playwright 1440px 截图 `shots/r3-s9*.png` 确认无卡中卡、alias-forbidden 演示正常) | 呈现 + 禁则违规,**R3 已修复** |
| s10 | 四指标挤 3 行 → 应 5 行;未演示全零=绿态(**R3 已修**:改为 5 行,含「配置未生效」行,Alpine 演示黄态/绿态一键切换;`查看` 深链已扩展到 suspect/别名漂移/降级/配置未生效四行——R9 传导修正常态为 0、未单独演示非零态故不带链接,与设计"任一非零=黄"语义一致);Playwright 截图 `shots/r3-s10*.png` 确认两态渲染正常 | 呈现,**R3 已修复** |

（原 s2 `.step-item.active::before`(line 209)左侧竖条 accent 违规——**R3 已删除该 CSS 规则**,改用 tint + 描边表达 active 态,不再有左侧强调条。）
