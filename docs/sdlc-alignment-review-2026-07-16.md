# SDLC 现状对齐审查(2026-07-16)

> 目的:把 v2.2 设计文档、最新代码(main@3e79321bd)、101 生产部署、以及数据库里的**真实运行痕迹**四层对齐,回答两个问题:①现在到底做到了哪里;②距离「用 tracker+orchestrator 管理应用开发全流程、orchestrator 真正自动化开发」还差什么、按什么顺序补。
> 事实基础:git 历史与代码逐文件核对、101 容器与产物 mtime 核对、Postgres 只读查询、content/design 两服务线上资产逐篇比对。凡「已交付」均有部署+冒烟证据;凡「未运转」均有 DB 计数证据。

## 一、一页结论

<table header-row="true">
<tr>
<td>层面</td>
<td>状态</td>
<td>证据</td>
</tr>
<tr>
<td>机制层(F0–F10 地基,11 项)</td>
<td><b>~85% 已交付并部署</b>(F2b 消费端切片已在分支交付,待部署 101)</td>
<td>2026-07-12 合入统一主干并部署 101,迁移落库、功能冒烟通过;2026-07-16 随全量重建仍在线</td>
</tr>
<tr>
<td>代码↔部署对齐</td>
<td><b>已对齐</b>:101 ≈ main HEAD</td>
<td>2026-07-16 13:55–14:15 全量重建部署(13 应用),content 产物已含 main 最新提交字符串;ACP 包、四条 V3 迁移、brain 默认模型均在位</td>
</tr>
<tr>
<td>真实运转</td>
<td><b>停摆 4 天</b>:07-12 后 v3_runs = 0</td>
<td>F4 phase、F7 model_real_name、F9-B 回写事件计数全部为 0——三项能力从未被真实运行触发过</td>
</tr>
<tr>
<td>自动化开发能力</td>
<td><b>已被证明、未在运转</b></td>
<td>07-08 系统身份 orchestrator@an.local 自主产出 3 个质量合格的提交(run 限额+CI watch+PR merge),曾被搁置;本次已抢救移植并合入 main(1fd9783fb),移植中还修复了原提交的一处并发锁泄漏隐患(见 §四 R1)</td>
</tr>
<tr>
<td>对照完整 v2.2 产品(UI+工作流族+四域集成)</td>
<td><b>~20%</b>(区间 15–28%)</td>
<td>约 21 个设计屏中 6 建成/9 半成/6 缺失;九模板工作流族、规划技能链、design/content 域集成基本未起步</td>
</tr>
</table>

**核心判断:当前最大的瓶颈不是"再造机制",而是"让系统转起来"和"给已有机制接上 UI 通路"。** 守卫、回写、遥测、终态传导的钢筋都浇好了,但没有一次真实运行去压它们,人也没有界面去走完一条脊柱场景。

## 二、逐领域对照(设计 → 代码 → 部署 → 真实运转)

<table header-row="true">
<tr>
<td>领域</td>
<td>设计出处</td>
<td>代码</td>
<td>101 部署</td>
<td>真实运转</td>
</tr>
<tr>
<td>F1 工作区契约</td>
<td>路线图 §1</td>
<td>✅ main</td>
<td>✅</td>
<td>❌ 未触发</td>
</tr>
<tr>
<td>F2 执行器上下文</td>
<td>路线图 §1</td>
<td>✅(F2b 消费端已在分支交付,待合并)</td>
<td>✅</td>
<td>❌ 未触发</td>
</tr>
<tr>
<td>F3 状态守卫+人工流转</td>
<td>02 章/F1-F4 细则</td>
<td>✅ main</td>
<td>✅ 冒烟通过</td>
<td>◐ 冒烟验证过,无日常使用</td>
</tr>
<tr>
<td>F4 能力面矩阵/评审分离</td>
<td>路线图 §1</td>
<td>✅ main</td>
<td>✅</td>
<td>❌ brain_threads.phase 全 NULL</td>
</tr>
<tr>
<td>F5 规模门</td>
<td>F5-F10 细则</td>
<td>✅ main</td>
<td>✅ 冒烟通过</td>
<td>◐ 冒烟验证过</td>
</tr>
<tr>
<td>F6 迁移对账+核对清单</td>
<td>F5-F10 细则</td>
<td>✅ main</td>
<td>✅</td>
<td>◐</td>
</tr>
<tr>
<td>F7 遥测/身份单一事实源</td>
<td>路线图 §1</td>
<td>✅ main</td>
<td>✅</td>
<td>❌ model_real_name 计数 0</td>
</tr>
<tr>
<td>F8 itemKey 权威</td>
<td>F5-F10 细则</td>
<td>✅ main</td>
<td>✅ 冒烟通过</td>
<td>◐</td>
</tr>
<tr>
<td>F9/F9-B 确定性回写</td>
<td>路线图 §1</td>
<td>✅ main(持久 outbox 为后续项)</td>
<td>✅</td>
<td>❌ 回写事件计数 0</td>
</tr>
<tr>
<td>F10 终态传导</td>
<td>F5-F10 细则</td>
<td>✅ main</td>
<td>✅</td>
<td>❌ 未触发</td>
</tr>
<tr>
<td>运行限额兜底 / CI watch / PR merge</td>
<td>02 章工作流族的组成件</td>
<td>✅ 本次抢救移植并合入 main(1fd9783fb,含原提交并发锁隐患修复)</td>
<td>❌ 待部署(门槛:先跑一次真实运行验证 checkRunLimits)</td>
<td>❌</td>
</tr>
<tr>
<td>九模板工作流族</td>
<td>02 章 §工作流族</td>
<td>❌ 仓内零种子(2026-07-16 复核订正:101 DB 实有自举遗留多套模板——sdlc-issue-pipeline 14 节点 v1–v4、sdlc-review/audit/full/promote/dev,原"仅单节点 sdlc-dev 活在 101 DB"有误;待收编入仓、硬化、种子化)</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td>规划域技能链(六技能)+ gap-analysis</td>
<td>02/03 章</td>
<td>❌ 未建</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td>tracker UI 屏</td>
<td>03 章</td>
<td>◐ 约半数半成:收件箱/规划工作台/度量/Epic 依赖图缺失;受守卫流转对话框已交付(2026-07-16 复核订正:41fe0b51b 起 WorkItemDetailPage 的 GuardedTransitionDialog 调真实 transition-work-item,原"后端在、UI 未接线"有误);队列审批仅排队人工门一路仍是 toast 桩(QueuePage :536-544),签核/裁决审批卡一路已接真 approve-gate/reject-gate(:546-552)</td>
<td>同代码</td>
<td>—</td>
</tr>
<tr>
<td>orchestrator UI 屏</td>
<td>04 章</td>
<td>◐ RunView/Workspace/Spawns/Settings 真实;驾驶舱/引擎注册表/健康页/洞察缺失;模型注册表有后端无 UI</td>
<td>同代码</td>
<td>—</td>
</tr>
<tr>
<td>design 域 SDLC 集成(ui-spec 子流程)</td>
<td>05 章</td>
<td>❌ 未建(原型资产是手工发布的,非集成代码)</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td>content 域 SDLC 集成(自动归档)</td>
<td>05 章</td>
<td>❌ 未建</td>
<td>—</td>
<td>—</td>
</tr>
<tr>
<td>audit/安全对齐(alignment audit P0)</td>
<td>agent-native-alignment-audit.md</td>
<td>✅ 已修并入史(fail-closed、参数化、fail-loud、删 V2 死层)</td>
<td>✅</td>
<td>✅ 常态生效</td>
</tr>
</table>

图例:✅ 完成 ◐ 部分 ❌ 缺失。

### 本轮期间上游送来的免费收敛机会(建议尽快接)

- **`agent-native doctor` CLI**(core 0.97.0):自动扫"未域控凭据/未域控查询/env 凭据读取/兜底身份"等 7 类问题——恰好覆盖我们审计修过的漏洞类别。两应用的 agent-native.json 均未启用,接入即得回归防护网。
- **官方 `verifyA2AToken` / `actionRouteAuth`**(core 0.101.0):我们手搓的共享 mcp-client JWT 部分从此有官方替代,P3 后续可收敛。
- **A2A owner/org 上下文保真修复系列**(0.98.x–0.99.x):对 tracker↔orchestrator 互调的正确性直接有利,已随部署生效。
- **全页 Agent 工作区 `AgentTabsPage`**(core,`8e6f022fa`,`/agent`,Context/Files/Connections/Jobs/Access 五 tab):两应用均未挂载,建议直接挂(参照 brain/dispatch 模板的挂载动作,半天量级、不需新建 action)。对 T-D 只是既有机制的 UI 通路而非后端修复(automations/event-bus 接线仍要单独做);对 04 章引擎注册表/智能体/健康页无替代关系(语义不同,继续独立成页);价值集中在 tracker 此前缺失的 Files/Access 界面,以及给 tracker↔orchestrator 新增一条 `@提及` NL 委托的补充通道(不改变、也不治理现有确定性回写链路)。

## 三、文档与设计资产修订记录(本次执行)

<table header-row="true">
<tr>
<td>问题</td>
<td>处置</td>
</tr>
<tr>
<td>路线图(24OzeoGlaJL9)仍标 8 项 F 能力【缺失】,与部署事实矛盾</td>
<td>全部状态标签修正为【已交付 2026-07-12】(F2 注明 F2b 待办,已于 2026-07-17 在分支交付——见 T-F2-06),加时点声明,repo+content 双改</td>
</tr>
<tr>
<td>《F5–F10 详细实施方案》从未发布到 content</td>
<td>已发布为新文档,挂在 v2.2 文件夹下、与 F1–F4 细则并列</td>
</tr>
<tr>
<td>生产 design 的 4 屏(s2/s5/s9/s10)落后 repo:F5 规模告警/F6 核对清单/F7 模型注册表+遥测卡 未同步</td>
<td>已用 update-file 同步发布;S4 受守卫流转对话框经 2026-07-16 复核订正:repo 原型自 c0c7e66d1(07-12)即含完整对话框本体(c18c8ee84 补 fm-overlay 开合动效),生产 design s4 与 repo md5 一致——原"两边都未补"有误</td>
</tr>
<tr>
<td>00 章 §7「与现状的关系」是 v2.0 时点快照,严重过时</td>
<td>表格前加时点声明,指向《F0–F10 实现说明》与本文</td>
</tr>
<tr>
<td>05 章引用"v2.1·Foundry 原型"、design 描述引用"v2.0"</td>
<td>版本号统一修为 v2.2</td>
</tr>
<tr>
<td>旧调研/审计文档群(07-06~07-08 五篇)结论已被 v2.2 树部分取代</td>
<td>不改内容,定位为历史时点记录;以 v2.2 树 + 实现说明 + 本文为准</td>
</tr>
</table>

## 四、通向目标的差距与建造顺序

目标重述:**用 tracker 管理应用开发全流程(需求→拆分→派发→评审→验收→发布),orchestrator 接单后真正自动化开发,全程有守卫、有证据、有回写。**

按依赖与价值排序(每条带验收判据)(执行级展开见《SDLC 实施规划(R1–R5 执行版)》):

### R1 让系统重新转起来(先决,当周可完成)
- ✅ 已收编 recover/sdlc-issue-pipeline(运行限额兜底 + workspaceCiWatch + workspaceMergePr)并合入 main(1fd9783fb)。移植适配:迁移改写为 name-based 幂等(sdlc-run-limits);修复原提交 mergePr 的 session 级 advisory lock 连接池泄漏隐患(改事务级 xact_lock);验证 workspace-local 12/12、真实 PG 迁移冒烟 2/2、零新增失败。**待办:部署到 101——门槛是先跑一次真实运行验证 checkRunLimits(该函数无既有测试覆盖,且 v3-reconciler.spec.ts 在纯净 main 上即卡死,见下)。**
- 🆕 独立发现:`v3-reconciler.spec.ts` 在未经改动的 main 上以 99% CPU 卡死(疑似某 test 顶层同步死循环),vitest testTimeout 无法拯救——仓库既有 bug,修复后才能给 reconciler 变更以自动化回归保障。
- 清理孤儿状态(SDLC-042 无 run_id 的 running 项)并复活「SDLC自举」dogfood 循环:从 tracker 建一张小票 → dispatch → orchestrator 跑通一个 V3 run。**验收:v3_runs 出现 07-16 后的新 run;F4 phase、F7 model_real_name、F9 回写事件三个计数从 0 变为正数——这一条同时是 F 项机制的首次真实验证。**

### R2 场景①端到端走通(脊柱场景)
单 issue 全流程:建单→规模门→派发→自动开发→评审→写回→守卫流转→验收→PR 合并(用 R1 的 CI watch/PR merge)。**验收:一张真实 issue 从 open 到交付全程零人工 SQL,状态轨迹与证据链完整可查。**

### R3 给机制接上 UI 通路(机制已有、只缺界面的三处优先)
收件箱(list-inbox/resolve)、issue 页证据链(run/diff/test)、队列审批真实化(替换排队人工门一路的 toast 桩;签核/裁决审批卡一路已接真)。原列首位的"守卫流转对话框接线 transition-work-item"经 2026-07-16 复核已于 41fe0b51b 交付(GuardedTransitionDialog),从待办转为回归核对项。随后:模型注册表页、健康页(后端 action 已在)。**验收:一个人不碰 agent 聊天窗,纯 UI 走完场景①的人工环节。**

### R4 工作流族与规划技能链
把 sdlc-issue-pipeline 扩成第一个真实多节点 DAG 模板(dev→qa→reviewer→gatekeeper→diff-audit→PR→CI→merge)入库带版本;随后 hotfix/docs-task/quick-task 族;规划域六技能(brainstorm/sprint-plan/sprint-test-plan/ui-spec/sprint-design/sprint-review)+ gap-analysis action 支撑场景②(Sprint Goal 闭环)。**验收:场景②③按路线图 §2 判据走通。**

### R5 四域打通(design/content 集成)
ui-spec 子流程(设计稿→评审→实现比对)、content 项目文档库自动归档。**验收:一个带 UI 的 issue 走完 05 章旅程,产物自动落库。**

> 工程卫生并行项:接入 agent-native doctor;audit backlog 里的 O12(action 面收敛)、T-D(automations 替代 4s 轮询)、O13(去残余硬编码)按机会处理;F2b(已交付,见 T-F2-06)、回写持久 outbox 排入 R2 之后。

## 五、UI/设计系统:Foundry v3(本次交付)

参照物已实证锁定:**multica.ai(同品类开源 agent 协作平台)**,取其源码级动效语言(Linear 式克制、工程驱动),与 Foundry 的 OKLCH 体系天然兼容。v3 变更:

- **动效 tokens**:时长梯度 120/240/400/700ms + 氛围循环档 1.6/2.5/3.2s;曲线收敛为 standard(0.4,0,0.2,1)/enter/exit 三件套,回弹曲线(0.5,1.5,0.4,1)仅限完成/庆祝时刻。
- **招牌模式**(源码移植):thinking 文字扫光(agent 运行态,替代 spinner)、导航进度扫条(1.4s,路由 pending 态)、活跃态克制脉动(1.6s,只动色彩与阴影)、两段式完成动效(徽章回弹→打勾描边)、数字计数动画。
- **红线**(实证背书):无 stagger 表演、无视差、无自定义光标;overflow 容器内禁位移动效(防滚动条闪烁);拖拽/手势进行中禁用一切 transition;全量 prefers-reduced-motion 降级。
- **落地**:design 服务的 Foundry design system(customCSS+custom_instructions)、《Foundry·组件规范》新增动效章、_foundry-skeleton 内嵌 motion 基建、11 屏原型逐屏套用;生产应用(React+Tailwind+shadcn)以同一套 token 通过 tailwind 主题扩展 + data-state 全局覆盖统一 shadcn 组件节奏。

---

*本文取代所有更早文档中的「现状」表述;机制细节见《F0–F10 实现说明》(/page/eC0amjYq04IE)与两份实施细则;架构约束见 agent-native-alignment-audit(其 §5 裁决的合理偏离不再作为问题重提)。*
