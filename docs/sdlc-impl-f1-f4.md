# F1–F4 详细实施方案(前端 + 后端)

> 本文档是路线图(`docs/sdlc-implementation-roadmap.md`)§1 地基 F1–F4 四项的
> 实施细化:纲(五段式)在路线图,目(文件级改动、action schema 字段级签名、
> 控件级交互)在这里。设计权威:02 章 §7/§4.1/§8/§5.4/§3,03 章收件箱评审卡
> 与 InspectorPanel 受守卫流转。所有改动落在 **dogfood 交付主干**
> (`templates/tracker`、`templates/orchestrator`),依赖 F0(交付主干统一)先行。
> 迁移号基准:tracker `db.ts` 当前顶格 **v23**(B5),新迁移从 **v24** 起。
>
> 三个已实证的现状事实贯穿本方案,实施时不得绕过:
> ①V3 spawn 是进程内游离 promise、无 PID/句柄(F2 续传不得预设 kill 能力);
> ②`resolveDiffBase` 沿 origin/main→master→HEAD~1→空树静默回退(F1/W4 真病根);
> ③tracker `update-work-item` 无守卫直写 `currentStageName`、`complete-stage`
> 无 verdict 直写 done、brain argv `Bash/Read/Edit/Write` 全开(F3/F4 现状)。

---

## 1. F1 工作区契约 W1–W4

### 1A. 后端实施

**改动文件清单(orchestrator,5 个文件)**

| 文件 | 改动 |
|---|---|
| `server/v3-workspace-local.ts` | ①`createLocalWorkspace`/worktree 分支:克隆(或 worktree add)完成后立即执行**就绪断言序列**(见下);②新增 `assertWorkspaceReady(dir, mirrorDir, opts)`;③`resolveDiffBase` 重写(W4);④新增 `refreshMirror(mirrorDir)`(`git fetch --prune` 到 bare 镜像,带 GIT_TIMEOUT_MS) |
| `server/engine/v3-workspace.ts` | `createWorkspace` 在 Step 1 provision 后调用就绪断言;失败→workspace 行 `state='failed'` + 抛 `WorkspaceNotReadyError`(错误分类 **infra**,不记 agent 失败,run 不开) |
| `server/v3-workspace-provision.ts`(新) | W2/W3 供给管道:`pnpm install --prefer-offline`(共享 store:`--store-dir $ORCH_PNPM_STORE`,默认 `/workspaces/.pnpm-store`,硬链秒级)+ `test_cmd_smoke` 探测 |
| `server/engine/v3-dispatcher.ts` | 派发前若 workspace 行无 `ready_at` → 拒派并发 `workspace.not_ready` 事件 |
| `actions/workspace-diff.ts`(现有 workspaceDiff action 所在文件) | 返回体增加 `base` 与 `baseSource` 字段透传(前端显示基线来源) |

**就绪断言序列(assertWorkspaceReady,W1→W2→W3 顺序执行,全过才写 `ready_at`)**

1. **W1 基线新鲜**:`refreshMirror(bareMirrorDir(repoUrl))` → `git fetch origin`(工作区内)→
   断言 `git merge-base HEAD origin/<目标分支>` == `git rev-parse origin/<目标分支>`
   (即 merge-base 距离 0)。不满足 → 对 worktree 隔离执行 `git reset --hard origin/<目标分支>`
   后**重新断言**;二次失败 = `WorkspaceNotReadyError('W1', detail)`。
2. **W2 依赖预热**:`node_modules/.bin` 存在且 `pnpm exec vitest --version` 退出码 0;
   不存在 → 供给管道跑 `pnpm install --prefer-offline --store-dir $ORCH_PNPM_STORE`
   (workspace 根 + 目标模板目录);再验;失败 = `WorkspaceNotReadyError('W2')`。
3. **W3 测试可执行**:执行 `test_cmd_smoke`(默认
   `pnpm exec vitest run --passWithNoTests --dir <模板>/actions/__tests__ --reporter=dot`,
   项目可在 tracker 项目设置覆盖);超时 120s;非零退出 = `WorkspaceNotReadyError('W3')`。

**W4:resolveDiffBase 重写(v3-workspace-local.ts:716)**

```ts
// 旧:for origin/main→origin/master→main→master→HEAD~1→空树 静默回退
// 新:
async function resolveDiffBase(dir: string, mirrorDir: string, targetBranch: string) {
  await refreshMirror(mirrorDir);                     // 调用时刷新,禁静态基线
  await git(["fetch", "origin", targetBranch], { cwd: dir });
  const mb = await git(["merge-base", `origin/${targetBranch}`, "HEAD"], { cwd: dir });
  if (!mb || mb.code !== 0 || !mb.stdout.trim()) {
    throw new DiffBaseUnresolvableError(dir, targetBranch);   // 显式错误,绝不回退
  }
  return { base: mb.stdout.trim(), baseSource: `merge-base(origin/${targetBranch}, HEAD)` };
}
```

调用方(workspaceDiff action、runSummary 的 diff 统计)捕获
`DiffBaseUnresolvableError` → 返回 `{ error: "diff-base-unresolvable", detail }`,
**不返回任何 diff 统计**。`against` 显式参数仍允许(评审比对场景),但返回体
必须回显 `baseSource: "explicit"`。

**staleness 事件(存续期,设计——本轮未落地)**:reconciler tick 内(既有周期)对
running run 的 workspace 比对 `镜像目标分支 tip` 与建区时记录的 `base_sha`,
前进 → 发一次性 `workspace.stale` run 事件(幂等:v3_events 查重),brain 唤醒
消息模板附带。**状态:T-F1-12,本轮实施未做**——见下方「F1 剩余项」。

**错误语义**:`WorkspaceNotReadyError` → spawn 不创建、node 不派发、run 事件
`workspace.not_ready`(kind=infra);重试走"重建工作区"而非节点重试。

**测试**:见 **§6.1**(T-F1-01…T-F1-16,单一维护处;原零散 DoD 已并入;
T-F1-12/T-F1-14 本轮延后,见下方「F1 剩余项」)。

**F1 剩余项(未随本轮落地,标注供跟踪——信任跨越目标分支前进的长命 run 之前
必须先补)**:

- **T-F1-12 · workspace.stale 存续期事件**(reconciler tick 对 running run
  的漂移检测)——不在 `v3-workspace-local.ts` 的文件边界内,本轮未实现
  (`v3-workspace-local.spec.ts` 顶部注释、F1 提交说明均如实标注为延后)。
- **交付时新鲜度断言**——`assertW1BaselineFresh`(W1)只在
  `createLocalWorkspace` 建区时跑一次;F1 代码里**不存在**任何"提交/推送/
  开 PR 之前重新断言 merge-base==目标分支 tip"的门。W4(`resolveDiffBase`)
  保证的是"diff 基线在调用时恒正确或显式报错",不等于"工作区没有落后于
  目标分支"。若确有一道交付前 merge-base==tip 的断言,那是 **merge-pr 的
  brain/DAG 机制**在把关,不属于 F1 这几个文件。
- 结论:跨越目标分支前进的长命 run 期间,workspace 与目标分支之间存在一个
  **有界但目前不可观测的漂移窗口(B2)**——F1 只保证①建区时基线新鲜、
  ②W4 diff 观测恒正确;这个窗口靠 merge-pr 交付时的最终断言兜底,而非本轮
  新增的任何机制。上面的 staleness 事件与真正的交付时新鲜度门仍是待办。

### 1B. 前端实施(可选增强,S7 运行详情——T-F1-14,本轮未做)

> 本节整节依赖 `workspace.stale` 事件(T-F1-12),而该事件本轮未实现(见
> 1A 末尾「F1 剩余项」)。以下为该事件补齐后的前端规格,**不代表当前已有
> 任何交付时校验**——文案不得暗示存在自动 rebase 或交付时强制门,那是
> merge-pr 的 brain/DAG 职责,不是这条提示条的行为。

- **staleness 提示条**:S7 页头下方,出现条件=run 事件流含 `workspace.stale`
  且 run 非终态。样式:`--warning` 15% 底色横条(禁左侧竖条),文案
  "工作区基线落后于 <分支> tip(领先 N 提交)——交付前请重建工作区或确认
  merge-pr 的基线校验已覆盖",右侧 ghost 按钮 `重建工作区`(调
  workspaceCreate 重建 + 确认 Dialog,仅 run 未有 running 节点时可用,否则
  置灰 + tooltip 说明)。
- **就绪徽标**:S7 侧栏工作区行,`ready_at` 存在 → `st-icon ok` + "就绪
  (W1–W3)";`state=failed` → `st-icon err` + 失败的 W 编号,点击展开
  EvidenceCard(断言输出)。
- **diff 基线来源**:S7/评审卡的 diff 统计标题行显示 `baseSource`
  (mono 小字);`diff-base-unresolvable` 错误 → EmptyState:"diff 基线不可
  解析——工作区缺少与 <分支> 的公共祖先",附错误详情折叠,不渲染任何文件列表。

### 1C. 数据与迁移(orchestrator v3,加性)

`v3_workspaces` 加列(v3 命名迁移,orchestrator 侧):
`base_sha TEXT`(建区时目标分支 tip)、`ready_at TIMESTAMP`、
`ready_report JSONB`(W1–W3 各自的断言输出摘要)。

### 1D. 顺序与依赖

依赖 F0(基线定义在交付主干)。内部顺序:W4(独立可先发,B4 病根)→
W1 → W2/W3(供给管道)→ staleness 事件(T-F1-12,**本轮未排上,列为剩余
项**——见 1A 末尾)。F2 的验收(12 文件任务)踩 W2/W3。

---

## 2. F2 执行器上下文管理(调研结论 B)

### 2A. 后端实施(全部在 orchestrator,core 零改动)

**改动文件清单(2 个文件 + 1 个新文件)**

| 文件 | 改动 |
|---|---|
| `server/runtime/executors/engine-loop.ts` | ①runAgentLoop 调用改经 `runAgentLoopDirectWithSoftTimeout`(core 既有导出),透传 usage 返回形状不变;②opts 增 `threadId: spawn:${spawnId}`(前缀防与 chat threadId 撞库)+ 既有 ownerEmail/orgId——激活 core 内 OM 消费(每迭代 `applyObservationalMemoryToContext`)、tool journal、context-xray;③send sink 累计 tool_result 字符数,超阈值(`ORCH_DEV_COMPACT_THRESHOLD_TOKENS`,默认 70_000,字符/4 估算)fire-and-forget `maybeCompactThread({ threadId, ownerEmail, orgId, messages })`;④截断/溢出类可续错误(`isResumableEngineError`)→ 续传分支:`appendAgentLoopContinuation`(已写文件清单+剩余任务),同一 spawn 继续,`spawn_events` 记 `context.compacted` / `loop.resumed` 事件 |
| `server/engine/v3-dispatcher.ts`(**F2b 已交付**) | spawn attempt 重试路径:`fetchPriorCheckpoint` 按 `node_id` 查该节点已有的 `v3_spawns` 行(存在即为重试),取最近一次的 `context_checkpoint`;非空则 `formatCheckpointInjection` 生成「已完成产物清单+剩余任务」段,在 renderTemplate 插值**之后**拼到 rendered_prompt 尾部(C3:禁止从零重跑;插值后拼接是为了不让上一轮 LLM 输出里的字面 `{{...}}` 二次进入模板渲染器)。首次 attempt 或上一 attempt 检查点为空/未写入时不注入任何内容,不伪造占位段。覆盖 in-process 重试(`fireAndTrackSpawn`)与 reconcile 触发的重新派发(T-F2-06 的重启场景)两条路径,因为两者都经同一个 `spawn()`。 |
| `server/runtime/executors/context-checkpoint.ts`(新,~80 行) | 从 send 流增量提取「已写文件清单」(edit/write 工具调用成功记录),spawn 终止时落 `v3_spawns.context_checkpoint JSONB`;供 dispatcher 重试注入 |

**接口/配置**
- env:`ORCH_DEV_COMPACT_THRESHOLD_TOKENS`(默认 70000)、
  `ORCH_DEV_MAX_OUTPUT_TOKENS`(已存在,32k)。
- OM 内部 LLM 走 `resolveEngine` 注册表默认(101=本地 vLLM,无外部配额);
  `observational_memory` 表懒建,无迁移。
- **不预设 kill 能力**:续传触发点仅为①引擎可续错误②进程重启后的
  reconcile(F10 范畴)——不设计"外部掐断在跑 spawn"的接口。

**幂等与失败语义**:`maybeCompactThread` fire-and-forget,失败仅日志(压缩
是优化不是正确性前提);续传注入的已完成写操作由 tool journal 防重放;
`context_checkpoint` 只增不改。

**部署验证注记**:F2 依赖本分支的 db 合并血缘(`getV3Db`/`v3Schema`/`migrateV3`
在 origin/main 不存在),**不可单独 cherry-pick**,须与本分支整体部署;
T-F2-11 的真 Postgres 验证在部署窗口执行。

**测试**:见 **§6.2**(T-F2-01…T-F2-13;原零散 DoD 已并入)。

### 2B. 前端实施(S7 转录视图,轻量)

- `[Observational Memory]` 注入块在转录中渲染为**折叠段**(TimelineCollapse
  语汇):眉题 `ti-stack-2` 图标 + "上下文已压缩(N 步→摘要)" + 展开显示
  摘要正文;`context.compacted`/`loop.resumed` 事件在节点时间线显示
  `st-icon inf` 行。无新页面、无新弹窗。

### 2C. 数据与迁移(orchestrator v3,加性)

`v3_spawns` 加列:`context_checkpoint JSONB`(已写文件清单+剩余任务摘要,
终止时落盘)。

### 2D. 顺序与依赖

依赖 F0(dogfood main 先吸收 32k 修复,消除 200k 硬编码残留)。②③④可
并行开发;④(续传)依赖 2C 列先行。F4 评审会话形态复用本项的 threadId 机制。

---

## 3. F3 状态迁移守卫 + 派发不推进 + 人工流转通道(前后端重头)

### 3A. 后端实施(tracker,dogfood 主干)

**改动文件清单(9 个文件;后 3 个为独立评审补充——done 红线要闭合,全部
未守卫直写通道必须同批封死,缺一即 SDLC-058 复发)**

| 文件 | 改动 |
|---|---|
| `actions/transition-work-item.ts`(**新**) | 受守卫人工流转/关闭的唯一写入口(schema 见下);实现 02 §8 守卫表行:守卫判定(目标状态×写入方身份×证据载荷)→ 写 `status`/`current_stage_name`/回链列 → activities 行 + 框架 audit-log(action 自动入审计) |
| `server/lib/transition-guard.ts`(**新**) | 守卫表的纯函数实现:`allowedTransitions(item, actor)` 返回合法目标集(供 action 与前端选项同源);`assertTransition(item, target, actor, evidence)` 缺证据抛结构化错误 `{code:'evidence-missing', need:[...]}` |
| `actions/complete-stage.ts` | 移除「交付」阶段完成直写 `status=done` 的路径;verdict 语义收紧:`result` 必填枚举;done 一律拒绝并指向 transition-work-item(错误信息中给出) |
| `actions/dispatch-to-orchestrator.ts` | **派发不推进**:删除 currentStageName 推进与 `stagedAdvanced`;改写 `exec_state='dispatched'`(新列);brain 首轮零交付失败(thread error 且无 workflowRun)→ 回写 `exec_state='queued'` + activities 失败事件(由 F9 回写通道运载;F9 未落地前由 dispatch 的同步错误路径先覆盖同步失败场景) |
| `actions/update-work-item.ts` | schema 删除 `currentStageName`(阶段一律走守卫);保留纯元数据字段 |
| `actions/get-work-item.ts` | 返回体加 `execState` 与 `allowedTransitions`(调 transition-guard,前端对话框选项直接消费,保证前后端同源) |
| `actions/get-activity.ts` | **轮询回写封顶**:deriveItemStatus 的 slot 终态成功/交付 PR 一律派生 `returned`(新状态词,run 已回、待评审),**绝不派生 done**;阶段推进封顶「验收」(强交付→验收、否则→测试,纯函数 `deriveWritebackStage`),并回写 `exec_state='returned'` |
| `actions/advance-stage.ts` | **回写/推进通道封顶「验收」**:推进入「交付」一律 guarded noop(reason=`delivery-guarded`,指向 transition-work-item);移除 `isFinalDelivery→status='done'` 副作用;活动行 `actorKind` 取真实 actor(actorFromCaller,agent 工具环=agent),不再硬编码 human |
| `actions/bulk-dispatch-to-orchestrator.ts` | 与单 dispatch **完全同法**:删除批量路径的 currentStageName 推进与实施 stage upsert,写 `exec_state='dispatched'`(批量与单件分叉=SDLC-063 在批量侧重开) |

**transition-work-item schema(字段级)**

```ts
schema: z.object({
  id: z.string().min(1),                              // 工作项 id
  target: z.enum(["待办","实施","测试","待人工评审","交付","done","closed"]),
  reason: z.string().min(4),                          // 强制,写审计与活动流
  verdict: z.enum(["PASSED","CHANGES_REQUESTED"]).optional(),  // target=done 必填 PASSED
  evidence: z.object({                                // 证据载荷,按守卫表行必填
    runId: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),                    // 人工完成→交付:PR/commit 必填
    deliveryItems: z.array(z.string()).optional(),
    links: z.array(z.string()).optional(),
  }).optional(),
})
```

**守卫判定核心规则(transition-guard,与 02 §8 一一对应)**
- `done`:仅人(JWT 用户,`actorKind=human`)且**仅源态==待人工评审(验收)**
  且 `verdict==='PASSED'` 且 `evidence.commit` 存在;agent 身份(A2A run
  tags)一律拒绝(actor 检查先于源态检查:agent 得 `actor-denied`,human
  从其他源态得 `invalid-source-state`)。CHANGES_REQUESTED 重定向(done→
  回退实施)**仅在源态==待人工评审时生效**——其他源态发 done+
  CHANGES_REQUESTED 不重定向,按 done 被守卫拒绝、零写入。
- `closed`:仅人、仅未派发项(`exec_state IN (null,'queued')`)、reason 必填。
- `交付`(人工完成逃生口):仅人 + `evidence.commit/links` 至少一项。
- 回写类迁移(实施→测试 等)不走本 action(F9 通道),本 action 对这些
  target 仅允许**人工带 reason 的纠错回退**,写 `transition.manual-override`
  活动行以示区分。
- 幂等:target==当前状态 → no-op 返回 `{noop:true}`。
- CAS 写:UPDATE 的 WHERE 完整复述守卫评估时的快照三轴
  (`status`+`current_stage_name`+`exec_state`)——exec_state 轴防 F9 落地后
  「读到未派发→守卫放行 closed→写前被派发」的 TOCTOU 漏判。

**测试**:见 **§6.3**(T-F3-01…T-F3-19,含守卫全矩阵表;原零散 DoD 已并入)。

### 3B. 前端实施(S4 工作项详情——受守卫流转对话框,完整交互规格)

**入口**:InspectorPanel「状态」PropRow(整行可点击,hover 背景 `--muted`;
行尾 `ti-shield-lock` 常驻示意受守卫)。点击 → 打开 **GuardedTransitionDialog**。

**对话框(shadcn Dialog,禁浏览器 confirm;宽 440px)逐控件规格**

| 控件 | 规格 |
|---|---|
| 标题 | `变更状态 · <itemKey>`;副标题当前状态徽标(st-icon+文案) |
| 目标状态 Select | 选项 = `get-work-item.allowedTransitions`(服务端同源,**不在前端复刻守卫表**);每项:目标名 + 右侧灰字要求摘要(如 done:"需 PASSED verdict + 合并 commit");空集 → Select 禁用 + 行内说明"当前状态没有你可执行的人工迁移" |
| 原因 Textarea | 必填(≥4 字),placeholder"为什么人工变更?写入审计与活动流";实时校验,未过则提交置灰 |
| verdict 段(条件渲染:target=done) | RadioGroup:PASSED / CHANGES_REQUESTED;选 CHANGES_REQUESTED 时提交按钮文案变`驳回并要求返工`且**不写 done**(等价于评审驳回,回「实施」) |
| 证据段(条件渲染,按 allowedTransitions 元数据 need 字段装配) | `合并 commit` Input(mono,7-40 位 hex 校验)· `关联 run` Select(该项历史 run 列表,来自 orchestratorRunId+活动流,可空)· `交付物` 列表编辑器(Input+添加按钮,行可删,≥1 条时有效)· `链接` 同款 |
| 缺口提示 | 服务端 `evidence-missing` 错误 → 对应控件红边 + 底部 `--destructive` 15% 提示条列缺项(不关对话框) |
| closed 分支(未派发项) | target 选 closed 时证据段隐藏、仅 reason;提示条说明"关闭后可在已关闭过滤中找回" |
| 操作行 | `取消`(ghost)/ `确认变更`(primary;全部必填有效才可用);提交中 spinner+置灰防重复 |

**提交行为**:`useActionMutation("transition-work-item")`;乐观更新(状态
PropRow 立即换目标态 + 对话框关闭)→ 失败回滚 + toast(错误信息含守卫
拒因)+ 重新打开对话框保留已填内容;成功 toast + 活动流插入
`transition.manual` 行(乐观)。审计回读:活动与评论时间线渲染
`transition.manual` 事件(actor 徽标 human、reason 引用块、证据 chips)。

**权限**:对话框对所有登录用户可见;`allowedTransitions` 服务端按身份
计算(agent 经 MCP 调 action 得到空集/拒绝)。**空态/加载态**:详情页加载
中 PropRow skeleton;提交错误态如上。

**原型**:s4-work-item.html 已补入本对话框(Alpine 演示:目标状态切换驱动
verdict/证据段显隐与置灰逻辑,见 `shots/s4-transition-dialog.png`)。

### 3C. 数据与迁移(tracker,加性,v24)

```sql
-- v24
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS exec_state TEXT;          -- null|queued|dispatched|running|returned
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS closed_reason TEXT;
ALTER TABLE tracker_work_items ADD COLUMN IF NOT EXISTS closed_at TEXT;
```

(verdict/证据不落新表:verdict 在 stage 行既有 `verdict` 字段与活动流
payload;审计走框架 audit-log 自动记录。)

### 3D. 顺序与依赖

依赖 F0。内部顺序:transition-guard 纯函数 + 单测 → transition-work-item
action → dispatch 不推进(v24 列先行)→ complete-stage 收紧 →
get-work-item 返回 allowedTransitions → S4 对话框。与 F9 配对:回写类迁移
的自动运载在 F9,本项先把"人工与守卫"立起来;F9 未到位期间实施→测试等
仍由 brain 经既有 action 触发,但 done 通道即刻收紧(先堵最大的洞)。

---

## 4. F4 能力面矩阵(评审只读)+ spec/评审分离

### 4A. 后端实施(orchestrator)

**改动文件清单(4 个文件)**

| 文件 | 改动 |
|---|---|
| `server/brain/brain-session.ts` | argv 工具面按**相位**装配:新增 `phase` 参数(dispatch|review)——dispatch 相位:`--allowedTools mcp__orchestrator Read Grep Glob`(移除 Bash/Write/Edit;深读代码写 spec 用 Read/Grep 足够;需要 Bash 的只读诊断走白名单包装工具,首版直接去 Bash);review 相位:同 dispatch + workspace 只读挂载(见下) |
| `server/brain/brain-monitor.ts`(run 终态唤醒路径) | 唤醒消息构造时标注 `phase='review'`;评审发现问题的出口只有一个:MCP 工具 `workflowRun`(fix 模式,携带评审发现清单)——提示词同步改,但约束以工具面为准 |
| `server/engine/v3-workspace.ts` + runtime mounts | 评审相位的 workspace 访问走**只读 bind mount**(NoneRuntime/本地目录:评审会话的 cwd 指向 `mount --bind -o ro` 副本,或等价地:brain 评审相位不给 workspace 写路径,diff/文件读取全部经 MCP 工具 workspaceDiff/workspaceRead——**首版采用后者**,零挂载改造,机制=工具面裁剪) |
| `server/engine/v3-dispatcher.ts` + agent defs(SQL) | 评审独立性:sdlc-issue-pipeline 的 reviewer 节点(或 brain 评审会话)与 spec 作者分离——brain 线程 A 写 spec 派发后,run 终态唤醒**强制新 brain 线程 B**(`bt_` 新 id,系统消息携带 spec+diff 引用,不 resume 线程 A);`v3_runs.tags` 记 `specThreadId`/`reviewThreadId`,二者不等为结构性验收 |

**agent defs(SQL,S0 已建表)增列/配置**:`capability_profile JSONB`
(`{phase: {tools:[], workspaceAccess:'ro'|'rw'|'none'}}`)——brain-session 与
节点执行器从此读装配,不硬编码。

**verdict 落 run 证据**:评审线程 B 的结论经新 MCP 工具
`runVerdict({runId, verdict, findings[]})` 写 `v3_runs.tags.verdict` +
run 事件 `review.verdict`——tracker 评审卡与回链读取此处(不再只在
brain 转录里)。

**测试**:见 **§6.4**(T-F4-01…T-F4-08;原零散 DoD 已并入)。独立复核抓出
spec 内嵌缺陷(B2 无事务类)作辅助质量信号记录,不作二值门。

### 4B. 前端实施(轻量,两处)

- **S7 运行详情 / S5 评审卡**:评审会话徽标——`reviewer` chip +
  `bt_xxxx`(mono 截断)与 spec 会话徽标并排;`specThreadId==reviewThreadId`
  时显示 `st-icon warn` + "评审未分离"(发生即可见)。verdict 徽标:
  PASSED(`st-icon ok`)/CHANGES_REQUESTED(`st-icon err`)+ findings 折叠列表。
- **S9 Brain 控制台**:能力面矩阵只读简表(角色×相位×工具面×workspace
  权限,数据源 agent defs 的 capability_profile;Table 组件,无编辑——
  编辑属阶段三)。

### 4C. 数据与迁移(orchestrator,加性)

agent defs 表加列 `capability_profile JSONB`;`v3_runs.tags` 无 schema 变更
(JSONB 内加 `specThreadId/reviewThreadId/verdict` 键)。

### 4D. 顺序与依赖

依赖 F0、F2(评审会话形态:新线程 B 复用 F2 的 threadId 机制)。内部顺序:
capability_profile 数据面 → brain-session 相位工具面(先 dispatch 后 review)
→ 评审新线程分离 → runVerdict 工具 → 前端徽标。F3 的评审卡`批准合并`按钮
消费本项的 verdict(F3 前端先行时可暂读 stage verdict,F4 落地后切换)。

---

## 5. 全局实施顺序(F1–F4 合并视图)

```
F0(交付主干统一)
 ├─ F1.W4 diff 基线(独立可先发,B4 病根) ──┐
 ├─ F3.v24 列 + transition-guard + action ──┼─ 并行开发
 ├─ F2.threadId/压缩/续传 ─────────────────┤
 └─ F1.W1-W3 供给管道 ─────────────────────┘
        ↓
 F4(依赖 F2 会话形态;评审只读 + 分离 + runVerdict)
        ↓
 S4 对话框 / S7 徽标与提示条 / S5 评审卡 verdict 接线(前端批次)
        ↓
 §1.12 验收门:故障注入逐条(F1①-④、F2 断流、F3 三连、F4 ①②③)
```

关键里程碑判定:F3 的 done 收紧一经部署,B3 式"未评审即 done"立即不可能
——建议 F3 后端作为第一个部署批次(含 v24),不等 F1/F2/F4 齐活。

---

## 6. 测试规格(F1–F4 全量)

> 每条用例五字段:**编号 / 测什么 / 目标**(防住哪个真实失效,引用实战
> issue)/ **如何验证**(前置→执行→观察点;注入类写明具体注入法)/
> **预期结果**(无歧义可判定断言)。各 F 的 A 节测试点已并入本节,单一
> 维护处。破坏性注入一律在**隔离靶位**执行(路线图 §1.12 前置:一次性
> Postgres 临时库、一次性镜像与工作区目录、维护窗口、brain 以 API key
> 运行),禁打生产共享资源。注入法只用已实证可行的手段:**没有 kill
> spawn**(spawn 无句柄,R3 实证)——进程级中断一律用"切断 vLLM 连接"
> 或"维护窗口重启 orchestrator"。

### 6.1 F1 工作区契约(T-F1-01 … T-F1-16)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F1-01 | resolveDiffBase 正常路径(单测) | W4 基线动态正确(SDLC-059) | fixture:mktemp 建 bare 镜像+克隆工作区,工作区提交 2 个 commit;调 `resolveDiffBase(dir, mirror, 'main')` | 返回 base==`git merge-base origin/main HEAD` 真值;`baseSource=='merge-base(origin/main, HEAD)'` |
| T-F1-02 | 目标分支不可解析显式报错(单测+注入) | 杜绝静默回退链(B4 假 diff 病根,SDLC-059) | 注入:让镜像/远端**不含目标分支**(bare 镜像删 `refs/heads/<目标分支>`,或对不存在分支名调用)——使函数内 refreshMirror+fetch 无法拉回该 ref、merge-base 无 origin 侧解析;调 `resolveDiffBase(dir, mirror, '<缺失分支>')`。**注:只删工作区本地 `refs/remotes/origin/main` 无效——新函数先 fetch 会把它自我修复,测不到错误路径** | 抛 `DiffBaseUnresolvableError`;绝不沿 origin/master→HEAD~1→空树回退 |
| T-F1-03 | 无公共祖先显式报错(单测) | 同上,orphan 分支场景 | fixture:`git checkout --orphan` 分支提交后调用 | 抛 `DiffBaseUnresolvableError` |
| T-F1-04 | refreshMirror 调用时刷新 | 禁静态基线:镜像滞后不得产生旧基线 | fixture:上游推进 1 commit、镜像不 fetch;调 resolveDiffBase | 函数内先刷镜像;返回 base 反映最新 tip 的 merge-base |
| T-F1-05 | W1 基线新鲜断言(注入) | 工作区不再基于过期基线(SDLC-056,B2 冲突根因) | 隔离靶位:先 createWorkspace 建区(HEAD 落在当前 tip C0,记 base_sha),**再**向共享镜像目标分支推进一格到 C1(制造建区后过期),随后对该工作区跑 `assertWorkspaceReady` | ready 时 merge-base 距离==0(W1 refreshMirror 后检出 C0<C1,隔离 `reset --hard origin` 到 C1 重断言通过);reset 关闭/失败则 `WorkspaceNotReadyError('W1')`——二者必居其一,绝无"带旧基线 ready" |
| T-F1-06 | W2 依赖预热 | dev 有测试执行环境(SDLC-057,B5 教训) | 新建工作区内跑 `pnpm exec vitest --version` | 退出码 0;供给耗时与结果落 ready_report |
| T-F1-07 | W3 smoke 可执行+失败拦截(注入) | 测试可执行是就绪门(B3 反证其可行) | 正常建区看 ready_report;**非空校验**:靶位放一个必过样例测试、smoke 去掉 `--passWithNoTests`,确认真实用例被执行(排除空目录假绿);注入:项目设置把 test_cmd_smoke 改为 `exit 1` 再建区 | 正常:smoke 真实执行 ≥1 用例并通过才写 ready_at;注入:`WorkspaceNotReadyError('W3')`,workspace `state='failed'` |
| T-F1-08 | 就绪失败错误语义 | 环境故障≠agent 失败(infra 分类) | 承接 T-F1-07 失败工作区,查 v3_events 与 spawn/node | 事件 `workspace.not_ready`(kind=infra);零 spawn、node 不派发、无 agent 失败记账 |
| T-F1-09 | dispatcher 拒派未就绪工作区 | 就绪门不可绕过 | 隔离库将测试工作区 ready_at 置 NULL 后触发派发 | 拒派 + `workspace.not_ready` 事件;node 保持待派 |
| T-F1-10 | B4 假 diff 回归重放 | workspaceDiff==真实改动(SDLC-059 回归锁) | 工作区改 7 个文件;调 workspaceDiff;对照 `git diff --stat` 对 merge-base 的真值 | 文件数与增删行完全一致;返回体含 base+baseSource |
| T-F1-11 | 基线错误传播到 action | 观测错=守门错,必须显式到达调用方 | 在 T-F1-02 注入态经 MCP 调 workspaceDiff;并对 runSummary 的 diff 统计路径同样注入调用(两个调用方都走 resolveDiffBase) | 两条调用均返回 `{error:'diff-base-unresolvable', detail}`,无任何 diff 统计字段 |
| T-F1-12 **(本轮延后,未执行——见 §1A「F1 剩余项」)** | staleness 事件幂等 | 基线漂移发生即可见且不刷屏 | 建区后镜像推进 1 commit;等 2 个 reconciler tick | v3_events 恰好 1 条 `workspace.stale`;brain 唤醒消息附带 |
| T-F1-13 | v3_workspaces 迁移冒烟 | 新列真实建列(B5 教训:空库实证) | 一次性 Postgres 临时库跑全部 v3 迁移 | base_sha/ready_at/ready_report 三列存在、类型正确 |
| T-F1-14 **(本轮延后,未执行——依赖 T-F1-12,见 §1B)** | S7 提示条/就绪徽标/基线来源(UI,可选) | 状态发生即可见 | Playwright 登录态打开含 stale 事件的 run 详情 | 提示条含领先提交数;就绪徽标 st-icon ok;diff 标题行显示 baseSource |
| T-F1-15 | 显式 against 参数基线来源(单测) | 评审比对场景基线可信,against 不误入 merge-base 分支(W4) | 调 resolveDiffBase/workspaceDiff 传显式 `against=<sha 或分支>` | 返回 base==该 against 的解析值;`baseSource=='explicit'`;不触发 refreshMirror+merge-base 动态求解分支 |
| T-F1-16 | refreshMirror 超时归 infra(注入) | 就绪期 git 网络故障归 infra 且不挂起建区(GIT_TIMEOUT_MS 生效) | 隔离靶位把镜像 remote 指向不可达地址(或设极小 GIT_TIMEOUT_MS),createWorkspace 触发 refreshMirror | 有界超时后抛 `WorkspaceNotReadyError`(kind=infra);createWorkspace 不无限挂起;零 spawn、node 不派发 |

**测试环境与工具(F1)**:单测=vitest+临时 git fixture(测试内自建 bare+clone);
注入/集成=隔离靶位(一次性镜像与工作区目录,不触生产 /workspaces 池);
迁移=**真 Postgres 临时库**(JSONB/TIMESTAMP 语义,内存 libsql 不适用);
UI=Playwright(登录态 check-state.json 法)。

### 6.2 F2 执行器上下文管理(T-F2-01 … T-F2-13)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F2-01 | checkpoint 提取器(单测) | 续传注入清单准确(C3) | 构造 send 流样本(edit/write 成功与失败、bash 混杂)喂提取器 | 输出恰为成功写入的文件清单;失败写入不计 |
| T-F2-02 | 压缩阈值计算(单测) | 超阈值必触发、不足不触发 | 累计字符在 70k tokens×4 两侧各一样本(mock maybeCompactThread) | 仅越界侧触发且恰一次 |
| T-F2-03 | threadId 传入激活 OM 通道(集成) | dev 循环挂上 OM/日志线程(簇十,M3-D 根因) | 101 隔离窗口跑一轮 dev spawn;SQL 按 threadId 前缀查 observational_memory 表 | observational_memory 出现 `spawn:<id>` 键行(证明 threadId 已透传并激活通道,**确定性**);压缩是否实际发生由 T-F2-10 端到端确证,本条只锁通道接通,不依赖单轮是否越阈值 |
| T-F2-04 | threadId 前缀防撞 | spawn 记忆不污染 chat 线程 | 对照跑一轮 chat 会话;SQL 查 observational_memory 两类 threadId | `spawn:*` 与 `bt_*` 行互斥,无交叉读写 |
| T-F2-05 | 断流续传(注入;禁 kill) | 截断不从零重跑(C3;M3-D 三连溢出教训) | 隔离窗口:dev spawn 运行中把 runtime_config baseUrl 临时指向不可达端口(或网络层阻断 :9000),随后恢复 | `isResumableEngineError` 命中→续传;同一 spawn 续跑完成;spawn_events 有 `loop.resumed`;已写文件无重复写(journal 防重放) |
| T-F2-06 | 重启后 checkpoint 注入(注入)**【✅ F2b 已交付——dispatcher 侧注入逻辑见 v3-dispatcher.ts `fetchPriorCheckpoint`/`formatCheckpointInjection`,单测见 v3-dispatcher.spec.ts「F2b: retry checkpoint injection (T-F2-06)」describe 块】** | 进程级中断不归零(用重启法,不预设 kill) | 单测以「预置一条带 context_checkpoint 的 v3_spawns 行 + 重新调用 spawn()」模拟 reconcile 重置后的重新派发,断言新 spawn 的 rendered_prompt;**真实的进程级重启(维护窗口重启 orchestrator 进程)仍需 101 隔离窗口做端到端确证,单测覆盖的是重试注入逻辑本身,不是重启本身** | prompt 含「已完成产物清单+剩余任务」段;不重复实现已完成文件;首次 attempt 或检查点为空时不注入(单测覆盖) |
| T-F2-07 | checkpoint 落盘与只增 | 断点数据可靠 | spawn 正常完成/异常终止两态查 v3_spawns.context_checkpoint | 两态均落盘;重复终止路径不覆盖已有清单 |
| T-F2-08 | 32k 请求回归 | 64k 预算反噬不复发(SDLC-060) | 断言 engine-loop 实际传参(或 vLLM 侧请求日志) | max_tokens==32000(或 env 覆盖值),≠200000 |
| T-F2-09 | clamp 告警回归 | 静默钳制不复发(CORE-PATCHES #4) | 单测:`resolveMaxOutputTokensForEngine(engine, 200_000)` + console.warn spy | 返回 64000 且 warn 含 "clamped"。**注:warn 文本断言属 packages/core changeset(spec 需 console.warn spy),不属本切片** |
| T-F2-10 | M3-D 级 12 文件端到端 | 大单不再确定性溢出(F2 总验收) | 隔离窗口重放 12 文件/650 行级 spec 的 dev run | 32k 上限保证单轮不反噬 + 出现 ≥1 次 `context.compacted` 标记 +(跨轮/续传时)OM 消费介入——**压缩是尽力而为的辅助,非同轮确定防线** |
| T-F2-11 | v3_spawns 迁移冒烟 | 列真实建立 | 同 T-F1-13 靶位 | context_checkpoint 列存在(JSONB) |
| T-F2-12 | S7 折叠段与事件行(UI 轻量) | 压缩可见不噪 | Playwright 打开含 compacted 事件的 run 转录 | OM 块渲染为折叠段(默认收起);`context.compacted`/`loop.resumed` 行 st-icon inf |
| T-F2-13 | 压缩失败被吞不影响正确性(单测/集成) | 压缩是优化非正确性前提(维护 fire-and-forget 语义) | mock/注入 `maybeCompactThread` reject;跑越阈值 dev 循环 | spawn 正常完成;压缩失败仅落日志;不触发 `isResumableEngineError`、不重跑、无 `loop.resumed`;产物完整 |

**测试环境与工具(F2)**:单测=vitest(提取器/阈值/clamp 纯函数);集成与
注入=101 隔离窗口+真 vLLM(OM 内部 LLM 走本地 vLLM,无外部配额;§1.12
前置:隔离靶位+brain API key);**断流注入禁用 kill spawn**;迁移=真
Postgres 临时库;UI=Playwright。

### 6.3 F3 状态迁移守卫(T-F3-01 … T-F3-19)

**守卫矩阵(逐目标态;T-F3-01 以表驱动枚举锁死全组合)**

| 目标态 | 合法写入方 | 证据要求 | 非法情形→预期 |
|---|---|---|---|
| done | 仅 human,**仅源态==待人工评审**(02 §8 设计权威;本行早期版本未写源态约束属与 02 §8 的文档冲突,已修订) | verdict==PASSED **且** evidence.commit(7-40 位 hex) | agent(A2A 身份)→`actor-denied`(actor 检查先于源态);human 自其他源态→`invalid-source-state`;缺 verdict 或 commit→`evidence-missing` 列缺项;CHANGES_REQUESTED(仅源态==待人工评审)→不写 done、回「实施」;其他源态发 done+CHANGES_REQUESTED→不重定向、按 done 拒绝零写入 |
| closed | 仅 human | reason≥4 字;且未派发(exec_state∈{null,queued}) | 已派发→拒;agent→拒 |
| 交付(人工完成逃生口) | 仅 human | evidence.commit 或 links 至少一项 | 全缺→`evidence-missing` |
| 正向回写类(实施→测试 等) | F9 通道,**不走本 action** | — | **任何写入方**(含 human)经本 action 提交正向回写类目标→拒绝并指向 F9 证据驱动通道;唯一人工正向逃生口是 `target=交付`。仅回退类(高→低)允许人工带 reason 纠错,记 `transition.manual-override` |
| 回退类(高→低,人工纠错) | 仅 human | reason≥4 字 | 无 reason→schema 拒 |
| target==当前态 | 任意 | — | `{noop:true}`,零写入 |

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F3-01 | transition-guard 全矩阵(单测) | done 不可能未经评审写入(SDLC-058);全部非法迁移被拒 | `test.each` 枚举 actor{human,agent}×源态(7)×目标态(7)×证据{全/缺 commit/缺 verdict/空},对照上方矩阵逐格断言 allowedTransitions 与 assertTransition | 输出与矩阵完全一致;非法组合全部拒绝且 need 清单精确 |
| T-F3-02 | evidence-missing 结构化错误 | 前端可精确标红缺项(S4 契约) | `assertTransition(item,'done',human,{verdict:'PASSED'})`(缺 commit) | 抛 `{code:'evidence-missing', need:['commit']}` 恰好 |
| T-F3-03 | agent 写 done 机制拒绝(集成) | 红线机制化(SDLC-052/058) | 经 MCP 以 agent 身份调 transition-work-item target=done 带全证据 | 拒绝(actor 判定);audit 记拒绝尝试;状态不变 |
| T-F3-04 | complete-stage 拒写 done | 旧直写通道封死(B3 复发防) | 对「交付」阶段调 complete-stage(带 PASSED verdict);查 stage 行与 work_item.status | 阶段行照常 `stageStatus=已完成`,但**移除 `status=done` 副作用**——work_item.status 保持调用前值;返回体/提示指明 done 须经 transition-work-item(非抛错,是移除副作用) |
| T-F3-05 | 派发不推进(集成) | SDLC-063:推进只由证据驱动 | 派发测试工作项;立即查 current_stage_name 与 exec_state | 阶段与派发前完全一致;exec_state=='dispatched' |
| T-F3-06 | 派发失败零假进度(注入,分同步/异步两路) | SDLC-063 / B3 式失败不留假进度 | **同步路径(F3 现可测)**:注入 dispatch 同步报错(清空 project.gitRemote 或令 brain-send 不回 threadId),派发;**异步 brain 首轮零交付(400 端点,gated on F9)**:隔离窗口把 devModel 改为不存在模型名派发 | 同步:dispatch 抛错,exec_state **未被置 dispatched**(保持 null/queued)、业务阶段自始未动、无 orphan dispatched 态;异步:F9 落地后 exec_state 回 'queued'+activities 失败事件——**F3 单独交付期此半不作二值门,依赖 F9(见 §3A dispatch 项)** |
| T-F3-07 | update-work-item 拒 currentStageName | 旁路封死 | 调 update-work-item 带 currentStageName | schema 校验拒绝 |
| T-F3-08 | allowedTransitions 同源 | 前后端不漂移 | 同一 fixture 分别调 get-work-item 与 guard 纯函数 | 两者集合逐项相等(含 need 元数据) |
| T-F3-09 | closed 通道(未派发限定) | 手动关闭有通道有审计 | ①未派发项 human+reason→closed;②已派发项同调 | ①成功:closed_reason/closed_at 落列+audit 行+活动行;②拒绝 |
| T-F3-10 | noop 幂等 | 重复提交零副作用 | target==当前态连调两次 | `{noop:true}`;业务状态与活动流零变化(无新活动行)。**判据是状态/活动无副作用——框架对每次 mutation 自动留痕,noop 可能仍有一条审计记录,故不以"审计零行"为判据** |
| T-F3-11 | 人工纠错回退留痕 | 回退可用且与正向区分 | human+reason 调 target='实施'(自'测试') | 成功;活动行 `transition.manual-override` |
| T-F3-12 | tracker v24 迁移冒烟 | **B5 教训成文:内存库自建 schema 不算建表证据** | 一次性真 Postgres 空库顺序跑 v1…v24 全部迁移 | exec_state/closed_reason/closed_at 三列存在;并全量断言 schema.ts 声明的所有表存在 |
| T-F3-13 | audit 落库 | 谁改的状态可追溯 | 任一成功 transition 后按 `action='transition-work-item'` 且 `targetId=工作项 id` 过滤查框架 audit_log(**前置:action 须声明 `audit.target={type:'work-item', id}`,否则 targetId 落 null 而本断言恒红**) | 恰一行:actorKind=human、actorEmail=JWT 用户、action=transition-work-item、targetId=工作项 id、input(脱敏)含 reason |
| T-F3-14 | S4 对话框交互(UI,两阶段) | 人工流转 UI 一等化(簇六) | **阶段 A(原型,即刻可跑)**:Playwright file:// 开 s4 原型,断言 verdict 分支显隐/证据置灰→补全解锁/CHANGES_REQUESTED 按钮文案;**阶段 B(真实页面,F3 前端部署后)**:登录态开真实工作项——断言选项集==get-work-item.allowedTransitions、缺证据→红边+提示条不关框、服务端拒绝→回滚+toast+保留已填、成功→PropRow 更新+活动流新行 | 各断言逐项通过;阶段 B 全绿才算 F3 前端 DoD |
| T-F3-15 | 并发流转竞态(集成) | 守卫在并发下无丢更新(并发流转竞态) | 对同处某源态的工作项并发发两条 transition(如同时 target=done 与回退 target='实施'),二者读到同一源态快照 | 恰一条成功落库;另一条因源态已变被拒(或以带 WHERE 源态的 CAS 写实现,后到者观测 0 行更新→结构化冲突);终态唯一且等于胜出方,无两写叠加 |
| T-F3-16 | complete-stage verdict.result 必填枚举(单测) | verdict 语义收紧(B3 相邻洞) | 调 complete-stage 缺 result 或传非枚举值;再传合法枚举 | 缺/非法→schema 拒;合法→通过;与「交付阶段仍不写 done」并存(承接 T-F3-04) |
| T-F3-17 | get-activity 轮询回写不落 done(单测) | 最后一条未守卫直写 done 通道封死(SDLC-058;独立评审发现:轮询回写在 slot 报 done 或解析到交付 PR 时直写 status='done') | ①deriveItemStatus 全枚举 slot{running,queued,done,failed,cancelled,null}×delivery{有,无}×recovery{强,弱},断言任何组合都不返回 'done';②deriveWritebackStage 纯函数:returned+强交付→验收、returned 无强交付→测试、非 returned→null,任何输入都不产出 交付/done | ①恒不等于 'done'(终态成功派生 'returned');②阶段封顶「验收」,已在验收/交付的不动、绝不回退 |
| T-F3-18 | advance-stage 终段不落 done + actor 真实(集成) | 推进通道封顶验收(02 §8:任意→交付 仅人经 transition-work-item);活动 actor 徽标可信(独立评审发现:isFinalDelivery 直写 done + actorKind 硬编码 'human') | ①自「验收」(或自定义 plannedStages 以交付收尾,如 实施→交付 文档任务)调 advance-stage;②以 caller='tool'(agent)与 caller='frontend'(human)各推进一次常规段(实施→测试),查活动行 actorKind | ①guarded noop(reason='delivery-guarded'),status/currentStageName 均不变、零活动行、无 done;常规推进 status 写 'running' 绝不写 done;②活动行 actorKind 分别=='agent'/'human',不再恒为 human |
| T-F3-19 | bulk-dispatch 不推阶段(集成) | SDLC-063 批量路径回归锁(独立评审发现:bulk 与单 dispatch 分叉,批量仍派发即推进) | mock brain-send 后批量派发 待办/设计/实施 各态工作项;查 current_stage_name、exec_state 与 stages 表 | 各项 currentStageName 与派发前完全一致;exec_state=='dispatched';无实施 stage 行被 upsert;返回体无 stagedAdvanced;失败项(无 threadId)exec_state/阶段均不动 |

**测试环境与工具(F3)**:单测=vitest(guard 纯函数全矩阵);action 集成=
内存 libsql 可用于逻辑,但 **T-F3-12 必须真 Postgres 空库**;注入=隔离
窗口;UI=Playwright(阶段 A 原型 file://,阶段 B 登录态)。

### 6.4 F4 能力面矩阵 + 评审分离(T-F4-01 … T-F4-10)

| 编号 | 测什么 | 目标 | 如何验证 | 预期结果 |
|---|---|---|---|---|
| T-F4-01 | dispatch 相位工具面(单测) | brain 不再自带写工具(SDLC-052) | brain-session argv 构造函数 phase='dispatch' | allowedTools 恰为 mcp__orchestrator+Read/Grep/Glob;无 Bash/Write/Edit |
| T-F4-02 | 评审相位写被机制拒(集成) | 红线机制化(路线图 F4 验收①) | 隔离窗口触发评审相位会话;系统消息诱导"补一个换行到源文件" | **主判据(确定性):workspace 源文件内容与 mtime 逐一不变**;评审会话工具面无 Bash/Write/Edit,模型无写工具可调用("诱导写"是弱刺激,判据落在文件未变而非某条错误串) |
| T-F4-03 | capability_profile 装配生效 | 能力面=配置非硬编码 | 隔离库改 agent defs 的 capability_profile(增删某工具)后起新会话 | argv 跟随配置变化,零代码改动 |
| T-F4-04 | spec/评审线程分离(结构性) | 自审盲区破除(簇八,验收②) | 隔离窗口完整跑一单;查 v3_runs.tags 与 brain_threads | specThreadId 与 reviewThreadId 均存在且不等;评审唤醒新建了 bt_ 线程 |
| T-F4-05 | runVerdict 落 run 证据 | 评审结论进 run 级证据轨(SDLC-055) | 评审线程调 `runVerdict({runId, verdict:'PASSED', findings})` | v3_runs.tags.verdict 写入;v3_events 有 `review.verdict`;tracker 评审卡可读取 |
| T-F4-06 | 越界写尝试留痕可见(需引擎侧落事件) | 发生即可见(P13 兜底) | 承接 T-F4-02;查**引擎侧持久 sink**(spawn_events 的 `tool.denied` 行 / 评审会话 tool journal)。**注:框架 audit-log 只覆盖 defineAction 面,harness 工具拒绝不入 audit_log——故 §4A 须补一条"评审相位被拒工具尝试落 spawn_events"改动方可观测;若缺=覆盖缺口须补** | spawn_events(或 tool journal)出现被拒工具尝试记录(线程 id/工具名/时间);S7 可见告警标记 |
| T-F4-07 | agent defs 迁移冒烟 | capability_profile 列真实建立 | 靶位库跑 orchestrator 迁移 | **◐ 部署窗口留证**:committed 证据仅为**源码文本锁**(f4-migration.spec.ts 断言命名迁移 `f4-capability-matrix` + `kind`/`capability_profile`/`brain_threads.phase` 三列 DDL 与 schema 声明一致)——按 B5 纪律,文本锁不构成建表证据;真 PG16 空库全量迁移冒烟为一次性本地验证(已过、幂等),但**未留可复现 artifact,延 101 部署窗口复跑留证**。实现列为 `TEXT` 存 JSON(非原生 JSONB,随框架 dialect-agnostic schema 助手) |
| T-F4-08 | 分离/verdict 徽标(UI) | 评审未分离发生即可见 | Playwright:隔离数据构造 spec==review 的 run 与带 PASSED verdict 的 run,各开 S7;开 S9 | 前者显示 st-icon warn「评审未分离」;后者 verdict 徽标+findings 折叠;S9 渲染能力面只读矩阵 |
| T-F4-09 | review 相位工具面(单测) | 评审相位写工具机制性缺席——结构性可判(补 T-F4-01 只覆盖 dispatch,评审相位此前仅靠脆弱集成 T-F4-02) | brain-session argv 构造函数 phase='review' | allowedTools 恰为 mcp__orchestrator+Read/Grep/Glob(+workspace 只读语义);无 Bash/Write/Edit,与 T-F4-02 运行期一致且确定性可判 |
| T-F4-10 | runVerdict CHANGES_REQUESTED 出口唯一(集成) | 评审发现问题只能经 workflowRun fix 模式(SDLC-052 收口) | 评审线程调 `runVerdict({verdict:'CHANGES_REQUESTED', findings})`;观察其可用出口 | v3_runs.tags.verdict=CHANGES_REQUESTED + `review.verdict` 事件;评审会话无直改 tracker 状态、无写工具,唯一修复出口=workflowRun(fix 模式携 findings);该 verdict 供 tracker 评审卡「驳回」态读取 |

**测试环境与工具(F4)**:单测=vitest(argv 装配纯函数);集成=101 隔离
窗口(评审会话实测,brain API key 前置);DB=psql 只读断言;UI=Playwright
登录态。

### 6.5 覆盖对账(改动项 ↔ 用例,零遗漏)

| 改动项(A/B/C 节) | 覆盖用例 |
|---|---|
| F1 v3-workspace-local(断言序列/refreshMirror/resolveDiffBase) | T-F1-01…05、07、15、16 |
| F1 engine/v3-workspace 失败语义 | T-F1-08 |
| F1 v3-workspace-provision(W2/W3) | T-F1-06、07 |
| F1 v3-dispatcher 拒派 | T-F1-09 |
| F1 workspace-diff action(base/baseSource+错误) | T-F1-10、11 |
| F1 staleness 事件 | T-F1-12(**本轮延后未执行,剩余项**——见 §1A) |
| F1 迁移 +3 列 / S7 UI | T-F1-13 / T-F1-14(**S7 UI 本轮延后未执行,剩余项**) |
| F2 engine-loop(wrapper/threadId/压缩/续传) | T-F2-02…05、08、13 |
| F2 dispatcher 重试注入(**F2b 已交付**) | T-F2-06 |
| F2 context-checkpoint.ts | T-F2-01、07 |
| F2 32k+clamp 回归 / 端到端 | T-F2-08、09 / T-F2-10 |
| F2 迁移 +1 列 / S7 UI | T-F2-11 / T-F2-12 |
| F3 transition-guard(含 done 源态约束) | T-F3-01、02、08 |
| F3 transition-work-item(含并发竞态、CHANGES_REQUESTED 重定向限定) | T-F3-03、09、10、11、13、15 |
| F3 complete-stage 收紧(去 done + result 枚举) | T-F3-04、16 |
| F3 dispatch 不推进+回退 | T-F3-05、06 |
| F3 update-work-item 拒旁路 / get-work-item 同源 | T-F3-07 / T-F3-08 |
| F3 v24 迁移 / S4 对话框 | T-F3-12 / T-F3-14 |
| F3 get-activity 回写封顶(returned + 阶段≤验收) | T-F3-17 |
| F3 advance-stage 终段守卫 + actor 真实 | T-F3-18 |
| F3 bulk-dispatch 不推阶段 | T-F3-19 |
| F4 brain-session 相位工具面(dispatch+review 双相 argv) | T-F4-01、02、09 |
| F4 monitor 评审唤醒+线程分离 | T-F4-04 |
| F4 capability_profile 配置面+迁移 | T-F4-03、07 |
| F4 runVerdict 工具(PASSED+CHANGES_REQUESTED) / 越界留痕 | T-F4-05、10 / T-F4-06 |
| F4 S7/S5 徽标+S9 矩阵 | T-F4-08 |

合计 **58 条用例**(F1=16、F2=13、F3=19、F4=10);上表逐行对账 §1–§4 全部
改动项(文件/迁移/UI),**无一改动项无用例**。(独立评审新增 7 条:T-F1-15/16、
T-F2-13、T-F3-15/16、T-F4-09/10——补 against 显式基线、refreshMirror 超时、
压缩失败吞错、并发竞态、verdict.result 枚举、review 相位 argv、CHANGES_REQUESTED
出口唯一;另修订 T-F1-02/05/07/11、T-F2-03、T-F3-04/06/10/13、T-F4-02/06 的
注入法与判据,详见评审记录。F3 实施评审再新增 3 条:T-F3-17/18/19——封死
get-activity 轮询回写、advance-stage 终段、bulk-dispatch 批量派发三条残留
未守卫直写通道;并修订 T-F3-01 守卫矩阵 done 行(源态==待人工评审 约束,以
02 §8 为准)与 §3A 文件清单(6→9 个文件)。)
