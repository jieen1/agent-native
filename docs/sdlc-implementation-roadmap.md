# SDLC 实施路线图(落地版)

> 状态:**实施权威**(2026-07-11 建立)。
> 与既有文档的关系:`docs/sdlc-product-design/`(v2.2.1)是**产品与机制设计权威**;
> `docs/sdlc-implementation-plan.md`(v1.1)是**验收纪律与场景基准**,保留不动,
> 其 M1/M3 的相当部分已在自举中落地(见 §1 现状标注);`docs/sdlc-system-design.md`
> 是流程域骨架的前身。本文档回答的问题只有一个:**按什么顺序做,才能保证每一步
> 都踩在可验证的地基上,而不是堆到最后发现根子是坏的。**
> 本文档不写工期与人日——顺序与依赖就是计划;每阶段有硬验收门,门不绿不进下一阶段。

## §0 理解:为什么地基是这些,而不是别的

### 0.1 这个系统的核心是什么

四应用各守一域:**tracker=流程域**(状态机+证据),**orchestrator=执行域**
(brain 决策 + DAG 干活),**content/design=表征域**(人看富呈现,agent 读纯文本)。
贯穿四域的是一条**证据流**:

```
需求(tracker 工作项) → 派发(brain) → DAG 节点产出(vLLM dev,工作区内)
→ 评审/守门(verdict + 证据工件) → 合并(镜像 main) → 部署 → 页面可见
→ Goal 指标回填 → gap-analysis 判 MET/UNMET → sprint 关闭
```

**自举 25+ 个 issue 的共同教训(07 章总根因):v2.1 只设计了"角色做什么",
没设计"环境保证什么"。** 凡是没写成契约/不变量的环境性质——工作区新鲜度、测试可
执行性、状态写入权、观测基线、终态传导——全部以最坏的方式失效过一次。所以地基
的筛选判据只有两条:

1. **上层任何场景都踩在它上面**(工作区、执行器、状态机、遥测是每一单的必经路);
2. **它出错时是静默的**——静默毁掉证据链的东西必须先修,因为你不会知道楼歪了。

### 0.2 agent-native 核心设计如何约束实施顺序

- **actions 是唯一操作面**(agent 与 UI 同源)→ 所有守卫/契约必须落在 action 层,
  而不是 UI 校验或提示词;这决定了 F3(守卫)先于任何 UI 工作。
- **状态在 SQL、application_state 承载导航语境** → 状态机守卫是数据层不变量,
  加性迁移是它的载体;这决定了 F6(迁移对账)属于地基而非"质量优化"。
- **一切 AI 走 agent chat / brain,代码改动走 DAG** → 红线必须机制化(F4),
  否则"agent 可改自身代码"这一特性会吞掉证据链。
- **四域检查单(UI/actions/skills/application_state)** → 阶段二每个场景都按
  四域收口,缺一个域就不算"跑通"。

### 0.3 一个先于一切的事实:两棵源码树已经分叉

自举把代码合入 **dogfood 镜像 main**(101 容器内 bare 仓),而 101 的实际部署
既有从 dogfood 构建的(tracker),也有从**框架仓分支**构建的(orchestrator,
今日的模型目录/64k 修复走的这条线)。两边各有对方没有的提交
(dogfood 有 72449791f brain 提示词 SQL 化、f9b72161b reconcile 加宽;框架分支有
output-tokens 告警、engine-loop 32k、brain-model 目录)。**生产环境是嵌合体。**
不先收敛,后面每一项的"现状证据"都会两边打架——因此 F0 排第一。

## §1 阶段一 · 地基

> 状态标注更新于 2026-07-16;交付明细见《SDLC 系统 · F0–F10 实现说明》(/page/eC0amjYq04IE)。

> 通过判据:**F0–F10 全部完成 + §1.12 地基验收门全绿**,才允许进入阶段二。
> 每项五段:做什么 / 为什么是地基 / 现状证据 / 可证伪验收 / 依赖。

### F0 交付主干统一【已交付 2026-07-12】(自举现状项,无直接设计章节;约束见 00 §8 A1 单机部署假设)

- **做什么**:规定唯一可部署主干(dogfood 镜像 main 为交付主干);把框架仓分支
  今日的修复(brain-model 目录、engine-loop 32k、output-tokens 告警等 **CORE-PATCHES 系列**)
  按判据回合到 dogfood main;把 dogfood main 的 orchestrator 提交(72449791f、f9b72161b 等)
  确认纳入部署构建;部署工件记录来源 commit sha(构建溯源);**并把散落手工步骤收敛为唯一
  可重复部署脚本**(build→sync→restart→verify,任一步失败即止不静默续跑——现状 build-all.sh
  跳过 chat、locale-kit 幽灵依赖运行时崩溃等构建陷阱各自为战,静默失效就是 F0 的失败模式)。
- **为什么是地基**:源不唯一,则任何"已修复"都可能在下一次部署被静默回退
  (今日实证:重部署框架分支构建,把 dogfood 已有的 reconcile 加宽从生产上顶掉了)。
- **现状证据**:dogfood main HEAD 与框架分支互有独占提交(git log 双向对比);
  101 live tracker 含 dogfood 才有的 advance-stage 面,live orchestrator 是框架分支构建。
- **可证伪验收**:①第一步在同时含两 remote 的检出(或 101 dogfood bare + 框架分支)跑
  `git log --oneline dogfood/main ^框架分支` 及反向——列出的每条独占提交,要么已回合、
  要么在**豁免台账**登记(每条注明:归属=框架 core 上游件即 CORE-PATCHES 系列 / 还是应回合;
  去向;理由);**判据是"未归类的独占提交为零",而非独占提交绝对为零**(core 上游件不强求
  落 dogfood,但必须登记去向,否则无法与"漏合的修复"区分)。②部署脚本把 build sha 落到单一
  权威载体(部署记录表 **或** 镜像标签,二选一固定);失败即止。③任取一 live 容器,由其落库
  build sha 反查出唯一源 commit,且该 commit 在交付主干可达(`git merge-base --is-ancestor` 通过)。
- **依赖**:无。**一切之首。**
- **页面**:无。

### F1 工作区契约 W1–W4【已交付 2026-07-12】(设计出处 02 §7)

- **做什么**:workspaceCreate 落 **W1–W3 三条就绪不变量**(创建后即断言,任一不满足=
  infra 故障不开 run)——W1 基线=派发时镜像目标分支 HEAD(断言 merge-base,过期即
  fail-fast);W2 依赖预热(共享 pnpm store 硬链,秒级);W3 测试可执行(`test_cmd_smoke`
  跑通才算就绪);另加 **W4 观测基线正确性**(02 §7 存续期规则,非创建时就绪门):对比类
  观测工具(workspaceDiff/runSummary 的 diff 统计)在**调用时**动态求
  `git merge-base HEAD 镜像目标分支 tip`,禁用创建时静态基线,基线不可得=显式错误。
- **为什么是地基**:工作区是 dev/评审的**全部世界**;基线过期→无谓冲突(B2 实证),
  无测试环境→TDD 纸上谈兵(B5/SDLC-057 实证),diff 基线错→守门看错东西(B4 2.3MB
  假 diff 实证)。三件事全是静默失效。
- **现状证据**:`server/engine/v3-workspace.ts` 有创建逻辑、无任何就绪断言;
  B2 工作区落后 main 约 20 提交;dev 自述"环境无 vitest 二进制";workspaceDiff 静态基线。
- **可证伪验收**:①向共享 bare 镜像的目标分支推进一格,再对同仓 workspaceCreate——
  无论走"拒绝"还是"自动 fetch+reset"分支,**创建后立即断言 `git merge-base HEAD 镜像目标分支tip`
  距离==0**(仅"拒绝/同步二选一"不可判,必须以基线距离为终判);②新工作区内
  `pnpm exec vitest --version` 与目标模板单测直跑通过;③重放 B4 场景:workspaceDiff 返回文件数==
  `git diff --stat merge-base..HEAD` 的真实改动数;④坏基线注入=用一个 **origin/HEAD 不指向 main**
  (或删除 origin/main 引用)的镜像建区再 workspaceDiff——现状 `resolveDiffBase` 会静默沿
  origin/main→master→HEAD~1→空树链回退给出"看似 diff"的错答,F1 交付后须改为**显式错误**;观测=
  返回 error 而非任何 diff 统计。
- **依赖**:F0(基线定义在交付主干上)。
- **页面**:引擎侧为主;可选 S7 运行详情加 staleness 提示(原型未含,非必需)。

### F2 执行器上下文管理(调研结论 B)【已交付 2026-07-12(F2b 消费端切片待办)】(设计出处 02 §4.1 C1–C4)

- **做什么**:engine-loop 给 runAgentLoop 传 `threadId=spawnId + ownerEmail/orgId`
  激活 OM 压缩/工具日志;send sink 超阈值触发 `maybeCompactThread`;外层换
  `runAgentLoopDirectWithSoftTimeout` 获得断流续传与防重放;V3 特有件
  (buildPrompt/steps 映射/RuntimeExecResult/spawn_events)原样保留。
- **为什么是地基**:没有它,任何 >中等规模 的 dev 任务确定性溢出(M3-D 三连失败实证),
  阶段二的场景规模会被地基反噬。
- **现状证据**:`executors/engine-loop.ts` 直调 runAgentLoop 只传 ownerEmail/orgId、
  无 threadId(三层机制被门控关闭,交付主干实测);core 侧 compactor/trim/续传函数俱在
  (production-agent.ts、run-loop-with-resume.ts、observational-memory/、
  runAgentLoopDirectWithSoftTimeout);64k 钳制已修为 32k+告警——但该修复仅在框架分支
  (live orchestrator 走此构建),dogfood main 仍硬编 `maxOutputTokens: 200_000`
  并静默钳到 64k(F0 的又一活例)。in-app vLLM chat 走同函数带 threadId 即有压缩——
  可行性铁证。
- **可证伪验收**:重放 M3-D 级 12 文件任务:单 attempt 完成、`spawn_events` 表查得
  `[Observational Memory]` 注入行、无 grown-too-long 终止。**掐断流的注入方式**(软件层无外部断流
  开关——经查 `runCancel` 只翻 DB 状态且被收尾覆盖):vLLM 引擎节点在运行期切断到 vLLM
  `:250:9000` 的连接或重启 orchestrator 进程;Claude-Code 节点则 `kill` 其 `claude` 子进程 PID。
  **注**:现状 spawn 是原子的(产物仅在循环返回后落盘、重试从零重跑、无可续检查点),故
  "续传接续且已完成写操作不重放"是 F2 要新建的能力(把 core 侧续传函数接进 engine-loop),本条
  即验它:断流后同一节点续传接续、`spawn_events` 不出现重复的已完成写。
- **依赖**:F0。
- **页面**:无(OM 注入痕迹复用 S7 现有转录视图)。

### F3 状态迁移守卫 + 派发不推进 + 人工流转通道【已交付 2026-07-12】(设计出处 02 §8 守卫表)

- **做什么**:实现 02 §8 守卫表——`done` 只能由(收件箱评审卡/工作项页)人工带 PASSED
  verdict 的受守卫流转、或带 PASSED verdict 的 gap-analysis 记录写入(不再经 complete-stage
  无 verdict 直写;现状 complete-stage/trigger 收敛为 advance-stage);派发只记 execState,
  业务阶段不因派发推进,失败派发零残留;
  新增 `transition-work-item`(人工,进 audit-log),未派发项从此有关闭通道。
- **为什么是地基**:状态是证据链的骨架;B3"未评审即 done"(SDLC-056b)、
  "派发即推进且失败不回退"(SDLC-063)证明现在**谁都能写、写了不回退**。
- **现状证据**:tracker `complete-stage.ts`(交付主干实测)在「交付」阶段完成时
  直接写 `status=done`,verdict 仅为可选参数、无 PASSED 前置(B3 实证);
  `dispatch-to-orchestrator.ts` 派发时把 currentStageName 推到「实施」
  (返回 `stagedAdvanced` 字段),失败派发不回退;tracker `update-work-item.ts`
  自述「metadata, not status transitions」却直接接受并写 currentStageName、无任何守卫,
  且 tracker 侧无经 audit 的人工流转 action(transition-work-item 只在 orchestrator 存在)。
- **可证伪验收**:故障注入三连:①直接写 done(无 verdict)→拒绝;②派发后**立即查业务阶段未变**
  (派发只记 execState、不推进业务阶段,故此处无"阶段回退"可言,终判是"阶段自始未动");再令首轮
  派发落到会 400 的端点(如临时把该项目仓 devModel 改为不存在的模型名)注入 brain 首轮零交付→
  **execState 回 queued、业务阶段仍未动、审计留一条失败事件**;③未派发项经 transition-work-item
  关闭且 audit-log 有行。
- **依赖**:F0;与 F9 配对(F9 是守卫的自动运载工具)。
- **页面**:涉及——S4 工作项详情(受守卫流转对话框,含未派发项关闭);
  原型:**部分**(shield-lock 入口标识已加,对话框本体未做)。

### F4 能力面矩阵(评审只读)+ spec/评审分离【已交付 2026-07-12】(设计出处 02 §5.4 能力面矩阵 / §3 评审独立性)

- **做什么**:角色×相位能力面成为引擎配置——评审相位 brain 的 workspace 只读挂载
  /写类工具裁剪,修复必须重派 dev 节点 fix 模式;评审执行者与 spec 作者分离
  (独立复核会话/节点,verdict 落 run 证据)。
- **为什么是地基**:红线失守=证据链作者身份不可信(brain 整文件重写实锤,
  SDLC-052);spec 作者自审对自身设计决定零质疑(B2 事务债、B3 N+1 均为 spec
  写入,审计实证)。这两件事让"评审通过"四个字失去意义。
- **现状证据**:`brain-session.ts` argv `--allowedTools mcp__orchestrator Bash Read
  Edit Write` 全开;评审=同一 brain 会话;质量调研:小单里 brain 自查零深层缺陷。
- **可证伪验收**:①评审相位实测:让评审节点执行 `printf ... >> 源文件`(经 Bash 工具)→被机制
  拒绝(只读挂载/写类工具裁剪,非提示词劝阻)。②**门是结构性的、可确定判定**:评审执行者的
  会话/节点标识 ≠ spec 作者的会话/节点标识(从 run 证据上二者 sessionId/nodeId 不同即通过);把
  "独立复核能抓出 spec 内嵌缺陷(如无事务)而自审抓不出"作为**辅助质量信号**(单次 LLM 输出有随机
  性,不作二值门,避免用不可复现的观察当验收判据)。③verdict 出现在 run 级证据(可从 tracker
  回链打开),不只在 brain 转录。
- **依赖**:F0、F2(评审会话形态)。
- **页面**:无(引擎配置+独立评审会话,无新页面)。

### F5 任务拆分阈值(规划前置契约)【已交付 2026-07-12】(设计出处 02 §3.10 拆分契约)

- **做什么**:brief/spec 超阈值(>6 文件或跨生命周期协同)在派发前被拦截,
  要求拆分为多个 dev 子单;拆分决策点进 03 章规划工作台(Briefs 规模告警+一键拆分)。
- **为什么是地基**:超规模任务对 vLLM 是确定性失败(M3-D 三次预算耗尽、S0 六线程,
  审计实证),失败后 brain 代写=作者身份转移,直接击穿 F4。
- **现状证据**:sdlc-dev 模板单 develop 节点,无任何规模检查;M3-D/S0 历史在案。
- **可证伪验收**:提交 12 文件级 spec→派发被拦并给出拆分建议;拆分后每个子单(各 ≤6 文件)
  **单 attempt 走完 dev→评审→合并且不触发预算耗尽/grown-too-long**(以"每个子单单次通过"为终判,
  不用"成功率"这类需多轮统计、单次验收不可测的口径)。
- **依赖**:F3(拦截落在派发守卫上)。
- **页面**:涉及——S2 规划工作台(Briefs 规模告警条+一键拆分);原型:**未做**。

### F6 迁移对账 + 迁移冒烟 + 迁移号防撞【已交付 2026-07-12】(设计出处 02 §7 迁移冒烟 / §8 标识权威 / 03 §2 核对清单)

- **做什么**:①迁移冒烟测试:空库跑全部迁移,断言 schema.ts 声明的每张表存在
  (进评审前置);②评审核对清单硬项"新表↔迁移逐一对账"(可机器预填);
  ③迁移登记加内容哈希,跨分支同号异内容→显式冲突而非静默跳过。
- **为什么是地基**:B5 实证自建表测试全绿掩盖建表缺失(SDLC-061);历史上迁移
  撞号被静默跳过(eb7d7d5a,SDLC-037)。数据层地基的静默失效等于全楼危房。
- **现状证据**:`server/plugins/db.ts` 顺序小整数、无 hash;B5 首版无 v23 迁移
  而 420 行测试全绿;人工评审拦下后 fix 轮已补(9027753a5)。
- **可证伪验收**:①删掉任一建表迁移跑冒烟→红;②重放 B5 场景(schema 加表不加
  迁移)→核对清单拦截;③两分支同号异内容合并→启动时显式报错。
- **依赖**:F0。
- **页面**:涉及——S5 收件箱·评审卡(结构化核对项,未确认批准置灰);
  原型:**部分**(评审卡已加,按 nature 装配的核对清单控件未做)。

### F7 遥测与身份单一事实源【已交付 2026-07-12】(设计出处 04 §7 模型注册表 / §13 采集契约 / §10 遥测可信卡 / §6 turn 终态判定)

- **做什么**:①spawn 用量只取流终 usage(修 tok_in=0/tok_out 平方膨胀);
  ②model_registry(真名+别名映射),spawn.model_ref 记真名,claude-* 禁止映射
  非 Claude 权重;③harness 声明开启而初始化失败=健康页红灯+error 日志(禁静默降级);
  ④turn 终态判定契约:交付摘要存在时收尾竞态不得覆盖为 error。
- **为什么是地基**:遥测不可信则一切复盘/成本/质量归因全错(1.33M tok/4min、
  一模四名、B5 成功标 error 均实证);且降级静默=你不知道自己在用什么跑生产。
- **现状证据**:v3_spawns 实测 tokens_input 231/231 恒 0、tokens_output 最大约 10M
  (物理不可能);spawn.model_ref 出现 `claude-sonnet-4-6`(53 次)冒用本地 qwen3.6 权重,
  别名在 registry/chat 多处漂移(SDLC-054);ACP 包已随构建(部分修复),但"声明开启而
  失败仍静默"未改;B5 error 误标在案(SDLC-060)。
- **可证伪验收**:①跑一单后 tok_in>0 且 tok_out ≤ 时长×合理吞吐;②按 model_ref
  统计的报表能区分真 Claude 与本地权重;③人为删 ACP 包重启→健康页红灯;
  ④重放 B5 收尾竞态→线程终态为 done 且附异常记录。
- **依赖**:F0。
- **页面**:涉及——S9 Brain 控制台(模型注册表区+降级显式告警)/
  S10 健康页(遥测可信卡);原型:**未做**。

### F8 回链完整性 + itemKey 分配权威【已交付 2026-07-12】(设计出处 02 §8 回链载荷+标识权威 / 03 §11 序列器)

- **做什么**:工作项↔run 改追加式历史(重派新 run 追加而非单槽覆盖),branch 于
  push 后回填;itemKey 由项目级序列器单点分配。
- **为什么是地基**:回链断则"从工作项打开证据"不成立(阶段二场景①③全靠它);
  重号则证据锚点本身歧义(SDLC-032~036 两套同号实证)。
- **现状证据**:tracker_work_items.branch 近乎恒空(实测 59/63 为空)、
  orchestrator_run_id 单槽且不随重派更新(B2 实证);open 清单里
  SDLC-033/034/056/057 各有两条同号(DB 实测,即本项要根治的重号)。
- **可证伪验收**:①B2 式取消重派后,tracker 显示两条 run 记录且各可跳转;
  ②push 后 60s 内 branch 字段非空;③20 并发建单零重号。
- **依赖**:F0、F9(回写通道运载)。
- **页面**:涉及——S4 工作项详情(执行组:关联运行/分支回链行);
  原型:**已完成**(待接真数据)。

### F9 确定性回写通道(M4-D)【已交付 2026-07-12】(设计出处 02 §6 回写通道 / 04 §13 tracker-client)

- **做什么**:orchestrator reconciler 在 run 终态回调 tracker(advance-stage/
  证据载荷/回链更新),不依赖页面打开或 brain 在场;tracker 的 get-activity 裸 SQL
  跨 app 查询改走 orchestrator action。
- **为什么是地基**:它是 F3 守卫和 F8 回链的**自动运载工具**;没有它,"run 终态
  阶段永久停实施"(SDLC-045)只能靠人肉。
- **现状证据**:SDLC-025 open;run 终态后阶段不动(实证);get-activity 裸查
  brain_tasks(SDLC-034b)。
- **可证伪验收**:无任何页面打开、brain 不介入,run 终态后 60s 内阶段推进且
  证据载荷完整(重放 B1 场景全自动走到待评审)。
- **依赖**:F3(守卫先立,回写按守卫走)。
- **页面**:无(体现为阶段自动推进,无新控件)。

### F10 引擎终态传导完备【已交付 2026-07-12】(设计出处 02 §4 R9 终态传导不变量)

- **做什么**:spawn 终态必须驱动节点迁移(failed 或重新入队),节点不悬挂;
  nodeRetry 对此类节点可用;runCancel 返回语义修正。
- **为什么是地基**:B2 实证 spawn 被 reconcile 重置后节点永久 running、无法 retry
  不再入队,只能整 run 作废——执行引擎自身的故障语义是所有 DAG 场景的地板。
- **现状证据**:SDLC-050 在案;dogfood main 已有 f9b72161b(reconcile 加宽,
  捕 stuck ready/pending)——**但该提交不在框架分支**(F0 的活例证);
  spawn→node 传导仍缺。
- **可证伪验收**:**kill 活 spawn 的注入方式**(无按-spawn 的外部 kill API——`runCancel` 仅 DB
  翻转且被 spawn 收尾覆盖,in-process vLLM spawn 无独立 PID/句柄):Claude-Code 节点=`kill` 其
  `claude` 子进程 PID;vLLM 引擎节点=运行期重启 orchestrator 进程(重启后该 `v3_spawns` 行停在
  非终态,精确复现 B2 卡死)。观测=节点 60s 内进 failed 且 nodeRetry 可复活;重放 B2 场景不再需要
  整 run 作废式 runCancel。**故 F10 交付含**:重启/reap 后侦测非终态 spawn→驱动其节点迁移
  (failed 或重新入队),这也是"kill 后节点不悬挂"得以成立的前提。
- **依赖**:F0。
- **页面**:无(复用 S7 现有节点/spawn 状态视图)。

### §1.11a 原型欠账(设计已有、原型未同步)

上列「页面」标注中,4 处为 v2.2/v2.2.1 设计已定稿但原型屏未跟上的欠账
(逐屏 grep 实测:零命中或仅入口标识):

- **S4 受守卫流转对话框**(F3)——shield-lock 入口已加,对话框本体未做;
  其完整交互由独立的 **F1–F4 实施细则文档**承接。
- **S2 规划工作台:Briefs 规模告警 + 一键拆分**(F5)——未做。
  (repo 已补,2026-07-16 已同步生产 design)
- **S5 评审卡:按 nature 装配的结构化核对清单控件**(F6)——评审卡已加,
  核对项控件未做。(repo 已补,2026-07-16 已同步生产 design)
- **S9 模型注册表区 + 降级显式告警 / S10 遥测可信卡**(F7)——未做。
  (repo 已补,2026-07-16 已同步生产 design)

原型欠账不阻塞对应 F 项的引擎侧交付,但阻塞场景③(S4/S5 两处)与场景①
的证据可达性走查;补齐时序:随对应 F 项交付,最迟在进入阶段二前。

### §1.12 地基验收门(全绿才关阶段一)

一套可重复执行的清单,脚本化保存在仓内。

**执行前置(两条,决定这套门是否真能在 101 上跑)**:①**隔离靶位**——破坏性注入(空库跑迁移、
删迁移、删 ACP 包重启、kill/重启进程)不得针对共享 `an-postgres` 生产库与 18 应用共用的常态容器:
空库迁移用一次性库(`createdb` 临时库),迁移号/建表注入在一次性 clone 或临时 project 上跑,
进程类注入在维护窗口对目标容器单独做;②**brain 以 API key 运行**(非个人订阅——订阅跑自动化会
触发账号风控,见既有教训),否则依赖 brain/CC 在场的门(F7③、小单走查)不可稳定复现。
**SSH 边界**:故障注入的**布置**(kill 进程、删包、推镜像)允许用 SSH/进程操作——它模拟的就是
infra 失效;但每条的**观测判据**必须页面或 DB 可读,不靠人肉旁证。

1. **单测层**:tracker/orchestrator 全量 vitest 绿(含 B1-B5 带入的测试)。
2. **迁移冒烟**:一次性空库全迁移→schema 对账断言(F6①)。
3. **故障注入六连**(注入方式各见对应 F 项验收,均已写到"第一步怎么注入"):基线过期建区(F1①)/
   掐流断传(F2,切 vLLM 连接或重启 orchestrator)/无 verdict 写 done(F3①)/评审期写文件(F4①)/
   kill spawn(F10,CC 子进程 PID 或重启 orchestrator)/删 ACP 包重启(F7③)。
4. **完整小单走查**:一个 B1 规模的真实 issue 全自动走完
   派发→dev(TDD 证据)→独立评审→合并→回写,人工只做批准;全程回链可点、
   遥测可信、**证据链零 SSH 干预**(与上面注入布置的 SSH 不同层——这里指跑通业务不需要命令行)。
5. **交付溯源**:当日部署工件可反查 build sha(F0③)。

## §2 阶段二 · 核心场景跑通(判据:真的用起来)

> 每个场景四域收口(UI/actions/skills/application_state),验收剧本可重复执行。
> 场景暴露地基缺陷时:回阶段一修,不绕。

### 场景① 单 issue 全流程(系统的"主动脉")

**剧本**:在 tracker 页面建一个真实 issue(非测试数据)→ 规划工作台写 brief
(规模告警在岗)→ 页面派发 → dev 节点产出(TDD 证据工件)→ 独立评审门
(核对清单+verdict)→ gap 检查 → 合并交付主干 → **部署到 101** → 新能力页面可见
→ 工作项页可从头到尾点开每一环证据(run/diff/测试/审批/audit)。
**最小充分页面集(本场景要接通的收口,现状缺口已核实)**:证据五类今日多不可从 issue 页抵达——
run 只是 issue 页 ActivityFeed 里的只读状态卡(无深链)、diff/测试证据在 tracker 侧缺失(只在
orchestrator `WorkspaceView`/`RunView` 有)、审批是 QueuePage 的 toast 桩、audit 只有活动流无正式
面。故本场景的可达性以这组链接为准:issue 页 →(a)orchestrator `RunView`(/runs/:id,含节点输出与
测试证据)、(b)`WorkspaceView` 的 DiffViewer(diff)、(c)接真的审批记录(去桩)、(d)一个可渲染的
audit 面(list-audit 现为 action-only)。这四条链任一不可点=场景①未收口。
**验收**:业务全程零 SSH/psql;每个状态迁移都有守卫记录;从 issue 页经上述四链能还原完整证据链。
**依赖**:F1-F10 全部。

### 场景② Sprint Goal 闭环(v2.1 设计的灵魂)

**剧本**:建 sprint 并写含 M 编号指标的 sprint-doc → extract-goal-metrics 结构化
提取 → 驾驶舱 Goal 卡实时读数 → 各单交付后指标回填 → gap-analysis 按 Goal 判
MET/PARTIAL/UNMET → 有缺口生成 from-audit 子单 → NO_GAPS 才允许关闭 sprint。
**部署前置(必须先写清,否则 M1-M5 无从回填)**:自举 sprint「S-v2.1 地基第一批」(DB 实测 id
`mllhaszis6`)现处 planning、**无 sprint-doc 产物、无 goal 指标落库**,其 M1-M5 度量的是 B1-B5 交付的
能力(SDLC-039~043,已合入 dogfood main);而这些能力**merged 但未部署**——`extract-goal-metrics`
等 action 只在 dogfood main、live 未必带,指标回填读的是 live 页面读数。故本场景的第一步不是直接
"走闭环",而是:(0)先经 F0 部署脚本把 B1-B5 落到 101 live(带 build sha 溯源),(1)再补写该
sprint 的 sprint-doc 与 M 编号指标,之后闭环才有可回填的真实读数。跳过 (0)(1) 则 gap-analysis 判的
是空指标,验收无意义。
**验收**:把自举 sprint「S-v2.1 地基第一批」作为第一个真实对象走完此闭环
(M1-M5 逐条实测,读数取已部署 live);closed≠done 的语义在页面可见。
**依赖**:F3/F8/F9 + B1/B5 交付的 action 面(extract-goal-metrics、set-artifact-review
已在 dogfood main)+ **gap-analysis 能力**(sdlc-gap-analysis workflow + goal-metrics
确定性提取 + NO_GAPS 门,02 §1.1/§3.3)。**分层归属**:gap-analysis 不是 §3 功能补充,
而是本场景的组成能力,在阶段二随场景② 交付——它是设计里 auditing 相位的核心机制,场景②
无它即无法判 NO_GAPS、关不了 sprint;地基两判据(§0.1)只挑"每个场景都踩"的通用地基,
gap-analysis 仅场景② 专用故不入地基,但必须与场景② 同阶段落地,不得下沉 §3。对应 open 单
为第二个 SDLC-033(PhaseH 目标审计,现尚无 action)。

### 场景③ 人工评审 UI 一等化(把人请回页面)

**剧本**:S5 收件箱「评审请求」出现真实待审卡(diff 统计+测试证据+核对清单)→
人在页面逐项核对(新表↔迁移等硬项未确认则批准置灰)→ 批准=守卫迁移+合并触发,
驳回=fix 模式重派 → S4 工作项页受守卫流转控件可用(含未派发项关闭)。
**验收**:重放 B5 那次评审——在页面上完成同样的"拦下缺迁移→驳回→fix→复审→
批准"全程,零命令行;审计能区分人与 agent 的每一步。
**依赖**:F3/F4/F6 + 03 章评审卡设计。

## §3 阶段三 · 功能补充(每项标注踩在哪块地基上)

- **工作流族补全**:reviewer/gatekeeper 节点化+评审证据 run 级、mode=fix 预设、
  hotfix/spike/docs 流(踩 F2/F4/F5/F10;SDLC-055)。**注:sdlc-gap-analysis 不在此列**——
  它是设计里 auditing 相位的核心机制(02 §1.1/§3.3),不是功能补充,已随场景② 前移到
  阶段二交付(见 §2 场景②),此处仅指其余模板的硬化。v3_workflow_templates 已有
  sdlc-issue-pipeline(14 节点)、sdlc-review、sdlc-audit 等模板(自举遗留),此处是把它们
  硬化并把评审证据落到 run 级,不是从零新建。
- **Epic 拆解与依赖图**:decompose-epic 已有 action(dogfood main),补 UI 与
  blocked-by 派发门联动(踩 F3/F8;M3-D 已交付调度器一半)。
- **UI 设计子流程**:ui-spec 技能、原型流水线、UI 评审门,design/content 协作
  (踩场景③的评审骨架)。
- **content 项目文档库自动归档**:agent 把 sprint 产物放入
  `SDLC 项目文档库/<项目>/Sprint N/` 并回链 tracker(05 章 §5 规范;踩 F8)。
- **brain 循环第二受益者**:sdk-brain-session 手搓 generateText 循环接入 B 方案
  (踩 F2;执行器调研附带发现)。
- **V3 预算护栏**(SDLC-027)、**共享与权限**(SDLC-032 registerShareableResource、
  SDLC-033 ownerScope→accessFilter)、**A2A 场景**(composable-mini-apps)。

## §4 阶段四 · 细节与优化

- 度量复盘 M5(SDLC-026:燃尽/sprint-story/recap)与洞察页;
- 性能(热路径索引、列投影、轮询成本;`performance` skill 口径);
- audit-log 面完善、i18n、S1-S11 原型逐屏对齐实现;
- 体验打磨(乐观更新、空态、加载态;`frontend-design` 禁则全量走查)。

## §5 反堆砌护栏

### 5.1 不做清单(现阶段刻意不做,写明原因)

- **不做多仓/多项目编排**——单 dogfood 镜像把证据链跑扎实以前,多仓只放大混乱(F0 的反面)。
- **不做 microVM 真隔离**——NoneRuntime 满足现容量;隔离是容量问题不是正确性问题。
- **不做 harness 替换式执行器(homerail 路线 D)**——调研已否:无物可移、破坏零公网出口设计。
- **不做并行多 sprint 自动派发**——顺序纪律在案(迁移撞号教训),并行等 F6 防撞落地后再议。
- **不接第三方 CI**——地基验收门先以仓内脚本可重复执行为准,避免把可信度外包。
- **不做移动端/SEO/多主题**——与证据链无关的表层。
- **不把回滚/热修路径立为地基项**——坏部署是**响应式失效**(页面打不开、locale-kit 崩溃),不是
  静默毁证据;F0 的部署溯源+verify 步已负责"发现",回滚是运维 runbook(归 §4 运维打磨),不占
  阶段一。
- **不把数据备份/灾备立为地基项**——CLAUDE.md 的加性迁移禁则(不删/改表列)已挡住证据链层面的
  破坏;备份是 DR 运维、与 build-order 正确性正交,列为四阶段之外的运维前置而非地基。
- **不把 vLLM 单点/GPU 机冗余立为地基项**——vLLM 宕是**响亮失效**(02 §6 健康前置门在派发前直接
  拒绝并写原因),属容量/可用性,同"不做 microVM"逻辑;真正要防的静默失效是遥测冒名(已在 F7)。
- **不做 A2A/JWT 安全面硬化(超出回写身份)**——回写通道的身份正确性已在 F9 依 02 §6"身份取 run
  tags 铸 JWT"约束;更广的 A2A 鉴权、密钥轮换、跨 org 加固归 §3(A2A 场景)与 security skill,现阶段
  单 org 自举下不是证据链地基。

### 5.2 止损判据

- 每阶段验收门**全绿才进下一阶段**;门不绿而想"先做点下一阶段的"=堆砌,禁止。
- 阶段二/三任何场景暴露地基缺陷:**回阶段一修并补故障注入用例**,不在场景层绕。
- 任何新增项先问两条地基判据(§0.1);都不满足→进 §3/§4 排队,不插队。**例外**:某个
  阶段二场景跑通所必需、缺它该场景就无法验收的组成能力(如场景② 的 gap-analysis),随该
  场景在其所在阶段交付,不因"非通用地基"被判据挤出阶段二下沉 §3——两判据是"挑地基"用的,
  不是把场景必需件排出场景阶段的借口。
- tracker 问题池是唯一欠账台账:发现即立 issue,修复必须回链 issue 关闭,
  不允许"顺手修了没记录"。

## 附:与 open issue 的映射

> 消歧提示:SDLC-033/034/056/057 是 F8 所指重号 itemKey(各两条 open),引用时必须带
> 义项后缀——本表消歧本身正是 F8 要根治的问题。与 tracker open 池(35 条 SDLC-*)双向对账,
> 无失引(所引 issue 全部存在且 open),下列为新补全的映射。

**地基项↔issue**:F1(056-基线过期 / 057-无测试环境 / 059) F2(058 / 057b-64k钳制)
F3(045 / 056b-未评审即done / 063 + 未派发项关闭通道) F4(052 + 审计簇八;债务跟进 062-B2事务债)
F5(簇九) F6(061 / 037) F7(051 / 054 / 049 / 060 / 046 + 048-模型目录缺 sonnet-5)
F8(053 / 038) F9(025 / 034b-get-activity) F10(050)。

**场景层↔issue**:场景①③(029-全流程纯页面可驱动审计 / 044-TDD红先行+测试执行证据未强制)
场景②(047-Success Metrics 行文法 / 033-PhaseH-目标审计即 gap-analysis)。

**阶段三承接**:027 / 032 / 033-accessFilter(ownerScope 迁移)/ 034-PhaseG晋升 / 026 /
055-评审守门DAG化 及工作流族。

**范围外**:031(V3引擎DB迁出 pg-core,属框架 core 层,failed 状态,非 SDLC 应用层地基)。
已修复关闭项不再列。
