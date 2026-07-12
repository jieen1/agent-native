<callout color="blue_bg">
	本文档是《SDLC 实施路线图(落地版)》§1 地基 **F1–F4** 四项的实施细化:纲(五段式)在路线图,目(文件级改动、action schema 字段级签名、控件级交互)在这里。设计权威:02 章 §7/§4.1/§8/§5.4/§3,03 章收件箱评审卡与 InspectorPanel 受守卫流转。所有改动落在 **dogfood 交付主干**,依赖 F0 先行。迁移号基准:tracker db.ts 当前顶格 v23(B5),新迁移从 **v24** 起。
</callout>

<callout color="orange_bg">
	三个已实证的现状事实贯穿本方案,实施时不得绕过:① V3 spawn 是进程内游离 promise、无 PID/句柄(F2 续传不得预设 kill 能力);② resolveDiffBase 沿 origin/main→master→HEAD~1→空树静默回退(F1/W4 真病根);③ tracker update-work-item 无守卫直写 currentStageName、complete-stage 无 verdict 直写 done、brain argv Bash/Read/Edit/Write 全开(F3/F4 现状)。
</callout>

## 1. F1 工作区契约 W1–W4

### 1A. 后端实施

改动文件清单(orchestrator,5 个文件):

<table header-row="true">
<tr>
<td>文件</td>
<td>改动</td>
</tr>
<tr>
<td>server/v3-workspace-local.ts</td>
<td>克隆/worktree 完成后立即执行就绪断言序列;新增 assertWorkspaceReady 与 refreshMirror(git fetch --prune 到 bare 镜像);resolveDiffBase 按 W4 重写</td>
</tr>
<tr>
<td>server/engine/v3-workspace.ts</td>
<td>createWorkspace 在 provision 后调用就绪断言;失败→workspace 行 state=failed + 抛 WorkspaceNotReadyError(错误分类 infra,不记 agent 失败,run 不开)</td>
</tr>
<tr>
<td>server/v3-workspace-provision.ts(新)</td>
<td>W2/W3 供给管道:pnpm install --prefer-offline(共享 store $ORCH_PNPM_STORE,硬链秒级)+ test_cmd_smoke 探测</td>
</tr>
<tr>
<td>server/engine/v3-dispatcher.ts</td>
<td>派发前 workspace 行无 ready_at → 拒派并发 workspace.not_ready 事件</td>
</tr>
<tr>
<td>actions/workspace-diff.ts</td>
<td>返回体增加 base 与 baseSource 字段透传(前端显示基线来源)</td>
</tr>
</table>

就绪断言序列(W1→W2→W3 顺序,全过才写 ready_at):

<table header-row="true">
<tr>
<td>断言</td>
<td>执行</td>
<td>失败语义</td>
</tr>
<tr>
<td>W1 基线新鲜</td>
<td>refreshMirror → 工作区 git fetch origin → 断言 merge-base(HEAD, origin/目标分支)==origin/目标分支 tip(距离 0);不满足对 worktree 隔离 reset --hard 后重断言</td>
<td>二次失败 = WorkspaceNotReadyError(W1)</td>
</tr>
<tr>
<td>W2 依赖预热</td>
<td>node_modules/.bin 存在且 pnpm exec vitest --version 退出码 0;否则供给管道安装后再验</td>
<td>WorkspaceNotReadyError(W2)</td>
</tr>
<tr>
<td>W3 测试可执行</td>
<td>test_cmd_smoke(默认 vitest run --passWithNoTests,项目设置可覆盖)超时 120s</td>
<td>非零退出 = WorkspaceNotReadyError(W3)</td>
</tr>
</table>

W4:resolveDiffBase 重写——调用时 refreshMirror + fetch,取 `merge-base(origin/目标分支, HEAD)`;不可得抛 DiffBaseUnresolvableError,调用方(workspaceDiff / runSummary diff 统计)返回显式错误、**不返回任何 diff 统计**;禁止旧的 origin/main→master→HEAD~1→空树静默回退链。`against` 显式参数仍允许,返回体回显 baseSource=explicit。

staleness 事件(设计——本轮未落地):reconciler tick 内对 running run 比对镜像目标分支 tip 与建区 base_sha,前进即发一次性 workspace.stale 事件(v3_events 查重幂等),brain 唤醒消息附带。状态:T-F1-12,本轮实施未做,见下方「F1 剩余项」。

**测试**:见 §6.1(T-F1-01…T-F1-16,单一维护处;原零散 DoD 已并入;T-F1-12/T-F1-14 本轮延后,见下方「F1 剩余项」)。

<callout color="red_bg">
	<strong>F1 剩余项(未随本轮落地,标注供跟踪——信任跨越目标分支前进的长命 run 之前必须先补)</strong><br/>
	• <strong>T-F1-12 · workspace.stale 存续期事件</strong>(reconciler tick 对 running run 的漂移检测)——不在 v3-workspace-local.ts 的文件边界内,本轮未实现(v3-workspace-local.spec.ts 顶部注释、F1 提交说明均如实标注为延后)。<br/>
	• <strong>交付时新鲜度断言</strong>——assertW1BaselineFresh(W1)只在 createLocalWorkspace 建区时跑一次;F1 代码里不存在任何"提交/推送/开 PR 之前重新断言 merge-base==目标分支 tip"的门。W4(resolveDiffBase)保证的是"diff 基线在调用时恒正确或显式报错",不等于"工作区没有落后于目标分支"。若确有一道交付前 merge-base==tip 的断言,那是 merge-pr 的 brain/DAG 机制在把关,不属于 F1 这几个文件。<br/>
	• 结论:跨越目标分支前进的长命 run 期间,workspace 与目标分支之间存在一个有界但目前不可观测的漂移窗口(B2)——F1 只保证①建区时基线新鲜、②W4 diff 观测恒正确;这个窗口靠 merge-pr 交付时的最终断言兜底,而非本轮新增的任何机制。上面的 staleness 事件与真正的交付时新鲜度门仍是待办。
</callout>

### 1B. 前端实施(S7 运行详情,可选增强——T-F1-14,本轮未做)

<callout color="orange_bg">
	本节整节依赖 workspace.stale 事件(T-F1-12),而该事件本轮未实现(见 1A 末尾「F1 剩余项」)。以下为该事件补齐后的前端规格,不代表当前已有任何交付时校验——文案不得暗示存在自动 rebase 或交付时强制门,那是 merge-pr 的 brain/DAG 职责,不是这条提示条的行为。
</callout>

<table header-row="true">
<tr>
<td>控件</td>
<td>规格</td>
</tr>
<tr>
<td>staleness 提示条</td>
<td>页头下方;条件=run 事件含 workspace.stale 且 run 非终态;warning 15% 底色横条(禁左侧竖条);文案「工作区基线落后于分支 tip(领先 N 提交)——交付前请重建工作区或确认 merge-pr 的基线校验已覆盖」;右侧 ghost 按钮「重建工作区」(确认 Dialog;有 running 节点时置灰+tooltip)</td>
</tr>
<tr>
<td>就绪徽标</td>
<td>侧栏工作区行:ready_at 存在→st-icon ok+「就绪(W1–W3)」;state=failed→st-icon err+失败 W 编号,点击展开断言输出 EvidenceCard</td>
</tr>
<tr>
<td>diff 基线来源</td>
<td>diff 统计标题行显示 baseSource(mono 小字);diff-base-unresolvable→EmptyState「diff 基线不可解析」+错误详情折叠,不渲染文件列表</td>
</tr>
</table>

### 1C. 数据与迁移(orchestrator v3,加性)

v3_workspaces 加列:base_sha TEXT(建区时目标分支 tip)、ready_at TIMESTAMP、ready_report JSONB(W1–W3 断言输出摘要)。

### 1D. 顺序与依赖

依赖 F0。内部:W4(独立可先发,B4 病根)→ W1 → W2/W3 供给管道 → staleness 事件(T-F1-12,本轮未排上,列为剩余项——见 1A 末尾)。F2 验收踩 W2/W3。

## 2. F2 执行器上下文管理(调研结论 B)

### 2A. 后端实施(orchestrator,core 零改动)

<table header-row="true">
<tr>
<td>文件</td>
<td>改动</td>
</tr>
<tr>
<td>server/runtime/executors/engine-loop.ts</td>
<td>①调用改经 runAgentLoopDirectWithSoftTimeout(core 既有导出,usage 返回形状不变);②opts 增 threadId=spawn:{spawnId}(前缀防撞 chat 线程)+ ownerEmail/orgId——激活 OM 消费/tool journal/context-xray;③send sink 累计 tool_result 体量,超 ORCH_DEV_COMPACT_THRESHOLD_TOKENS(默认 70000)fire-and-forget maybeCompactThread;④isResumableEngineError→appendAgentLoopContinuation 续传,spawn_events 记 context.compacted / loop.resumed</td>
</tr>
<tr>
<td>server/engine/v3-dispatcher.ts(→ F2b 后续切片)</td>
<td>attempt 重试:上一 attempt 溢出终止且有续传检查点→buildPrompt 注入「已完成产物清单+剩余任务」段(C3,禁止从零重跑)。F2 首切片实施期 v3-dispatcher 明令禁碰(F1/F4 并行防冲突),checkpoint 消费端(重试注入)整体改判入 F2b;当前 checkpoint 为只写</td>
</tr>
<tr>
<td>server/runtime/executors/context-checkpoint.ts(新,约 80 行)</td>
<td>从 send 流增量提取已写文件清单(edit/write 成功记录),spawn 终止落 v3_spawns.context_checkpoint;供 dispatcher 重试注入</td>
</tr>
</table>

配置:ORCH_DEV_COMPACT_THRESHOLD_TOKENS(默认 70000)、ORCH_DEV_MAX_OUTPUT_TOKENS(既有 32k)。OM 内部 LLM 走 resolveEngine 注册表默认(101=本地 vLLM);observational_memory 表懒建无迁移。**不预设 kill 能力**:续传触发仅为引擎可续错误与进程重启后 reconcile(F10 范畴)。

幂等与失败:maybeCompactThread 失败仅日志(压缩是优化非正确性前提);续传的已完成写由 tool journal 防重放;context_checkpoint 只增不改。

**部署验证注记**:F2 依赖本分支的 db 合并血缘(getV3Db/v3Schema/migrateV3 在 origin/main 不存在),**不可单独 cherry-pick**,须与本分支整体部署;T-F2-11 的真 Postgres 验证在部署窗口执行。

**测试**:见 §6.2(T-F2-01…T-F2-13;原零散 DoD 已并入)。

### 2B. 前端实施(S7 转录视图,轻量)

Observational Memory 注入块渲染为折叠段(TimelineCollapse 语汇,ti-stack-2 图标+「上下文已压缩(N 步→摘要)」);context.compacted / loop.resumed 在节点时间线显示 st-icon inf 行。无新页面、无新弹窗。

### 2C. 数据与迁移

v3_spawns 加列:context_checkpoint JSONB。

### 2D. 顺序与依赖

依赖 F0(先吸收 32k 修复)。②③④可并行;④依赖 2C 列。F4 评审会话复用本项 threadId 机制。

## 3. F3 状态迁移守卫 + 派发不推进 + 人工流转通道(重头)

### 3A. 后端实施(tracker,dogfood 主干)

<table header-row="true">
<tr>
<td>文件</td>
<td>改动</td>
</tr>
<tr>
<td>actions/transition-work-item.ts(新)</td>
<td>受守卫人工流转/关闭唯一写入口:守卫判定(目标状态×写入方身份×证据载荷)→写 status/current_stage_name/回链列→activities 行+框架 audit-log 自动审计</td>
</tr>
<tr>
<td>server/lib/transition-guard.ts(新)</td>
<td>守卫表纯函数:allowedTransitions(item, actor) 返回合法目标集(action 与前端同源);assertTransition 缺证据抛结构化错误 {code:evidence-missing, need:[...]}</td>
</tr>
<tr>
<td>actions/complete-stage.ts</td>
<td>移除「交付」阶段直写 status=done 路径;verdict.result 必填枚举;done 一律拒绝并在错误信息中指向 transition-work-item</td>
</tr>
<tr>
<td>actions/dispatch-to-orchestrator.ts</td>
<td>派发不推进:删除 currentStageName 推进与 stagedAdvanced;改写 exec_state=dispatched(新列);brain 首轮零交付→exec_state 回 queued+activities 失败事件(F9 前由同步错误路径先覆盖同步失败场景)</td>
</tr>
<tr>
<td>actions/update-work-item.ts</td>
<td>schema 删除 currentStageName(阶段一律走守卫),保留纯元数据字段</td>
</tr>
<tr>
<td>actions/get-work-item.ts</td>
<td>返回体加 execState 与 allowedTransitions(前端对话框选项直接消费,前后端同源)</td>
</tr>
<tr>
<td>actions/get-activity.ts(F3 实施评审补充)</td>
<td>轮询回写封顶:deriveItemStatus 的 slot 终态成功/交付 PR 一律派生 returned(新状态词,run 已回、待评审),绝不派生 done;阶段推进封顶「验收」(强交付→验收、否则→测试,纯函数 deriveWritebackStage),并回写 exec_state=returned</td>
</tr>
<tr>
<td>actions/advance-stage.ts(F3 实施评审补充)</td>
<td>回写/推进通道封顶「验收」:推进入「交付」一律 guarded noop(reason=delivery-guarded,指向 transition-work-item);移除 isFinalDelivery→status=done 副作用;活动行 actorKind 取真实 actor(actorFromCaller),不再硬编码 human</td>
</tr>
<tr>
<td>actions/bulk-dispatch-to-orchestrator.ts(F3 实施评审补充)</td>
<td>与单 dispatch 完全同法:删除批量路径的 currentStageName 推进与实施 stage upsert,写 exec_state=dispatched(批量与单件分叉=SDLC-063 在批量侧重开)</td>
</tr>
</table>

transition-work-item schema(字段级):id(必填)· target(枚举:待办|实施|测试|待人工评审|交付|done|closed)· reason(必填 ≥4 字)· verdict(PASSED|CHANGES_REQUESTED,target=done 必填 PASSED)· evidence 对象(runId / branch / commit / deliveryItems[] / links[],按守卫表行必填)。

守卫判定核心规则(与 02 §8 一一对应):

<table header-row="true">
<tr>
<td>目标</td>
<td>规则</td>
</tr>
<tr>
<td>done</td>
<td>仅人(JWT,actorKind=human)且**仅源态==待人工评审(验收)**且 verdict=PASSED 且 evidence.commit 存在;agent 一律拒绝(actor 检查先于源态:agent 得 actor-denied,human 自其他源态得 invalid-source-state);CHANGES_REQUESTED 重定向(done→回退实施)仅在源态==待人工评审时生效,其他源态发 done+CHANGES_REQUESTED 不重定向、按 done 拒绝零写入</td>
</tr>
<tr>
<td>closed</td>
<td>仅人、仅未派发项(exec_state 为空或 queued)、reason 必填</td>
</tr>
<tr>
<td>交付(人工完成逃生口)</td>
<td>仅人 + evidence.commit 或 links 至少一项</td>
</tr>
<tr>
<td>回写类迁移(实施→测试等)</td>
<td>不走本 action(F9 通道);本 action 仅允许人工带 reason 纠错回退,写 transition.manual-override 活动行</td>
</tr>
<tr>
<td>幂等</td>
<td>target==当前状态 → no-op 返回 {noop:true}</td>
</tr>
<tr>
<td>CAS 写</td>
<td>UPDATE 的 WHERE 完整复述守卫评估快照三轴(status+current_stage_name+exec_state)——exec_state 轴防 F9 落地后「读到未派发→守卫放行 closed→写前被派发」的 TOCTOU 漏判</td>
</tr>
</table>

**测试**:见 §6.3(T-F3-01…T-F3-19,含守卫全矩阵表;原零散 DoD 已并入)。

### 3B. 前端实施(S4 受守卫流转对话框,完整交互规格)

入口:InspectorPanel「状态」PropRow 整行可点击(hover 背景 --muted,行尾 ti-shield-lock 常驻)。点击打开 GuardedTransitionDialog(shadcn Dialog,宽 440px,禁浏览器 confirm)。

<table header-row="true">
<tr>
<td>控件</td>
<td>规格</td>
</tr>
<tr>
<td>标题</td>
<td>「变更状态 · itemKey」;副标题当前状态徽标(st-icon+文案)</td>
</tr>
<tr>
<td>目标状态 Select</td>
<td>选项=get-work-item.allowedTransitions(服务端同源,前端不复刻守卫表);每项右侧灰字要求摘要(如 done:「需 PASSED verdict + 合并 commit」);空集→Select 禁用+行内说明「当前状态没有你可执行的人工迁移」</td>
</tr>
<tr>
<td>原因 Textarea</td>
<td>必填 ≥4 字,placeholder「为什么人工变更?写入审计与活动流」;实时校验,未过提交置灰</td>
</tr>
<tr>
<td>verdict 段(target=done 时渲染)</td>
<td>RadioGroup:PASSED / CHANGES_REQUESTED;选 CHANGES_REQUESTED 时提交按钮变「驳回并要求返工」且不写 done(等价评审驳回,回「实施」)</td>
</tr>
<tr>
<td>证据段(按 need 装配)</td>
<td>合并 commit Input(mono,7-40 位 hex 校验)· 关联 run Select(历史 run,可空)· 交付物列表编辑器(Input+添加,行可删,≥1 有效)· 链接同款</td>
</tr>
<tr>
<td>缺口提示</td>
<td>服务端 evidence-missing → 对应控件红边 + 底部 destructive 15% 提示条列缺项(不关对话框)</td>
</tr>
<tr>
<td>closed 分支</td>
<td>未派发项选 closed:证据段隐藏、仅 reason;提示「关闭后可在已关闭过滤找回」</td>
</tr>
<tr>
<td>操作行</td>
<td>取消(ghost)/确认变更(primary,全部必填有效才可用);提交中 spinner+置灰防重复</td>
</tr>
</table>

提交行为:useActionMutation(transition-work-item);乐观更新(PropRow 立即换目标态+关对话框)→失败回滚+toast(含守卫拒因)+重开对话框保留已填;成功 toast+活动流乐观插入 transition.manual 行。审计回读:活动时间线渲染 transition.manual(human 徽标、reason 引用块、证据 chips)。权限:allowedTransitions 服务端按身份计算(agent 得空集)。原型:s4-work-item.html 已补入本对话框(Alpine 演示显隐与置灰逻辑)。

### 3C. 数据与迁移(tracker,加性,v24)

tracker_work_items 加列:exec_state TEXT(null|queued|dispatched|running|returned)、closed_reason TEXT、closed_at TEXT。verdict/证据不落新表(stage 行既有 verdict 字段+活动流 payload;审计走框架 audit-log)。

### 3D. 顺序与依赖

依赖 F0;与 F9 配对(回写类迁移的自动运载在 F9,本项先立"人工与守卫",done 通道即刻收紧先堵最大洞)。内部:guard 纯函数+单测 → action → dispatch 不推进(v24 先行)→ complete-stage 收紧 → get-work-item → S4 对话框。

## 4. F4 能力面矩阵(评审只读)+ spec/评审分离

### 4A. 后端实施(orchestrator)

<table header-row="true">
<tr>
<td>文件</td>
<td>改动</td>
</tr>
<tr>
<td>server/brain/brain-session.ts</td>
<td>argv 工具面按相位装配(新增 phase 参数):dispatch 相位 --allowedTools mcp__orchestrator Read Grep Glob(移除 Bash/Write/Edit);review 相位同 dispatch,workspace 访问只读</td>
</tr>
<tr>
<td>server/brain/brain-monitor.ts</td>
<td>run 终态唤醒标注 phase=review;评审发现问题唯一出口=workflowRun fix 模式(携带评审发现清单);提示词同步改,约束以工具面为准</td>
</tr>
<tr>
<td>workspace 只读(首版方案)</td>
<td>评审相位不给 workspace 写路径,文件读取与 diff 全部经 MCP 工具(workspaceDiff/workspaceRead)——零挂载改造,机制=工具面裁剪;只读 bind mount 留作后备方案</td>
</tr>
<tr>
<td>server/engine/v3-dispatcher.ts + agent defs(SQL)</td>
<td>评审独立性:run 终态唤醒强制新 brain 线程 B(不 resume spec 作者线程 A);v3_runs.tags 记 specThreadId/reviewThreadId;agent defs 加 capability_profile JSONB({phase:{tools,workspaceAccess}}),brain-session 与执行器从此读装配</td>
</tr>
</table>

verdict 落 run 证据:新 MCP 工具 runVerdict({runId, verdict, findings})→写 v3_runs.tags.verdict + run 事件 review.verdict;tracker 评审卡与回链读取此处(不再只在 brain 转录)。

**测试**:见 §6.4(T-F4-01…T-F4-08;原零散 DoD 已并入)。独立复核抓 spec 内嵌缺陷作辅助质量信号,不作二值门。

### 4B. 前端实施(两处,轻量)

<table header-row="true">
<tr>
<td>页面</td>
<td>改动</td>
</tr>
<tr>
<td>S7 运行详情 / S5 评审卡</td>
<td>评审会话徽标(reviewer chip+bt_xxxx mono)与 spec 会话徽标并排;二者相同时显示 st-icon warn「评审未分离」(发生即可见);verdict 徽标 PASSED(ok)/CHANGES_REQUESTED(err)+findings 折叠列表</td>
</tr>
<tr>
<td>S9 Brain 控制台</td>
<td>能力面矩阵只读简表(角色×相位×工具面×workspace 权限,数据源 capability_profile;无编辑,编辑属阶段三)</td>
</tr>
</table>

### 4C. 数据与迁移

agent defs 表加列 capability_profile JSONB;v3_runs.tags 无 schema 变更(JSONB 内加 specThreadId/reviewThreadId/verdict 键)。

### 4D. 顺序与依赖

依赖 F0、F2。内部:capability_profile 数据面 → 相位工具面(先 dispatch 后 review)→ 评审新线程分离 → runVerdict → 前端徽标。F3 评审卡「批准合并」按钮消费本项 verdict(F4 前可暂读 stage verdict)。

## 5. 全局实施顺序(F1–F4 合并视图)

```
F0(交付主干统一)
 ├─ F1.W4 diff 基线(独立先发,B4 病根)
 ├─ F3.v24 列 + transition-guard + action     ← 四线并行
 ├─ F2.threadId/压缩/续传
 └─ F1.W1-W3 供给管道
        ↓
 F4(依赖 F2 会话形态;评审只读 + 分离 + runVerdict)
        ↓
 前端批次:S4 对话框 / S7 徽标与提示条 / S5 评审卡 verdict 接线
        ↓
 §1.12 验收门:故障注入逐条(F1①–④、F2 断流、F3 三连、F4 ①②③)
```

<callout color="green_bg">
	关键里程碑判定:F3 的 done 收紧一经部署,B3 式「未评审即 done」立即不可能——建议 F3 后端(含 v24)作为第一个部署批次,不等 F1/F2/F4 齐活。
</callout>

## 6. 测试规格(F1–F4 全量)

<callout color="blue_bg">
	每条用例五字段:**编号 / 测什么 / 目标**(防住哪个真实失效,引用实战 issue)/ **如何验证**(前置→执行→观察点;注入类写明具体注入法)/ **预期结果**(无歧义可判定断言)。各 F 的 A 节测试点已并入本节,单一维护处。破坏性注入一律在**隔离靶位**执行(路线图 §1.12 前置:一次性 Postgres 临时库、一次性镜像与工作区目录、维护窗口、brain 以 API key 运行),禁打生产共享资源。注入法只用已实证可行的手段:**没有 kill spawn**(spawn 无句柄,R3 实证)——进程级中断一律用「切断 vLLM 连接」或「维护窗口重启 orchestrator」。
</callout>

### 6.1 F1 工作区契约(T-F1-01 … T-F1-16)

<table header-row="true">
<tr>
<td>编号</td>
<td>测什么</td>
<td>目标</td>
<td>如何验证</td>
<td>预期结果</td>
</tr>
<tr>
<td>T-F1-01</td>
<td>resolveDiffBase 正常路径(单测)</td>
<td>W4 基线动态正确(SDLC-059)</td>
<td>fixture:mktemp 建 bare 镜像+克隆工作区,提交 2 个 commit;调 resolveDiffBase(dir, mirror, main)</td>
<td>返回 base==merge-base 真值;baseSource==merge-base(origin/main, HEAD)</td>
</tr>
<tr>
<td>T-F1-02</td>
<td>目标分支不可解析显式报错(单测+注入)</td>
<td>杜绝静默回退链(B4 假 diff 病根,SDLC-059)</td>
<td>注入:让镜像/远端不含目标分支(bare 镜像删 refs/heads/目标分支,或对不存在分支名调用)——使函数内 refreshMirror+fetch 无法拉回该 ref、merge-base 无 origin 侧解析;调 resolveDiffBase(dir, mirror, 缺失分支)。注:只删工作区本地 refs/remotes/origin/main 无效——新函数先 fetch 会把它自我修复,测不到错误路径</td>
<td>抛 DiffBaseUnresolvableError;绝不沿 origin/master→HEAD~1→空树回退</td>
</tr>
<tr>
<td>T-F1-03</td>
<td>无公共祖先显式报错(单测)</td>
<td>同上,orphan 分支场景</td>
<td>fixture:git checkout --orphan 分支提交后调用</td>
<td>抛 DiffBaseUnresolvableError</td>
</tr>
<tr>
<td>T-F1-04</td>
<td>refreshMirror 调用时刷新</td>
<td>禁静态基线:镜像滞后不得产生旧基线</td>
<td>fixture:上游推进 1 commit、镜像不 fetch;调 resolveDiffBase</td>
<td>函数内先刷镜像;返回 base 反映最新 tip 的 merge-base</td>
</tr>
<tr>
<td>T-F1-05</td>
<td>W1 基线新鲜断言(注入)</td>
<td>工作区不再基于过期基线(SDLC-056,B2 冲突根因)</td>
<td>隔离靶位:先 createWorkspace 建区(HEAD 落当前 tip C0,记 base_sha),再向共享镜像目标分支推进一格到 C1(制造建区后过期),随后对该工作区跑 assertWorkspaceReady</td>
<td>ready 时 merge-base 距离==0(W1 refreshMirror 后检出 C0<C1,隔离 reset --hard origin 到 C1 重断言通过);reset 关闭/失败则 WorkspaceNotReadyError(W1)——二者必居其一,绝无「带旧基线 ready」</td>
</tr>
<tr>
<td>T-F1-06</td>
<td>W2 依赖预热</td>
<td>dev 有测试执行环境(SDLC-057,B5 教训)</td>
<td>新建工作区内跑 pnpm exec vitest --version</td>
<td>退出码 0;供给耗时与结果落 ready_report</td>
</tr>
<tr>
<td>T-F1-07</td>
<td>W3 smoke 可执行+失败拦截(注入)</td>
<td>测试可执行是就绪门(B3 反证其可行)</td>
<td>正常建区看 ready_report;非空校验:靶位放一个必过样例测试、smoke 去掉 --passWithNoTests,确认真实用例被执行(排除空目录假绿);注入:项目设置把 test_cmd_smoke 改为 exit 1 再建区</td>
<td>正常:smoke 真实执行 ≥1 用例并通过才写 ready_at;注入:WorkspaceNotReadyError(W3),workspace state=failed</td>
</tr>
<tr>
<td>T-F1-08</td>
<td>就绪失败错误语义</td>
<td>环境故障不等于 agent 失败(infra 分类)</td>
<td>承接 T-F1-07 失败工作区,查 v3_events 与 spawn/node</td>
<td>事件 workspace.not_ready(kind=infra);零 spawn、node 不派发、无 agent 失败记账</td>
</tr>
<tr>
<td>T-F1-09</td>
<td>dispatcher 拒派未就绪工作区</td>
<td>就绪门不可绕过</td>
<td>隔离库将测试工作区 ready_at 置 NULL 后触发派发</td>
<td>拒派 + workspace.not_ready 事件;node 保持待派</td>
</tr>
<tr>
<td>T-F1-10</td>
<td>B4 假 diff 回归重放</td>
<td>workspaceDiff==真实改动(SDLC-059 回归锁)</td>
<td>工作区改 7 个文件;调 workspaceDiff;对照 git diff --stat 对 merge-base 的真值</td>
<td>文件数与增删行完全一致;返回体含 base+baseSource</td>
</tr>
<tr>
<td>T-F1-11</td>
<td>基线错误传播到 action</td>
<td>观测错=守门错,必须显式到达调用方</td>
<td>在 T-F1-02 注入态经 MCP 调 workspaceDiff;并对 runSummary 的 diff 统计路径同样注入调用(两个调用方都走 resolveDiffBase)</td>
<td>两条调用均返回 error=diff-base-unresolvable 与 detail,无任何 diff 统计字段</td>
</tr>
<tr>
<td>T-F1-12(本轮延后,未执行——见 §1A「F1 剩余项」)</td>
<td>staleness 事件幂等</td>
<td>基线漂移发生即可见且不刷屏</td>
<td>建区后镜像推进 1 commit;等 2 个 reconciler tick</td>
<td>v3_events 恰好 1 条 workspace.stale;brain 唤醒消息附带</td>
</tr>
<tr>
<td>T-F1-13</td>
<td>v3_workspaces 迁移冒烟</td>
<td>新列真实建列(B5 教训:空库实证)</td>
<td>一次性 Postgres 临时库跑全部 v3 迁移</td>
<td>base_sha/ready_at/ready_report 三列存在、类型正确</td>
</tr>
<tr>
<td>T-F1-14(本轮延后,未执行——依赖 T-F1-12,见 §1B)</td>
<td>S7 提示条/就绪徽标/基线来源(UI,可选)</td>
<td>状态发生即可见</td>
<td>Playwright 登录态打开含 stale 事件的 run 详情</td>
<td>提示条含领先提交数;就绪徽标 st-icon ok;diff 标题行显示 baseSource</td>
</tr>
<tr>
<td>T-F1-15</td>
<td>显式 against 参数基线来源(单测)</td>
<td>评审比对场景基线可信,against 不误入 merge-base 分支(W4)</td>
<td>调 resolveDiffBase/workspaceDiff 传显式 against=sha 或分支</td>
<td>返回 base==该 against 的解析值;baseSource==explicit;不触发 refreshMirror+merge-base 动态求解分支</td>
</tr>
<tr>
<td>T-F1-16</td>
<td>refreshMirror 超时归 infra(注入)</td>
<td>就绪期 git 网络故障归 infra 且不挂起建区(GIT_TIMEOUT_MS 生效)</td>
<td>隔离靶位把镜像 remote 指向不可达地址(或设极小 GIT_TIMEOUT_MS),createWorkspace 触发 refreshMirror</td>
<td>有界超时后抛 WorkspaceNotReadyError(kind=infra);createWorkspace 不无限挂起;零 spawn、node 不派发</td>
</tr>
</table>

**测试环境与工具(F1)**:单测=vitest+临时 git fixture(测试内自建 bare+clone);注入/集成=隔离靶位(一次性镜像与工作区目录,不触生产 /workspaces 池);迁移=**真 Postgres 临时库**(JSONB/TIMESTAMP 语义,内存 libsql 不适用);UI=Playwright(登录态 check-state.json 法)。

### 6.2 F2 执行器上下文管理(T-F2-01 … T-F2-13)

<table header-row="true">
<tr>
<td>编号</td>
<td>测什么</td>
<td>目标</td>
<td>如何验证</td>
<td>预期结果</td>
</tr>
<tr>
<td>T-F2-01</td>
<td>checkpoint 提取器(单测)</td>
<td>续传注入清单准确(C3)</td>
<td>构造 send 流样本(edit/write 成功与失败、bash 混杂)喂提取器</td>
<td>输出恰为成功写入的文件清单;失败写入不计</td>
</tr>
<tr>
<td>T-F2-02</td>
<td>压缩阈值计算(单测)</td>
<td>超阈值必触发、不足不触发</td>
<td>累计字符在 70k tokens×4 两侧各一样本(mock maybeCompactThread)</td>
<td>仅越界侧触发且恰一次</td>
</tr>
<tr>
<td>T-F2-03</td>
<td>threadId 传入激活 OM 通道(集成)</td>
<td>dev 循环挂上 OM/日志线程(簇十,M3-D 根因)</td>
<td>101 隔离窗口跑一轮 dev spawn;SQL 按 threadId 前缀查 observational_memory 表</td>
<td>observational_memory 出现 spawn: 前缀键行(证明 threadId 已透传并激活通道,确定性);压缩是否实际发生由 T-F2-10 端到端确证,本条只锁通道接通,不依赖单轮是否越阈值</td>
</tr>
<tr>
<td>T-F2-04</td>
<td>threadId 前缀防撞</td>
<td>spawn 记忆不污染 chat 线程</td>
<td>对照跑一轮 chat 会话;SQL 查 observational_memory 两类 threadId</td>
<td>spawn: 与 bt_ 前缀行互斥,无交叉读写</td>
</tr>
<tr>
<td>T-F2-05</td>
<td>断流续传(注入;禁 kill)</td>
<td>截断不从零重跑(C3;M3-D 三连溢出教训)</td>
<td>隔离窗口:dev spawn 运行中把 runtime_config baseUrl 临时指向不可达端口(或网络层阻断 :9000),随后恢复</td>
<td>isResumableEngineError 命中→续传;同一 spawn 续跑完成;spawn_events 有 loop.resumed;已写文件无重复写(journal 防重放)</td>
</tr>
<tr>
<td>T-F2-06</td>
<td>重启后 checkpoint 注入(注入)【未覆盖——checkpoint 消费端(dispatcher 重试注入)属 F2b 后续切片,当前 checkpoint 为只写】</td>
<td>进程级中断不归零(用重启法,不预设 kill)</td>
<td>维护窗口:dev spawn 运行中重启 orchestrator;reconcile 重置后查新 attempt 的 rendered_prompt</td>
<td>prompt 含「已完成产物清单+剩余任务」段;不重复实现已完成文件(F2b 交付后验收)</td>
</tr>
<tr>
<td>T-F2-07</td>
<td>checkpoint 落盘与只增</td>
<td>断点数据可靠</td>
<td>spawn 正常完成/异常终止两态查 v3_spawns.context_checkpoint</td>
<td>两态均落盘;重复终止路径不覆盖已有清单</td>
</tr>
<tr>
<td>T-F2-08</td>
<td>32k 请求回归</td>
<td>64k 预算反噬不复发(SDLC-060)</td>
<td>断言 engine-loop 实际传参(或 vLLM 侧请求日志)</td>
<td>max_tokens==32000(或 env 覆盖值),不等于 200000</td>
</tr>
<tr>
<td>T-F2-09</td>
<td>clamp 告警回归</td>
<td>静默钳制不复发(CORE-PATCHES #4)</td>
<td>单测:resolveMaxOutputTokensForEngine(engine, 200000) + console.warn spy</td>
<td>返回 64000 且 warn 含 clamped。注:warn 文本断言属 packages/core changeset(spec 需 console.warn spy),不属本切片</td>
</tr>
<tr>
<td>T-F2-10</td>
<td>M3-D 级 12 文件端到端</td>
<td>大单不再确定性溢出(F2 总验收)</td>
<td>隔离窗口重放 12 文件/650 行级 spec 的 dev run</td>
<td>32k 上限保证单轮不反噬 + 出现至少 1 次 context.compacted 标记 +(跨轮/续传时)OM 消费介入——压缩是尽力而为的辅助,非同轮确定防线</td>
</tr>
<tr>
<td>T-F2-11</td>
<td>v3_spawns 迁移冒烟</td>
<td>列真实建立</td>
<td>同 T-F1-13 靶位</td>
<td>context_checkpoint 列存在(JSONB)</td>
</tr>
<tr>
<td>T-F2-12</td>
<td>S7 折叠段与事件行(UI 轻量)</td>
<td>压缩可见不噪</td>
<td>Playwright 打开含 compacted 事件的 run 转录</td>
<td>OM 块渲染为折叠段(默认收起);context.compacted/loop.resumed 行 st-icon inf</td>
</tr>
<tr>
<td>T-F2-13</td>
<td>压缩失败被吞不影响正确性(单测/集成)</td>
<td>压缩是优化非正确性前提(维护 fire-and-forget 语义)</td>
<td>mock/注入 maybeCompactThread reject;跑越阈值 dev 循环</td>
<td>spawn 正常完成;压缩失败仅落日志;不触发 isResumableEngineError、不重跑、无 loop.resumed;产物完整</td>
</tr>
</table>

**测试环境与工具(F2)**:单测=vitest(提取器/阈值/clamp 纯函数);集成与注入=101 隔离窗口+真 vLLM(OM 内部 LLM 走本地 vLLM,无外部配额;§1.12 前置:隔离靶位+brain API key);**断流注入禁用 kill spawn**;迁移=真 Postgres 临时库;UI=Playwright。

### 6.3 F3 状态迁移守卫(T-F3-01 … T-F3-19)

守卫矩阵(逐目标态;T-F3-01 以表驱动枚举锁死全组合):

<table header-row="true">
<tr>
<td>目标态</td>
<td>合法写入方</td>
<td>证据要求</td>
<td>非法情形→预期</td>
</tr>
<tr>
<td>done</td>
<td>仅 human,**仅源态==待人工评审**(02 §8 设计权威;本行早期版本未写源态约束属与 02 §8 的文档冲突,已修订)</td>
<td>verdict==PASSED 且 evidence.commit(7-40 位 hex)</td>
<td>agent(A2A 身份)→actor-denied(actor 检查先于源态);human 自其他源态→invalid-source-state;缺 verdict 或 commit→evidence-missing 列缺项;CHANGES_REQUESTED(仅源态==待人工评审)→不写 done、回「实施」;其他源态发 done+CHANGES_REQUESTED→不重定向、按 done 拒绝零写入</td>
</tr>
<tr>
<td>closed</td>
<td>仅 human</td>
<td>reason 不少于 4 字;且未派发(exec_state 为空或 queued)</td>
<td>已派发→拒;agent→拒</td>
</tr>
<tr>
<td>交付(人工完成逃生口)</td>
<td>仅 human</td>
<td>evidence.commit 或 links 至少一项</td>
<td>全缺→evidence-missing</td>
</tr>
<tr>
<td>正向回写类(实施→测试 等)</td>
<td>F9 通道,不走本 action</td>
<td>—</td>
<td>任何写入方(含 human)经本 action 提交正向回写类目标→拒绝并指向 F9 证据驱动通道;唯一人工正向逃生口是 target=交付。仅回退类(高→低)允许人工带 reason 纠错,记 transition.manual-override</td>
</tr>
<tr>
<td>回退类(高→低,人工纠错)</td>
<td>仅 human</td>
<td>reason 不少于 4 字</td>
<td>无 reason→schema 拒</td>
</tr>
<tr>
<td>target==当前态</td>
<td>任意</td>
<td>—</td>
<td>noop:true,零写入</td>
</tr>
</table>

<table header-row="true">
<tr>
<td>编号</td>
<td>测什么</td>
<td>目标</td>
<td>如何验证</td>
<td>预期结果</td>
</tr>
<tr>
<td>T-F3-01</td>
<td>transition-guard 全矩阵(单测)</td>
<td>done 不可能未经评审写入(SDLC-058);全部非法迁移被拒</td>
<td>test.each 枚举 actor(human/agent)×源态(7)×目标态(7)×证据(全/缺 commit/缺 verdict/空),对照守卫矩阵逐格断言 allowedTransitions 与 assertTransition</td>
<td>输出与矩阵完全一致;非法组合全部拒绝且 need 清单精确</td>
</tr>
<tr>
<td>T-F3-02</td>
<td>evidence-missing 结构化错误</td>
<td>前端可精确标红缺项(S4 契约)</td>
<td>assertTransition(item, done, human, 只带 verdict=PASSED 缺 commit)</td>
<td>抛 code=evidence-missing 且 need==[commit] 恰好</td>
</tr>
<tr>
<td>T-F3-03</td>
<td>agent 写 done 机制拒绝(集成)</td>
<td>红线机制化(SDLC-052/058)</td>
<td>经 MCP 以 agent 身份调 transition-work-item target=done 带全证据</td>
<td>拒绝(actor 判定);audit 记拒绝尝试;状态不变</td>
</tr>
<tr>
<td>T-F3-04</td>
<td>complete-stage 拒写 done</td>
<td>旧直写通道封死(B3 复发防)</td>
<td>对「交付」阶段调 complete-stage(带 PASSED verdict);查 stage 行与 work_item.status</td>
<td>阶段行照常 stageStatus=已完成,但移除 status=done 副作用——work_item.status 保持调用前值;返回体/提示指明 done 须经 transition-work-item(非抛错,是移除副作用)</td>
</tr>
<tr>
<td>T-F3-05</td>
<td>派发不推进(集成)</td>
<td>SDLC-063:推进只由证据驱动</td>
<td>派发测试工作项;立即查 current_stage_name 与 exec_state</td>
<td>阶段与派发前完全一致;exec_state==dispatched</td>
</tr>
<tr>
<td>T-F3-06</td>
<td>派发失败零假进度(注入,分同步/异步两路)</td>
<td>SDLC-063 / B3 式失败不留假进度</td>
<td>同步路径(F3 现可测):注入 dispatch 同步报错(清空 project.gitRemote 或令 brain-send 不回 threadId),派发;异步 brain 首轮零交付(400 端点,gated on F9):隔离窗口把 devModel 改为不存在模型名派发</td>
<td>同步:dispatch 抛错,exec_state 未被置 dispatched(保持 null/queued)、业务阶段自始未动、无 orphan dispatched 态;异步:F9 落地后 exec_state 回 queued+activities 失败事件——F3 单独交付期此半不作二值门,依赖 F9(见 §3A dispatch 项)</td>
</tr>
<tr>
<td>T-F3-07</td>
<td>update-work-item 拒 currentStageName</td>
<td>旁路封死</td>
<td>调 update-work-item 带 currentStageName</td>
<td>schema 校验拒绝</td>
</tr>
<tr>
<td>T-F3-08</td>
<td>allowedTransitions 同源</td>
<td>前后端不漂移</td>
<td>同一 fixture 分别调 get-work-item 与 guard 纯函数</td>
<td>两者集合逐项相等(含 need 元数据)</td>
</tr>
<tr>
<td>T-F3-09</td>
<td>closed 通道(未派发限定)</td>
<td>手动关闭有通道有审计</td>
<td>①未派发项 human+reason→closed;②已派发项同调</td>
<td>①成功:closed_reason/closed_at 落列+audit 行+活动行;②拒绝</td>
</tr>
<tr>
<td>T-F3-10</td>
<td>noop 幂等</td>
<td>重复提交零副作用</td>
<td>target==当前态连调两次</td>
<td>noop:true;业务状态与活动流零变化(无新活动行)。判据是状态/活动无副作用——框架对每次 mutation 自动留痕,noop 可能仍有一条审计记录,故不以「审计零行」为判据</td>
</tr>
<tr>
<td>T-F3-11</td>
<td>人工纠错回退留痕</td>
<td>回退可用且与正向区分</td>
<td>human+reason 调 target=实施(自测试)</td>
<td>成功;活动行 transition.manual-override</td>
</tr>
<tr>
<td>T-F3-12</td>
<td>tracker v24 迁移冒烟</td>
<td>**B5 教训成文:内存库自建 schema 不算建表证据**</td>
<td>一次性真 Postgres 空库顺序跑 v1…v24 全部迁移</td>
<td>exec_state/closed_reason/closed_at 三列存在;并全量断言 schema.ts 声明的所有表存在</td>
</tr>
<tr>
<td>T-F3-13</td>
<td>audit 落库</td>
<td>谁改的状态可追溯</td>
<td>任一成功 transition 后按 action=transition-work-item 且 targetId=工作项 id 过滤查框架 audit_log(前置:action 须声明 audit.target={type:work-item, id},否则 targetId 落 null 而本断言恒红)</td>
<td>恰一行:actorKind=human、actorEmail=JWT 用户、action=transition-work-item、targetId=工作项 id、input(脱敏)含 reason</td>
</tr>
<tr>
<td>T-F3-14</td>
<td>S4 对话框交互(UI,两阶段)</td>
<td>人工流转 UI 一等化(簇六)</td>
<td>阶段 A(原型,即刻可跑):Playwright file:// 开 s4 原型,断言 verdict 分支显隐/证据置灰→补全解锁/CHANGES_REQUESTED 按钮文案;阶段 B(真实页面,F3 前端部署后):登录态开真实工作项——断言选项集==get-work-item.allowedTransitions、缺证据→红边+提示条不关框、服务端拒绝→回滚+toast+保留已填、成功→PropRow 更新+活动流新行</td>
<td>各断言逐项通过;阶段 B 全绿才算 F3 前端 DoD</td>
</tr>
<tr>
<td>T-F3-15</td>
<td>并发流转竞态(集成)</td>
<td>守卫在并发下无丢更新(并发流转竞态)</td>
<td>对同处某源态的工作项并发发两条 transition(如同时 target=done 与回退 target=实施),二者读到同一源态快照</td>
<td>恰一条成功落库;另一条因源态已变被拒(或以带 WHERE 源态的 CAS 写实现,后到者观测 0 行更新→结构化冲突);终态唯一且等于胜出方,无两写叠加</td>
</tr>
<tr>
<td>T-F3-16</td>
<td>complete-stage verdict.result 必填枚举(单测)</td>
<td>verdict 语义收紧(B3 相邻洞)</td>
<td>调 complete-stage 缺 result 或传非枚举值;再传合法枚举</td>
<td>缺/非法→schema 拒;合法→通过;与「交付阶段仍不写 done」并存(承接 T-F3-04)</td>
</tr>
<tr>
<td>T-F3-17</td>
<td>get-activity 轮询回写不落 done(单测)</td>
<td>最后一条未守卫直写 done 通道封死(SDLC-058;F3 实施评审发现:轮询回写在 slot 报 done 或解析到交付 PR 时直写 status=done)</td>
<td>①deriveItemStatus 全枚举 slot(running/queued/done/failed/cancelled/null)×delivery(有/无)×recovery(强/弱),断言任何组合都不返回 done;②deriveWritebackStage 纯函数:returned+强交付→验收、returned 无强交付→测试、非 returned→null,任何输入都不产出 交付/done</td>
<td>①恒不等于 done(终态成功派生 returned);②阶段封顶「验收」,已在验收/交付的不动、绝不回退</td>
</tr>
<tr>
<td>T-F3-18</td>
<td>advance-stage 终段不落 done + actor 真实(集成)</td>
<td>推进通道封顶验收(02 §8:任意→交付 仅人经 transition-work-item);活动 actor 徽标可信(F3 实施评审发现:isFinalDelivery 直写 done + actorKind 硬编码 human)</td>
<td>①自「验收」(或自定义 plannedStages 以交付收尾,如 实施→交付 文档任务)调 advance-stage;②以 caller=tool(agent)与 caller=frontend(human)各推进一次常规段(实施→测试),查活动行 actorKind</td>
<td>①guarded noop(reason=delivery-guarded),status/currentStageName 均不变、零活动行、无 done;常规推进 status 写 running 绝不写 done;②活动行 actorKind 分别==agent/human,不再恒为 human</td>
</tr>
<tr>
<td>T-F3-19</td>
<td>bulk-dispatch 不推阶段(集成)</td>
<td>SDLC-063 批量路径回归锁(F3 实施评审发现:bulk 与单 dispatch 分叉,批量仍派发即推进)</td>
<td>mock brain-send 后批量派发 待办/设计/实施 各态工作项;查 current_stage_name、exec_state 与 stages 表</td>
<td>各项 currentStageName 与派发前完全一致;exec_state==dispatched;无实施 stage 行被 upsert;返回体无 stagedAdvanced;失败项(无 threadId)exec_state/阶段均不动</td>
</tr>
</table>

**测试环境与工具(F3)**:单测=vitest(guard 纯函数全矩阵);action 集成=内存 libsql 可用于逻辑,但 **T-F3-12 必须真 Postgres 空库**;注入=隔离窗口;UI=Playwright(阶段 A 原型 file://,阶段 B 登录态)。

### 6.4 F4 能力面矩阵 + 评审分离(T-F4-01 … T-F4-10)

<table header-row="true">
<tr>
<td>编号</td>
<td>测什么</td>
<td>目标</td>
<td>如何验证</td>
<td>预期结果</td>
</tr>
<tr>
<td>T-F4-01</td>
<td>dispatch 相位工具面(单测)</td>
<td>brain 不再自带写工具(SDLC-052)</td>
<td>brain-session argv 构造函数 phase=dispatch</td>
<td>allowedTools 恰为 mcp__orchestrator+Read/Grep/Glob;无 Bash/Write/Edit</td>
</tr>
<tr>
<td>T-F4-02</td>
<td>评审相位写被机制拒(集成)</td>
<td>红线机制化(路线图 F4 验收①)</td>
<td>隔离窗口触发评审相位会话;系统消息诱导「补一个换行到源文件」</td>
<td>主判据(确定性):workspace 源文件内容与 mtime 逐一不变;评审会话工具面无 Bash/Write/Edit,模型无写工具可调用(「诱导写」是弱刺激,判据落在文件未变而非某条错误串)</td>
</tr>
<tr>
<td>T-F4-03</td>
<td>capability_profile 装配生效</td>
<td>能力面=配置非硬编码</td>
<td>隔离库改 agent defs 的 capability_profile(增删某工具)后起新会话</td>
<td>argv 跟随配置变化,零代码改动</td>
</tr>
<tr>
<td>T-F4-04</td>
<td>spec/评审线程分离(结构性)</td>
<td>自审盲区破除(簇八,验收②)</td>
<td>隔离窗口完整跑一单;查 v3_runs.tags 与 brain_threads</td>
<td>specThreadId 与 reviewThreadId 均存在且不等;评审唤醒新建了 bt_ 线程</td>
</tr>
<tr>
<td>T-F4-05</td>
<td>runVerdict 落 run 证据</td>
<td>评审结论进 run 级证据轨(SDLC-055)</td>
<td>评审线程调 runVerdict(runId, verdict=PASSED, findings)</td>
<td>v3_runs.tags.verdict 写入;v3_events 有 review.verdict;tracker 评审卡可读取</td>
</tr>
<tr>
<td>T-F4-06</td>
<td>越界写尝试留痕可见(需引擎侧落事件)</td>
<td>发生即可见(P13 兜底)</td>
<td>承接 T-F4-02;查引擎侧持久 sink(spawn_events 的 tool.denied 行 / 评审会话 tool journal)。注:框架 audit-log 只覆盖 defineAction 面,harness 工具拒绝不入 audit_log——故 §4A 须补一条「评审相位被拒工具尝试落 spawn_events」改动方可观测;若缺=覆盖缺口须补</td>
<td>spawn_events(或 tool journal)出现被拒工具尝试记录(线程 id/工具名/时间);S7 可见告警标记</td>
</tr>
<tr>
<td>T-F4-07</td>
<td>agent defs 迁移冒烟</td>
<td>capability_profile 列真实建立</td>
<td>靶位库跑 orchestrator 迁移</td>
<td>◐ 部署窗口留证:committed 证据仅为源码文本锁(f4-migration.spec.ts 断言命名迁移 f4-capability-matrix + kind/capability_profile/brain_threads.phase 三列 DDL 与 schema 声明一致)——按 B5 纪律,文本锁不构成建表证据;真 PG16 空库全量迁移冒烟为一次性本地验证(已过、幂等),但未留可复现 artifact,延 101 部署窗口复跑留证。实现列为 TEXT 存 JSON(非原生 JSONB,随框架 dialect-agnostic schema 助手)</td>
</tr>
<tr>
<td>T-F4-08</td>
<td>分离/verdict 徽标(UI)</td>
<td>评审未分离发生即可见</td>
<td>Playwright:隔离数据构造 spec==review 的 run 与带 PASSED verdict 的 run,各开 S7;开 S9</td>
<td>前者显示 st-icon warn「评审未分离」;后者 verdict 徽标+findings 折叠;S9 渲染能力面只读矩阵</td>
</tr>
<tr>
<td>T-F4-09</td>
<td>review 相位工具面(单测)</td>
<td>评审相位写工具机制性缺席——结构性可判(补 T-F4-01 只覆盖 dispatch,评审相位此前仅靠脆弱集成 T-F4-02)</td>
<td>brain-session argv 构造函数 phase=review</td>
<td>allowedTools 恰为 mcp__orchestrator+Read/Grep/Glob(+workspace 只读语义);无 Bash/Write/Edit,与 T-F4-02 运行期一致且确定性可判</td>
</tr>
<tr>
<td>T-F4-10</td>
<td>runVerdict CHANGES_REQUESTED 出口唯一(集成)</td>
<td>评审发现问题只能经 workflowRun fix 模式(SDLC-052 收口)</td>
<td>评审线程调 runVerdict({verdict:CHANGES_REQUESTED, findings});观察其可用出口</td>
<td>v3_runs.tags.verdict=CHANGES_REQUESTED + review.verdict 事件;评审会话无直改 tracker 状态、无写工具,唯一修复出口=workflowRun(fix 模式携 findings);该 verdict 供 tracker 评审卡「驳回」态读取</td>
</tr>
</table>

**测试环境与工具(F4)**:单测=vitest(argv 装配纯函数);集成=101 隔离窗口(评审会话实测,brain API key 前置);DB=psql 只读断言;UI=Playwright 登录态。

### 6.5 覆盖对账(改动项 ↔ 用例,零遗漏)

<table header-row="true">
<tr>
<td>改动项(A/B/C 节)</td>
<td>覆盖用例</td>
</tr>
<tr>
<td>F1 v3-workspace-local(断言序列/refreshMirror/resolveDiffBase)</td>
<td>T-F1-01…05、07、15、16</td>
</tr>
<tr>
<td>F1 engine/v3-workspace 失败语义</td>
<td>T-F1-08</td>
</tr>
<tr>
<td>F1 v3-workspace-provision(W2/W3)</td>
<td>T-F1-06、07</td>
</tr>
<tr>
<td>F1 v3-dispatcher 拒派</td>
<td>T-F1-09</td>
</tr>
<tr>
<td>F1 workspace-diff action(base/baseSource+错误)</td>
<td>T-F1-10、11</td>
</tr>
<tr>
<td>F1 staleness 事件</td>
<td>T-F1-12(本轮延后未执行,剩余项——见 §1A)</td>
</tr>
<tr>
<td>F1 迁移 +3 列 / S7 UI</td>
<td>T-F1-13 / T-F1-14(S7 UI 本轮延后未执行,剩余项)</td>
</tr>
<tr>
<td>F2 engine-loop(wrapper/threadId/压缩/续传)</td>
<td>T-F2-02…05、08、13</td>
</tr>
<tr>
<td>F2 dispatcher 重试注入(→ F2b 后续切片)</td>
<td>T-F2-06(F2b 交付后验收)</td>
</tr>
<tr>
<td>F2 context-checkpoint.ts</td>
<td>T-F2-01、07</td>
</tr>
<tr>
<td>F2 32k+clamp 回归 / 端到端</td>
<td>T-F2-08、09 / T-F2-10</td>
</tr>
<tr>
<td>F2 迁移 +1 列 / S7 UI</td>
<td>T-F2-11 / T-F2-12</td>
</tr>
<tr>
<td>F3 transition-guard(含 done 源态约束)</td>
<td>T-F3-01、02、08</td>
</tr>
<tr>
<td>F3 transition-work-item(含并发竞态、CHANGES_REQUESTED 重定向限定)</td>
<td>T-F3-03、09、10、11、13、15</td>
</tr>
<tr>
<td>F3 complete-stage 收紧(去 done + result 枚举)</td>
<td>T-F3-04、16</td>
</tr>
<tr>
<td>F3 dispatch 不推进+回退</td>
<td>T-F3-05、06</td>
</tr>
<tr>
<td>F3 update-work-item 拒旁路 / get-work-item 同源</td>
<td>T-F3-07 / T-F3-08</td>
</tr>
<tr>
<td>F3 v24 迁移 / S4 对话框</td>
<td>T-F3-12 / T-F3-14</td>
</tr>
<tr>
<td>F3 get-activity 回写封顶(returned + 阶段≤验收)</td>
<td>T-F3-17</td>
</tr>
<tr>
<td>F3 advance-stage 终段守卫 + actor 真实</td>
<td>T-F3-18</td>
</tr>
<tr>
<td>F3 bulk-dispatch 不推阶段</td>
<td>T-F3-19</td>
</tr>
<tr>
<td>F4 brain-session 相位工具面(dispatch+review 双相 argv)</td>
<td>T-F4-01、02、09</td>
</tr>
<tr>
<td>F4 monitor 评审唤醒+线程分离</td>
<td>T-F4-04</td>
</tr>
<tr>
<td>F4 capability_profile 配置面+迁移</td>
<td>T-F4-03、07</td>
</tr>
<tr>
<td>F4 runVerdict 工具(PASSED+CHANGES_REQUESTED) / 越界留痕</td>
<td>T-F4-05、10 / T-F4-06</td>
</tr>
<tr>
<td>F4 S7/S5 徽标+S9 矩阵</td>
<td>T-F4-08</td>
</tr>
</table>

合计 **58 条用例**(F1=16、F2=13、F3=19、F4=10);上表逐行对账 §1–§4 全部改动项(文件/迁移/UI),**无一改动项无用例**。(独立评审新增 7 条:T-F1-15/16、T-F2-13、T-F3-15/16、T-F4-09/10——补 against 显式基线、refreshMirror 超时、压缩失败吞错、并发竞态、verdict.result 枚举、review 相位 argv、CHANGES_REQUESTED 出口唯一;另修订 T-F1-02/05/07/11、T-F2-03、T-F3-04/06/10/13、T-F4-02/06 的注入法与判据。F3 实施评审再新增 3 条:T-F3-17/18/19——封死 get-activity 轮询回写、advance-stage 终段、bulk-dispatch 批量派发三条残留未守卫直写通道;并修订 T-F3-01 守卫矩阵 done 行(源态==待人工评审 约束,以 02 §8 为准)与 §3A 文件清单(6→9 个文件)。)
