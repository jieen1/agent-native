# Orchestrator v2 — 实施规划（Implementation Plan）

> 本文是 [DESIGN.md](./DESIGN.md)（架构设计）与 [FRONTEND.md](./FRONTEND.md)（前端/交互设计）的**实施配套文档**。
> 它**不重写**任何设计内容——凡设计已说清的（节点类型、状态机六维度、NodeRunner 七阶段、
> 各 type 的 pipeline、API 锚点等）一律以 `DESIGN §x` / `FRONTEND §x` 引用，本文只补三样东西：
>
> 1. **可执行的任务拆解**：每阶段要落地的数据表 / actions / 引擎模块 / 前端面 / 技能，逐项列清。
> 2. **严格、可测的验收标准**：每阶段给一组可勾选、可用命令或可观察现象验证的 Acceptance Criteria。
> 3. **关键实现逻辑**：仅在设计留白或需要进一步定形处，用**伪代码 / 要点**表达（不写真实代码）。
>
> **基线事实**（与当前仓库代码核对一致，详见 §0.1）：v1/v1.5 已落地 `tasks`/`step_runs`/`workflows`/
> `runtime_configs` 表、21 个 actions、Settings→Runtime UI、Claude Code 登录探测、vLLM 激活（走内置
> `ai-sdk:openai`）。执行仍是 `run-orchestrator` 播种行 + 返回指令串，由 chat agent 手工走（无确定性调度器、
> 无 microVM、无控制/观测 API）。v2 = 在此之上叠加图引擎 + microVM 执行 + PM/队列 + 可视化编辑器。
>
> **本规划的硬约束（由用户拍板，覆盖 DESIGN §16 的“价值优先可缓 microVM”建议）：**
> - **microVM 执行隔离不可省、且前置**：真实代码/agent 节点执行**始终**经过 microVM（DESIGN §7.4），
>   不存在“在宿主机直接跑代码”的发布路径。基础设施验证（§P0 spike）作为**闸门**先做。
> - **可视化编辑器（React Flow）完整纳入主线**：不走“先 JSON 凑合”的捷径，按 FRONTEND §6 完整实现。
> - 全部按设计实施，不做功能妥协。

---

## 目录

- [0. 总纲：范围、不变量、待确认决策、验收方法](#0-总纲)
- [P0 — 基线收尾 + 基础设施闸门](#p0--基线收尾--基础设施闸门)
- [P1 — 图模型 + 确定性调度引擎（全控制流，无副作用核心）](#p1--图模型--确定性调度引擎)
- [P2 — 统一 NodeRunner over microVM + 三执行器 + 交付](#p2--统一-noderunner-over-microvm)
- [P3 — Projects / Work Items / 状态模型 / 队列 / Node Library / 动态编排](#p3--projects--work-items--状态模型--队列)
- [P4 — 完整前端：React Flow 编辑器 + 9 页 + run overlay](#p4--完整前端)
- [P5 — Runtime 配置收尾（per-node 选型 / vLLM Test / 路由消费）](#p5--runtime-配置收尾)
- [P6 — Hardening / 持久化 / 多机可移植](#p6--hardening)
- [附录 A：设计章节 → 阶段 → 交付物 追溯矩阵](#附录-a追溯矩阵)
- [附录 B：Action 全量清单与归属阶段](#附录-baction-全量清单与归属阶段)
- [附录 C：数据表新增清单与归属阶段](#附录-c数据表新增清单与归属阶段)

---

## 0. 总纲

### 0.1 当前已实现基线（v1/v1.5，复用、不重建）

| 类别 | 已有 | 文件 |
|---|---|---|
| 数据表 | `workflows` · `tasks` · `step_runs` · `runtime_configs` · `task_shares` · `workflow_shares` | `server/db/schema.ts`，迁移 `server/plugins/db.ts`（v1–7） |
| 共享类型/校验 | `WorkflowStep`/`Task`/`StepRun`、`parseSteps`、`topoSortSteps`、`validateWorkflowDag`（线性/分支 DAG，**无** fanout/loop/join/branch 语义） | `shared/types.ts` |
| Actions（21） | task CRUD、workflow CRUD、`run-orchestrator`（仅播种 + 返回指令串）、`upsert-step-run`、`list-step-runs`、`stop-task`、runtime 配置 6 个、`navigate`、`view-screen`、`run.ts`（headless 分发器） | `actions/*.ts` |
| 前端 | `_index.tsx`（任务平铺列表，非 kanban）、`tasks.$id.tsx`（运行=调 `run-orchestrator` 后 `sendToAgentChat`）、`workflows.$id.tsx`（**原始 JSON `<Textarea>` 编辑器**）、`settings.tsx`（Runtime UI 已成形） | `app/routes/*.tsx` |
| Runtime（v1.5 已成形，DESIGN §8.1） | `runtime_configs` CRUD、`activate-runtime`（claude-code 写 `orchestrator-runtime` marker；vLLM 写 `agent-engine`+服务端占位 `OPENAI_API_KEY`）、`get-runtime-status`（读 `~/.claude` 过期）、`start-claude-code`（仅登录探测/Test，框架 harness 不可用 DESIGN §7.0b） | `actions/`、`server/claude-code-status.ts`、`server/register-runtime.ts` |
| 技能/Agent | `orchestrating/SKILL.md`（v1 手工走 step）、`CLAUDE.md`/`AGENTS.md`（v1 surface）、`agent-chat.ts`（已是 orchestrator 身份） | `.agents|.claude/skills/`、`server/plugins/agent-chat.ts` |

> 复用原则：v1 表与 actions **一律保留**（数据契约禁止破坏性迁移，DESIGN §9），v2 新表新 action **叠加**；
> `runtime_configs` 保留其现有手搓 `ownerEmail`/`orgId` 形状（DESIGN §9 注、§14）。

### 0.2 全局不变量（贯穿所有阶段，任何阶段实现都不得违反）

这些是 DESIGN 反复强调、最容易在实现中被破坏的硬规则。落到每个 PR 的 review 清单：

1. **确定性调度（DESIGN §1.1/§1.7）**：调度器是纯编排，**无文件/shell 副作用、无 wall-clock、无 RNG 分支**。
   任何时间戳/种子是显式 run 输入。只有 leaf `agent`/`tool` NodeRun 触碰外界。
2. **中间状态只存 NodeRun artifact（DESIGN §1.1 框架强化注）**：绝不把运行中间态塞进 chat transcript
   （会被 Observational Memory 折叠丢失）。一切 id 寻址。
3. **pipeline 默认、barrier 显式（DESIGN §1.3/§4.1a）**：相邻依赖节点默认流水线推进；`join` 是**唯一**
   引入 barrier 的地方，必须是用户/brain 显式放置的节点。
4. **item-correlation（DESIGN §4.1a）**：NodeRun 身份 = `(nodeId, iteration, fanoutIndex)`；fanout 作用域内
   边 index-preserving（`A_i→B_i`，N 条独立链）；join 基数在“最近上游 fanout 的数组物化时”封板；
   中途单 item 失败丢该 item、兄弟继续（除非 `failFast`）。
5. **状态单写入口（DESIGN §6.2a/§6.2b）**：业务 `status`/`environment`/`blocked`/`resolution`/`severity`
   **只能**经 `transition-work-item` 写；`update-work-item` 必须拒绝 `status` 字段。`execState`（自动化态）
   **永不**覆盖业务 `status`。
6. **状态保证三层（DESIGN §6.2b）**：`finalize-status` gate（结构）+ reconciliation watchdog（引擎硬保证）
   + blocked fallback。run 结束绝不静默留 stale status。**生效范围**：自 **P3** 全量生效；**P1/P2 的无 work_item 绑定 run 显式豁免**（§0.6），其图不含 finalize 闸是预期。
7. **节点原子可重跑（DESIGN §1.7 前置2、§7.4.5）**：claude microVM 节点整体重跑（销毁+从 baseRef 重启），
   不 mid-turn resume；`claude --resume` 仅用于 VM 内进程恢复，不暴露给 `run-resume`（一层 resume）。
8. **资源凭证不入源码（DESIGN §7.4.7、CLAUDE.md）**：`resolveSecret` 在 `runWithRequestContext` 内解析，
   注入为 scoped VM env / RO mount，绝不写进源码/文件/截图/prompt。
9. **startRun 三机制（DESIGN §4.2）**：每个并发 NodeRun 独立 `threadId`+唯一 `runId`；每个 NodeRun 内部
   重建 `runWithRequestContext`；`AgentLoopUsage` 在 `runFn` 内闭包捕获（否则 token 计数丢失）。
10. **UI⟂数据 parity（CLAUDE.md、FRONTEND 抬头）**：每个按钮都对应一个 action；按钮没有对应 action 则
    **先加 action**；前端禁止手写 REST，统一 `useActionQuery`/`useActionMutation`。
11. **加性迁移（DESIGN §9、CLAUDE.md）**：只新增表/列，不 drop/rename/truncate；不对生产库 `drizzle-kit push`。

### 0.3 已定决策（2026-06-20 用户拍板；其余取默认值）

| # | 决策 | 取值（已定） | 影响阶段 |
|---|---|---|---|
| **D-1** | `~/.claude` 挂进 VM 的模式 | **RO（只读）** + 周期性 re-login（隔离优先；token 数周有效，DESIGN §7.4.7） | P2 |
| **D-2** | 运行时 backend | **仅 microsandbox**，**无任何备选/fallback backend**（Podman/gVisor/E2B/Daytona/Docker 全不做；DESIGN/本文已删除其描述以免误导） | P2 |
| **D-3** | scheduler 驻留点 | **单 server-plugin tick**（仿 `jobs/scheduler.ts` 60s loop）+ SQL heartbeat/reap；多机持久化推迟到 P6 | P1（结构）/ P6（多机） |
| **D-6** | host vLLM 地址 | **`http://localhost:8080`**；VM 内可达地址形式在 P0 spike 实测并固化为 env（DESIGN §7.4.9） | P0 → P2 |
| D-4 | `@app` A2A token 是否计入预算 | 默认 best-effort 记录、**不强制**扣减（A2A 无 usage 返回，DESIGN §1.8） | P1 |
| D-5 | `runtime_configs` 是否迁 `ownableColumns()` | 默认暂不迁（自用无 sharing 需求），P6 加性可补 | P3/P6 |

> **表按影响度排序**（D-1/2/3/6 为前置硬决策、加粗；D-4/5 取默认值），**编号不代表先后顺序**。
> 各取值记录到对应阶段 `DEVELOPING.md`。**microsandbox 是唯一 backend**：KVM 是硬要求；P0 spike 不通过须解决
> microsandbox/KVM 本身（pin 版本 / 主机配置），**不存在换 backend 的选项**。
>
> **D-7（选型优先级，本次审查补）**：节点显式 `engine`/`model` > run/项目级覆盖 > `orchestrator-runtime` marker > 系统默认（§0.6）。影响 P0/P5。

### 0.4 验收方法（所有阶段统一）

- **四区检查（adding-a-feature skill / CLAUDE.md）**：每个特性必须同时落 UI / actions / skills-or-instructions /
  application-state 四区，缺一不算完成。
- **headless 优先验证**：每个 action 必须能 `pnpm action <name> --args '...'`（`run.ts` 分发器 +
  `AGENT_USER_EMAIL`/`AGENT_ORG_ID` 作用域）跑通——这是引擎正确性的主验证手段，**先于** UI。
- **MCP parity**：每个新 action 自动是 MCP 工具；brain 能调 = UI 能调（DESIGN §2a）。
- **可观察现象**：UI 验收以“点 X → 观察到 Y（状态/画布/终端/badge）”表述，避免“看起来 OK”。
- 每阶段验收为**全勾选才算 Done**；任何一条不过，该阶段不进下一阶段（与 DESIGN §12“verified before next”一致）。

### 0.5 阶段依赖与关键路径

```
P0 (闸门: spike + 路由收尾 + 依赖)
   │
   ├──────────────┐
   ▼              ▼
P1 (图引擎核心)   仅 P2 的 microVM 原语可与 P1 并行起步（§A NodeRuntime/Microsandbox backend、§G image、§H 网络、§E git wrapper——这些不依赖 P1）；
                  P2 的 NodeRunner↔调度器集成（§B/§C/§D）与全部 P2 验收依赖 P1 verified-Done（DESIGN §16）
   │              │
   └──────┬───────┘  ← 汇合：首个真实节点执行跑在 microVM 上
          ▼
        P2 (NodeRunner over microVM, 端到端真实交付)
          ▼
        P3 (Projects/WorkItems/状态/队列/library/动态编排)  ← 依赖 P1 run-start + P2 真实执行
          ▼
        P4 (完整前端: React Flow 编辑器 + 9 页 + run overlay)  ← 依赖 P1 图 schema/validator + P3 node_defs
          ▼
        P5 (Runtime 收尾: per-node 选型 / vLLM Test / 路由消费验证)
          ▼
        P6 (Hardening / 持久化 / 多机)
```

关键路径：**P0 → P1 → P2 → P3**（产品核心价值：定义项目 → 创建工作项 → brain 分解 → 跨多模型 microVM 执行 →
交付 PR/文件 + PM 看板）。P4 编辑器、P5 选型、P6 硬化在其后但**均为本规划必做项，不缓**。

> 每个后端阶段都带**最小 UI 切片**用于验证（FRONTEND §13 的“UI ships with each”精神），P4 是把
> 全部 9 页 + 编辑器 + run overlay 打磨到 FRONTEND 完整规格的集中阶段。最小切片与 P4 的关系在各阶段“前端交付”里写明，无重复实现。

### 0.6 跨阶段执行口径（消歧，所有阶段共用——审查补强）

这些口径解决“前后阶段数据依赖”的歧义，是硬规则：

- **运行入口的两形与逃生口（贯穿 P1/P2/P3）**：`run-start({ templateId?, workItemId?, tokenBudget? })`——`templateId` 与 `workItemId` **二选一必填、互斥**；**自始即此签名，P3 不改签名**，只是开始传 `workItemId`。
  - **P1/P2 一律用 `templateId` + run 级配置起运行**（无需 `projects`/`work_items` 表）。P2 的代码/非代码交付验收里，**仓库来自 run/template 级 `runtime.repo` 或 env 配置的测试仓库，输出落 run 级输出目录**，`end` 把 deliverable 记到 **WorkflowRun**；“仓库来自 `project.repo`、文件落 `project.workingDir`、deliverable 记到 `work_item`”整体**推迟到 P3**（届时 `projects`/`work_items` 才存在），并在 P3 补对应验收。
  - 无 `workItemId` 的 run **跳过 watchdog**（无业务状态可调和）；该豁免在 watchdog 实现里显式判断 `if run.workItemId == null: skip`。
- **finalize-status 闸的生效范围（解决 §0.2.6 与 P1/P2 的时序冲突）**：§0.2.6“run 结束绝不静默留 stale status”**自 P3 起全量生效**（gate=L1 与 watchdog=L2 均 P3 落地）。**P1/P2 的 run 是 PM 之前的、无 work_item 绑定的，显式豁免该不变量**——其交付图不含 finalize-status 闸是预期行为（无业务状态可终结）。此豁免写入 §0.2 不变量表对应行，避免审查据 §0.2.6 误判 P2。
- **选型优先级（硬规则，P0 定、P5 依赖）**：节点显式 `engine`/`model` > 项目/run 级覆盖 > `orchestrator-runtime` marker 默认 > 系统默认。`resolveNodeExecutorChoice` 必须按此顺序；单测断言 per-node `engine` 覆盖 marker（P5 的“marker 改变默认节点路由”验收必须用**未设 `engine`** 的节点）。
- **`node-get` 返回字段分两批**：**P1 批**（executor-无关）= status/iteration/dynamic/input-output artifact/timings/tokens/attempts；**P2 批**（需 VM）= `executor`(vllm|claude-code|remote-api) / microVM id / branch / onFailure。FRONTEND §4 的全字段在 P2 §K 才齐；P1 验收只对 P1 批断言。`executor` 字段若 DESIGN §4.4 未含，**P2 加性补入 `node-get` 负载**（P5 的路由验收依赖它）。
- **11 种节点类型必须全部落地**：除 §3.2 已覆盖的 sequential/pipeline/parallel/fanout/join/branch/loop 外，**`human`（审批闸）与 `subworkflow`（模板内联）同为一等节点**，其引擎语义见各自阶段（P1 §C），不得只列“11 种”而漏实现。

---

## P0 — 基线收尾 + 基础设施闸门

**目标**：把 v1.5 的最后一个未消费 marker 接通；用一次性 spike **证明** microVM 执行链在目标主机可行
（否则 P2 不得开工）；引入并核验全部新依赖版本。本阶段无终端用户特性，是**去风险闸门**。

**前置依赖**：无（基于现状）。

### 工作内容

1. **接通 `orchestrator-runtime` 路由消费（DESIGN §8.3 item3、§11 唯一遗留 Phase-0 项）**
   - 现状：`activate-runtime` 写了 `orchestrator-runtime` marker，但引擎不消费（执行仍 chat-delegated）。
   - 本阶段只做**读取与判定接口**：定义一个 `resolveNodeExecutorChoice(node, settings)` 选择逻辑的位置与契约
     （marker = `claude-code` → 选 ClaudeCodeExecutor；vLLM/hosted → engine executor），真正的 executor 在 P2 落地。
   - 这里只落“判定函数 + 单测”，不引入执行。
2. **microsandbox / KVM 基础设施 spike（DESIGN §16 item1、§7.0a/§7.4/§14）——硬闸门**
   - 在目标主机（Windows 11 + WSL2 Ubuntu，`/dev/kvm` 设计已核实存在，DESIGN §7.0a/§13 gotchas）实测：
     - 安装 `msb`（microsandbox 单二进制）+ microsandbox npm SDK（**`pnpm view` 核验当前版本后 pin**）。
     - 预烤一个最小 base image（node + pnpm + git + `@anthropic-ai/claude-code`，DESIGN §7.4.8）。
     - 从 image 启 VM → `fs().copyFromHost()`/`--mount` 把 `~/.claude` 以 **RO（D-1 已定）** 挂入 →
       VM 内 `claude --output-format stream-json -p "..."` 产出**结构化事件流**。
     - VM 内访问**宿主机 vLLM** endpoint `http://localhost:8080`（实测并固化 VM 内可达地址形式为 env，D-6）。
     - `git push` 鉴权：`https://x-access-token:$GITHUB_TOKEN@github.com/...` 形式在 VM 内推一次测试分支（DESIGN §7.1/§7.4.7）。
     - **销毁 + 重启**得到干净 VM 再跑一次（证明 §7.4.5 recreate ~<100ms 干净重来）。
     - 启 **N 个并发 VM**（贴近 `maxConcurrentVMs`）量测 CPU/mem/启动时延，确定单机容量上限。
   - 产出一份 `docs/spike-microvm.md`（结果 + 实测时延 + VM 内访问 `localhost:8080` 的可达地址形式 + go/no-go）。
3. **依赖引入与版本核验（CLAUDE.md：加依赖先 `pnpm view` 核验最新版）**
   - `@xyflow/react`（P4 编辑器）、`microsandbox` SDK（P2）、git 操作走 thin wrapper over `microsandbox exec`
     （**不引** simple-git/isomorphic-git，DESIGN §13）。`node-pty`+`@xterm/*` 已在仓库（DESIGN §7.1）。
   - 仅写入 `package.json`、不实现功能；记录 pinned 版本。

### 关键实现逻辑（要点）

- spike 是**独立脚本 + 文档**，不进产品代码路径；其唯一产出是“可行性结论 + 固化的配置取值”。
- `resolveNodeExecutorChoice` 契约（伪代码，**闭集 + 显式 reject + 优先级 D-7**）：
  ```
  # 接受集（闭集，运行时计算）= {"claude-code"} ∪ 已注册 runtime_configs 的 key ∪ 框架内置 engine 白名单
  resolveNodeExecutorChoice(node, settings):
    accepted = {"claude-code"} ∪ keys(list-runtime-configs()) ∪ BUILTIN_ENGINES
    choice = node.engine                       # 1. 节点显式优先（D-7）
          ?? settings["orchestrator-runtime"].runtime   # 2. marker 默认
          ?? SYSTEM_DEFAULT                     # 3. 系统默认（一个明确存在的 runtime_config key）
    if choice not in accepted:  throw ConfigError(`unknown executor choice: ${choice}`)  # 不返回 undefined
    if choice == "claude-code":  return ChoiceTag.ClaudeCode
    else:                        return ChoiceTag.Engine(choice)   # executor 实体 P2 落地
  ```
  > `SYSTEM_DEFAULT` 必须是一个**实际存在**的 `runtime_configs` key（启动时校验，缺则配置错误）；不存在 “vllm-default” 这种悬空魔法串。

### 验收标准（全勾选才 Done）

- [ ] `docs/spike-microvm.md` 存在，且记录：VM 冷启时延、claude stream-json 事件样例、VM→host vLLM 实测可达
      （含确定的地址形式）、`git push` 成功的测试分支 URL、销毁+重启干净复跑成功、N 并发 VM 的资源占用与容量上限。
- [ ] spike 文档记录：RO 挂载 `~/.claude` 验证通过 + VM 内访问 host `localhost:8080` 的可达地址形式确定。
- [ ] **spike 通过门槛（数值，达不到=no-go）**：VM 冷启 ≤ **2s**、warm-snapshot 重建 ≤ **300ms**（§7.4.5 的 <100ms 是 warm 路径，冷启另测并标注）；
      销毁+重启干净复跑成功；目标主机稳定并发 ≥ **N** VM（N = P3 默认 `maxConcurrentVMs`，本阶段定一个明确数值）而不 OOM、单 VM 常驻内存 ≤ **[填实测阈值]**。
      数值写入 spike 文档；**任一未达 = no-go**（不靠主观“go”）。
- [ ] `resolveNodeExecutorChoice` 判定函数 + 单测通过：4 类输入——`claude-code`→ClaudeCode、已注册 vLLM config key→Engine、内置 engine id（如 `ai-sdk:openai`）→Engine、
      **未知/空串→抛 `ConfigError`**（不返回 undefined）；并断言 **per-node `engine` 覆盖 marker**（D-7 优先级）。
- [ ] `package.json` 含 pin 后的 `@xyflow/react`、`microsandbox`；`pnpm install` 通过；记录版本号。
- [ ] **go/no-go 明确**：若 spike 任一**数值门槛**或关键步骤不通过 → **必须先解决 microsandbox/KVM 本身**（无备选 backend），
      **P2 不得在未通过 spike 时开工**。

**风险**：microsandbox beta（v0.5.x）行为不稳 → **pin 版本** + P0 容量量测兜底；KVM 是硬要求，目标主机不可用
则不能部署（无其他 backend）。风险均在本闸门暴露，不带入后续阶段。

---

## P1 — 图模型 + 确定性调度引擎

**目标**：落地 v2 图数据模型 + **确定性调度引擎全控制流**（sequential → pipeline → parallel/fanout → join →
branch → loop + 动态扩展 + 预算 + 超时/卡死检测）+ 控制/观测 API + 模板 actions。执行体此阶段用
**NoneRuntime / echo 测试执行器**验证编排逻辑（pure-reasoning 节点是设计内置 runtime kind，DESIGN §7.4.2），
真实 microVM 执行在 P2 汇入。**无任何宿主机代码执行发布路径**——测试执行器只产出确定性占位输出供调度逻辑断言。

**前置依赖**：P0（依赖已引入、路由判定函数就位）。可与 P2 microVM 基座并行起步。

### 工作内容

#### A. 数据模型（DESIGN §9，新增表，加性）
- 新增 `workflow_templates`、`workflow_runs`、`node_runs`、`artifacts`（列见 DESIGN §9，逐列对齐）。
- `ownableColumns()` + `createSharesTable()`（仅建 shares 表结构，sharing UI 推迟，DESIGN §9/§12）。
- 索引：`node_runs(run_id)`、`node_runs(run_id, node_id, iteration, fanout_index)` 唯一键（journal 主键，DESIGN §1.7）、
  `workflow_runs(work_item_id)`、`artifacts(node_run_id)`。
- v1→v2 一次性**只读 backfill 视图/脚本**（不 drop v1 表，DESIGN §9）：`task→work_item`、`workflow→template`、
  `step_run→node_run` 的映射函数（供 P3 UI 展示旧运行）；本阶段仅定义映射，执行在 P3 数据就绪后。

#### B. 图 schema + 校验（DESIGN §3）
- `shared/types.ts` 扩展：节点类型 11 种（DESIGN §3.1）、`Edge{from,to,when?}`（§3.3）、`Node` 配置（§3.4）、
  `Condition`（§3.5：jsonpath / status / agent）、`NodeRuntimeSpec`（§7.4.3，结构占位，P2 消费）。
- **统一校验器**：在现有 `validateWorkflowDag` 基础上扩展（DESIGN/FRONTEND §6.3“one shared validator”）——
  base graph 无环、单 start/单 end、`fanout.itemsFrom` 可解析、`loop` 有 condition+maxIterations、
  `branch` 出边有 `when`、**implicit-barrier lint**（疑似多余 join 标 warning 不阻断，§1.3）。
  错误阻断 save、warning 不阻断。**client lint 与 `save-template` action 调同一函数**（无双真相）。

#### C. 调度引擎（DESIGN §4，本阶段核心）
- 调度循环（DESIGN §4.1 已给伪代码，按其实现）：NodeRun 状态机 `pending→ready→running→done|failed|skipped`。
- **item-correlation（DESIGN §4.1a，硬规格）**：NodeRun 身份键、fanout index-preserving 边、join 基数封板、
  中途 item 失败丢弃。
- **并发信号量（DESIGN §4.1，build-not-configure，框架无全局 run cap）**：`maxConcurrentModelCalls`（默认 8）、
  `maxConcurrentVMs`（P0 实测容量）、per-fanout `maxConcurrency`、per-run 节点总数 backstop。VM/资源耗尽失败
  **与 token 预算区分上报**。
- **动态扩展（DESIGN §1.5/§4.1）**：fanout 从上游数组展开 child NodeRun；loop-until-dry（`dedupeKey`+`seen` 集
  +`dryRounds`，去重对 `seen` 不对 `confirmed`）；loop-until-budget；loop-until-condition；routing/classify。
  loop 累加态作为 journaled artifact（key=`(runId,loopNodeId,iteration)`，§3.2）。loop 在迭代边界 barrier。
- **`human` 节点（审批闸，DESIGN §3.1/§11，本次审查补）**：调度器到达 `human` 节点时**挂起该 run**（NodeRun 置
  `awaiting-approval`，不分配 executor/VM、不自动完成），等待外部 resolve 信号。**复用 dispatch 审批原语**
  （`dispatch/src/server/lib/dispatch-store.ts:426-604` `createApprovalRequest`/`approveRequest` + changeType apply，DESIGN §11）。
  新增 action `resolve-human-gate(runId, nodeRunId, { decision:"approve"|"reject", input? })`：approve → 节点 done、放行下游；
  reject → 该出边分支 skip（其下游 NodeRun 置 skipped）。该节点状态写入 `node_runs`，不进 chat transcript（§0.2.2）。
- **`subworkflow` 节点（模板内联，DESIGN §3.1/§1.2，本次审查补）**：节点引用另一 template，运行时**内联展开**其图为
  本 run 的 child NodeRun（带 `dynamic:true`）。**仅一层嵌套**（§1.2，二层嵌套在校验/展开时 reject）；child 节点
  **共享父 run 的 `maxConcurrentModelCalls`/`maxConcurrentVMs`/`tokenBudget`/节点总数 backstop**（不另开独立配额）。
  child 的 `tokens_spent` 计入父 run 预算。
- **journal + resume（DESIGN §1.7，引擎不变量）**：每 NodeRun 按身份键持久化 input+output artifact；`run-resume`
  重放已完成 NodeRun（零 token）、只重跑 failed/pending；**fanout 子树失效规则**（数组生产者重跑则整棵 fanout 子树
  失效不部分复用，§1.7 前置1）；claude 节点整体重跑（§1.7 前置2，P2 生效）。
- **startRun 机制（DESIGN §4.2，三机制）**：每 NodeRun 独立 `createThread`+唯一 `runId`（`an-<runId>-<nodeId>-<iter>-<idx>`）；
  每 NodeRun 内 `runWithRequestContext({userEmail,orgId})`；`AgentLoopUsage` 在 `runFn` 内闭包捕获 → `node_runs.tokens_spent`。
  整体仿 `jobs/scheduler.ts`（DESIGN §13 canonical pattern），跑在 server-plugin/job（非 route handler）。
- **超时 + 卡死检测从第一天起（DESIGN §12 phase1 强调）**：per-node `timeoutMs` 强制；卡死 run 检测（heartbeat）。
- **预算（DESIGN §1.8）**：`run-start` 收 `tokenBudget`；预算耗尽停止调度新 dynamic 节点；`run-get` 暴露剩余。
  注意 D-4：仅 local/tool spend 精确。
- **调度器驱动点（D-3）**：单 server-plugin tick 推进 ready 节点 + SQL reap 回收 stranded `running`。

#### D. Actions —— 控制 / 观测 / 模板（DESIGN §4.3/§4.4/§10）
- 控制：`run-start({ templateId?, workItemId?, tokenBudget? })`（**二选一互斥、自始即此签名**，§0.6；P3 只是开始传 workItemId）、
  `run-pause`、`run-resume`、`run-cancel`、`run-retry-node`、`node-override`、**`resolve-human-gate(runId, nodeRunId, {decision, input?})`**
  （human 闸放行/拒绝，复用 dispatch 审批，§C；语义见 DESIGN §4.3/§11；cancel 为 cooperative abort）。
- 观测：`run-get`、`run-graph`、`node-get`、`run-events`（桥接 `subscribeToRun(runId, fromSeq)`，§4.4）、`list-runs`。
- engine 上报：`node-report`（子 agent 只报 interim 进度/artifact；**终态 done/failed 由调度器在子 run 完成时写**，
  两路不双写，DESIGN §10）。
- 模板：`save-template`、`list-templates`、`get-template`、`delete-template`、`promote-run-to-template`
  （promote 在 P3 动态编排后才有真实数据，P1 先实现 distill 逻辑 + 单测）。
- **`run-step` 明确不做**（DESIGN §4.1a：detached startRun 不可单步；调试用 pause+inspect）。

#### E. 技能/指令（四区之一）
- 新增 `engine`/调度相关的内部说明（写入 `DEVELOPING.md` 或新 skill）：item-correlation、resume 语义、
  pipeline vs barrier，供后续维护者与 brain 理解。`orchestrating/SKILL.md` 的大改在 P3（绑定 work_item/状态）。

#### F. 前端交付（最小切片，P4 完整化）
- Item/Run console **只读骨架**（FRONTEND §13 phase1）：用 `run-graph`/`node-get` 渲染节点列表 + 状态 +
  run 控制按钮（Run/Pause/Resume/Cancel）。canvas 可先用简单列表/dagre 占位，React Flow 在 P4。
- 应用状态：该路由经 `navigate` 写 `navigation`（DESIGN §2a/context-awareness）。

### 关键实现逻辑（仅设计留白处补伪代码）

- **resume 失效判定**（DESIGN §1.7 前置1 的算法化，**两遍——先全量标脏再重放，杜绝部分复用**）：
  ```
  on run-resume(runId):
    # Pass 1（先于任何 replay）：计算 dirty 集
    dirty = { nodeRun | nodeRun.status in {failed, pending} }
    for producer in dirty where producer is array-producer of a fanout F:
       dirty ∪= { all NodeRuns under F }      # 递归把整棵 fanout 子树标 dirty
    # Pass 2：拓扑遍历，dirty 一律重跑，绝不按旧 0..N-1 部分复用
    for nodeRun in journal(runId) topologically:
      if nodeRun.status == done AND nodeRun not in dirty:
         replay(nodeRun)        # 不调用 executor，载入 output artifact（执行次数=0）
      else:
         schedule(nodeRun)      # 重跑 live
  # 关键：invalidate 在 Pass 1 全部算完，不在遍历中懒触发（否则已越过的 child 会先被错误 replay）
  ```
- **join 基数封板**（DESIGN §4.1a，补空集与 nearest 定义）：
  ```
  nearest-upstream-fanout(J) := 沿 J 入边反向 BFS 遇到的第一个 fanout 容器
                                （若 J 入边来自多个不同 fanout → 非法图，validator 在 save 时 reject）
  join J not ready until nearest-upstream-fanout(J).arrayProducer.status == done
  once sealed: expected = N (= len(array)); wait exactly N incoming
  a failed B_i removes i from expected（filter Boolean），不 deadlock、不早触发
  if expected 经 filter 降为 0:                # 全部兄弟失败的边界
     join 产出空集合、标 degraded:true；run 继续，end deliverable 标注 "0/N succeeded"
     （既不静默成功也不 deadlock）
  ```

### 验收标准（全勾选才 Done）

- [ ] 4 张新表迁移加性应用（v1 表零改动），journal 唯一键 `(run_id,node_id,iteration,fanout_index)` 生效。
- [ ] `validateWorkflowDag` v2：对 fanout/loop/join/branch/subworkflow 的非法图返回明确 error（含**二层 subworkflow 嵌套被拒**、
      **join 入边来自多个 fanout 被拒**）；implicit-barrier 出 warning 不阻断；client 与 `save-template` 调用同一函数（grep 证明单一实现）。
- [ ] **headless 跑通六类控制流**（各一个 fixture 模板，`pnpm action run-start --args ...`，用 echo 执行器；**每条带可证后置条件**）：
      - sequential：节点严格按拓扑序进 running，前序未 done 后继不 running（journal 时间戳可证）。
      - pipeline：`B_i` 在 `A_i` done 即启动、**不等兄弟**（时间戳证 B_0 早于 A_1 完成）。
      - parallel（barrier）：容器内 ≥2 子节点**重叠 running**（并发可证），且下游在**全部**子 done 前**不进 ready**（断言 barrier）。
      - fanout：N == 上游数组长度；N 条独立链 index-preserving（`A_i→B_i`）。
      - branch：两出边仅 `when` 为真者目标被调度，另一边目标 status=**skipped**。
      - loop-until-dry：注入重复 item，第 K 轮无新增 `seen` key 即停、去重对 `seen` 不对 `confirmed`。
- [ ] **`await:false`（async，§3.2）**：fire-and-forget 节点不阻塞其下游 barrier 直到其 settle；`effort` 传入 `runAgentLoop` reasoning-effort（node-get 可证选用值）。
- [ ] **`human` 节点**：含 human 节点的图 → run 推进到该节点即挂起（`awaiting-approval`）；`resolve-human-gate(approve)` → 放行下游；
      `resolve-human-gate(reject)` → 该出边分支下游置 skipped。
- [ ] **`subworkflow` 节点**：引用一模板 → run 内联展开其节点（dynamic）；二层嵌套被拒；child `tokens_spent` 计入父 run 预算、共享父并发配额。
- [ ] **resume（计执行次数，非 token——echo 下 token 恒 0 不可辨）**：杀掉中途失败 run → `run-resume` 后已完成节点 executor `invoke` **调用 0 次**
      （spy 计数断言）、仅 failed/pending 节点 executor 被调用、输出 artifact id 与首跑一致；数组生产者重跑时其 fanout 子树**整棵**重跑（无部分复用，日志可证）。
- [ ] **`node-override` / `run-retry-node`（echo 下先验）**：override 一节点 prompt → 重跑该节点、其下游发散尾重跑、上游零执行复用；
      `run-retry-node` 单点重跑兄弟不动。
- [ ] **cancel**：`run-cancel` 后不再调度新节点、运行中节点在 loop 边界停止；run 置 cancelled。
- [ ] **预算**：设 `tokenBudget` → 耗尽后不再调度 dynamic 节点；`run-get` 返回剩余预算。
- [ ] **超时/卡死（明确触发）**：超 `timeoutMs` 节点被判 failed；构造 stranded（手动置一行 `running` 且 `last_heartbeat = now − 2×reapThreshold`，
      `reapThreshold` 为显式常量）→ 一次 reap tick 后该行置 failed/回 queued（明确哪个）；心跳新鲜的 `running` 行**不**被 reap（反向断言）。
- [ ] **并发**：fanout width > `maxConcurrency` 超出排队；`running` 峰值计数 == 配置上限（采样断言曾达到且不超）；并发 NodeRun 各自独立 thread/runId（无互相 abort，DESIGN §4.2 机制1）。
- [ ] **determinism gate（§0.2.1，否则可钻空）**：scheduler 模块内调用 `Date.now()`/`Math.random()`/argless `new Date()` 触发 lint/运行时断言失败；
      同一 fixture（注入相同显式时间种子）跑两次产出相同 NodeRun 拓扑与 artifact id 序列；grep 证无运行中间态写入 chat transcript 表（§0.2.2）。
- [ ] **`node-report` 不双写（§0.2 类硬规则）**：子 agent 调 `node-report` 写 interim artifact 不改 NodeRun 终态；
      终态 done/failed **仅由调度器**写——单测断言 `node-report` 无法将节点置 done/failed 或改回。
- [ ] **`node-get` 返回 P1 批字段**（status/iteration/dynamic/input-output artifact/timings/tokens/attempts，§0.6）；executor/microVM/terminal 字段 P2 补；只读 console 实时显示节点状态变化。
- [ ] **`promote-run-to-template` distill 单测**：对一 fixture journal 蒸馏出等价模板（去 dynamic 索引，节点/边集合与执行拓扑一致）；`list-runs` 返回 fixture 的 runs。
- [ ] 全部新 action 可 headless 调用且自动成为 MCP 工具（`agent-native connect` 后 brain 可调）。
- [ ] **四区闭合**（§0.4）：本阶段每新能力四区可证——新 action 有 UI 触点或显式标注“P4 完整化”、对应路由经 `navigate` 写 application_state、新增/改 skill 或 `DEVELOPING.md` 段落存在（diff 可证）。

**风险**：调度器并发/竞态 bug → 以 fixture 模板 + headless 断言为主战场，UI 不作为正确性验证。

---

## P2 — 统一 NodeRunner over microVM

**目标**：落地 DESIGN §7 全部——`NodeRuntime` 抽象 + MicrosandboxRuntime backend + 七阶段 `NodeRunner` +
三执行器（Vllm/RemoteApi/ClaudeCode）+ in-VM git 交付 + 凭证注入 + base image + 网络 + 非代码交付 + 终端流，
并把 P1 的调度器接到真实 microVM 执行上。**这是“隔离、可重复、可销毁执行”的核心，microVM 前置不可省。**

**前置依赖**：P0 spike 通过（go）；P1 调度器 + NodeRun journal 就位。

### 工作内容

#### A. NodeRuntime 抽象 + backend（DESIGN §7.4.2）
- `NodeRuntime` 接口（provision/mount/init/exec/spawn/fs/getPortUrl/snapshot/teardown，签名见 §7.4.2）；
  接口形状参考 `@ai-sdk/sandbox-vercel` 的 shape（**仅 interface 形状参考，非可换 backend**）。
- `MicrosandboxRuntime`（**唯一** backend；所有 tool/code/agent 节点；映射见 §7.4.2：`Sandbox.builder().image().create()` 等）。
- `NoneRuntime`（pure-reasoning 节点，无 VM——branch 条件 / 无副作用 planner；亦替换 P1 的 echo 执行器载体）。
- **无其他 backend**：Podman/gVisor/E2B/Daytona/Docker 均不实现（D-2 已定）。

#### B. 七阶段 NodeRunner（DESIGN §7.4.1a，骨架伪代码已在设计给出，按其实现）
- PROVISION → MOUNT（dirs+creds）→ INIT（git branch/worktree + env + setup）→ **EXECUTE（唯一可插拔）** →
  COLLECT（output + AgentLoopUsage + timing + exit）→ EXTRACT（copyOut / git push + PR）→ TEARDOWN（destroy|snapshot|keep）。
- 固定 init 序列（§7.4.4）+ 生命周期状态机 + 异常恢复（§7.4.5：rollback / recreate / keep）。
- **独立重跑落地**：`run-retry-node` 销毁+从 baseRef 重启**单个** VM，兄弟不动（§7.4.5）。
- **孤儿 VM 回收（审查补）**：VM 命名含 `runId`/`nodeRunId`；调度器/进程启动时枚举 `msb` 存活 VM，对照**无活 NodeRun** 的 VM
  `stop()+remove()`——防止进程崩溃后泄漏的 VM 长期占 `maxConcurrentVMs`（单 KVM 主机最稀缺资源）。

#### C. 三执行器（DESIGN §7.4.1a，EXECUTE 槽）
- `VllmExecutor`：host 上 `runAgentLoop`（engine=`ai-sdk:openai`+baseUrl），tools = **acting bridge**（见 D）。
- `RemoteApiExecutor`：同形，hosted engine + key。
- `ClaudeCodeExecutor`：`vm.spawn("claude --output-format stream-json -p ...")`，解析事件流（**非**框架 harness，§7.0b）。
  cwd = in-VM worktree。**token 计入**：从 stream-json 的 usage 事件解析（**与 `runAgentLoop` 的 `AgentLoopUsage` 路径不同**，本阶段明确实现这条解析）→ `node_runs.tokens_spent`。

#### D. 模型无关 acting bridge（DESIGN §7.4.1a 关键精度）
- 复用 `createCodingToolRegistry` 的**工具契约（bash/read/edit/write 4 个 ActionEntry 的 schema）**，但**重实现**
  其副作用面向 VM：`bash→vm.exec`、`read/write→vm.fs`（§7.4.1a 警告：内置实现在 host 上 spawn，必须重实现而非传 cwd）。
  agent loop 仍跑在 host（调度进程），只有**工具副作用**进 VM。
- 先核验 `./coding-tools` 是否从 `@agent-native/core` 导出（实测当前 `packages/core/package.json` exports **无**此条目，是真缺口）；
  未导出则补 export **并加 `.changeset/*.md`**（核心包源改动硬要求，CLAUDE.md）。**禁止**在模板里手抄工具契约副本（违背单一来源）。

#### E. git 交付（DESIGN §7.1/§7.1a）
- thin git wrapper over `microsandbox exec`（branch/commit/push）——仓库无 git 依赖，自建（§7.1/§13）。
- per-run 分支 `an/run-<runId>`（一 run 一分支，run 内节点共享累加，§7.4.3）；分支生命周期状态机（§7.1a）。
- push 鉴权 = `resolveSecret("GITHUB_TOKEN")` 注入 VM env / credential helper（§7.4.7）；
  **push 不假定成功**：non-fast-forward → 节点 failed + 明确错误；`{kind:"pr"}` deliverable 仅在 PR URL 真存在时写（§7.1）。
- PR 创建经 `gh`（in-VM）。

#### F. 凭证（DESIGN §7.4.7，大头是复用）
- 复用 dispatch Vault + `resolveSecret` + `getOwnerActiveApiKey` + connector OAuth + AES-GCM（§7.4.7 表，全复用）。
- **自建仅三件**：VM env 注入（`--mount-file`/`fs().copyFromHost()` RO + scoped env）、`~/.claude` 按 **RO（D-1 已定）** 挂入、git-push 鉴权。

#### G. base image（DESIGN §7.4.8）
- 预烤 OCI image（node+pnpm+git+`@anthropic-ai/claude-code` + 项目语言运行时），版本化，pin `runtime.image`；
  warm 重启用 microsandbox snapshot（post-setup 态）。每语言/运行时一镜像（项目无 kind，§6.1）。

#### H. 网络（DESIGN §7.4.9）
- in-VM → host vLLM（用 P0 确定的 host-gateway 地址，传为节点 `baseUrl` env）。
- 默认允许出网（remote API / git push / claude API）；per-node 网络策略推迟。

#### I. 非代码交付 + 中间产物（DESIGN §7.2/§7.3）
- 子 agent 产物 → 项目 `workingDir`（`local-artifacts`）写最终文件（`deck.pptx`/`report.md`）。
- 中间产物 → Resources store（`resourcePut`/`resourceGetByPath`，`agent_scratch` 可见性），按 artifact id 传递不贴正文。
- `end` 节点写 deliverable 记录到 work item（`{kind:"pr"|"files", ref}`，§7.3）。
- **三层别混**（§7.2/§13）：`workspace-files`（Resources 薄封装）/ `resources`（内容存储）/ `local-artifacts`（仓库文件源）。

#### J. brain 控制通道（DESIGN §2a）
- 把 orchestrator 的 Claude Code（planner 节点）连到 app 的 MCP surface
  （`agent-native connect http://localhost:<port>/_agent-native/mcp --client claude-code --full-catalog`），
  使 brain 能调 `run-graph`/`node-get`/`node-override`/`save-template`/`run-start` 等全控制/状态 action。
- 验证 brain 可读+驱动整图（DESIGN §2a 设计规则：brain steers, not babysit）。

#### K. 前端交付（最小切片）
- Item/Run console 节点 inspector（`node-get`：engine/model/executor/timings/tokens/attempts/input-output artifact/
  runtime 信息）+ **xterm 终端**（microsandbox `execStream` → xterm，VM 自持进程，非 host node-pty，FRONTEND §4(b)）+
  `View diff` sheet（node 提交 diff）。完整 bottom tabs/9 页打磨在 P4。

### 关键实现逻辑（要点，骨架伪代码见 DESIGN §7.4.1a 不重复）

- executor 拿到的是**已 provision/mount/branch 就绪的 VM 句柄**，只负责跑模型、不管 VM 生命周期（§7.4.1a）——
  这是 claude 节点零嵌套的原因（无第二层 sandbox、无框架 harness）。
- recreate 恢复（§7.4.5）：`teardown(VM) → provision()+mount()+init() from baseRef → retry`，~<100ms 干净重来。

### 验收标准（全勾选才 Done）

> 注（§0.6）：P2 用 **`templateId` + run 级 `runtime.repo`/env 测试仓库 + run 级输出目录**起运行；`end` 把 deliverable 记到 **WorkflowRun**。
> “仓库来自 `project.repo`、文件落 `project.workingDir`、deliverable 记到 `work_item`”推迟到 P3（届时表才存在）。

- [ ] **代码交付端到端（固定 fixture，非泛述）**：用固定 fixture 仓库 + 固定任务（如“给函数 X 加一个先 RED 后被修复的测试”）→ microVM 内
      checkout→编辑→`run-tests`→commit→push→开 PR。断言：PR diff 含**预期文件改动**；`run-tests` 节点 **先 RED 后 GREEN**（exit code 落 `node_runs`）；
      PR URL 经 `gh pr view` 可解析；WorkflowRun `{kind:"pr", ref}` 与该 URL **字节一致**。
- [ ] **三执行器各跑通一次且 token>0**：vLLM（in-VM 编辑+git，调 host vLLM）、remote-API、claude-code（stream-json 事件被解析）。
      断言 `node_runs.tokens_spent > 0` 且与执行器返回一致（vLLM/remote 从 `AgentLoopUsage` 闭包捕获、claude 从 stream-json usage 解析）；
      并发 8 节点各自 token **不串号**（验证 §4.2 机制3 闭包正确）。
- [ ] **独立 node 重跑**：`run-retry-node` 销毁+重启**单个** VM，兄弟不受影响——**VM id 变化** + 兄弟状态/VM id 不变可证。
- [ ] **三种 onFailure（断言区分性观察量）**：rollback → 重试后 VM id **不变**、worktree git status clean（reset 到 baseRef）；
      recreate → 重试后 VM id **变化**、从 baseRef 干净启动；keep → 节点 failed + snapshot ref 落库、可经 inspector 拉起检查。
- [ ] **非代码交付**：产出文件落 **run 级输出目录**，WorkflowRun 写 `{kind:"files", ref:[...]}`；中间态在 Resources 按 artifact id 传递（不贴正文）。
- [ ] **凭证隔离**：`~/.claude` 以 **RO** 挂入且 in-VM claude 复用订阅；`GITHUB_TOKEN` 仅在 VM env，源码/日志/artifact 中无明文凭证（grep 验证）。
- [ ] **push 失败路径**：构造 non-fast-forward → 节点 failed + 明确错误，且**未**误写 PR deliverable。
- [ ] **acting bridge 在 VM 内（正向断言）**：vLLM 节点 `write` 工具写文件 X → **VM 内** `cat X` 可见、**host** 对应路径不存在；
      `bash` 的 `uname/hostname` 返回 **VM 标识**而非 host（证明副作用确在 VM 内、非 host 对着 mount 写）。
- [ ] **终端**：node inspector 的 xterm 实时显示 in-VM claude/git 输出。
- [ ] **brain 经真实 MCP（非模拟）**：`agent-native connect …/mcp --client claude-code --full-catalog` 后，一个真实 MCP client
      `tools/list` 含 `run-graph`/`node-get`/`node-override`/`run-start`；经**该 client**（非直接 action 调用）调 `node-override` 改 prompt 触发重跑、`run-graph` 反映新状态。
- [ ] **`node-get` 补 P2 批字段**：返回 `executor`(vllm|claude-code|remote-api) / microVM id / branch / onFailure，inspector 显示之（有列或 `kind:"runtime"` artifact 来源）。
- [ ] **孤儿 VM 回收**：杀 scheduler 进程（VM 仍在）→ 重启后无活 NodeRun 的 VM 被识别并 `stop()+remove()`，`maxConcurrentVMs` 计数恢复正确。
- [ ] **四区闭合**（§0.4）：本阶段新能力四区可证（同 P1 末条标准）。

**风险**：microsandbox beta 稳定性 / 并发 VM 资源 → P0 已量测容量；`maxConcurrentVMs` 设为实测安全值；
无备选 backend，稳定性靠 **pin 版本 + P0 spike 闸门**兜底。

---

## P3 — Projects / Work Items / 状态模型 / 队列 / Node Library / 动态编排

**目标**：落地“项目管理 + 队列驱动并发执行”这一**主用法**（DESIGN §6 全部）：项目与工作项、六维度业务状态模型 +
单写入口 + watchdog、execState 队列 + 原子认领 worker pool + 并发度、可复用 node library（含 finalize-status gate）、
brain 动态编排（NL→template）+ runtime expansion + promote。并把 v1 技能/CLAUDE 改写到 v2 surface。

**前置依赖**：P1（run-start/控制 API/模板）、P2（真实执行 + 交付）。

### 工作内容

#### A. 数据模型（DESIGN §9）
- 新增 `projects`、`work_items`、`work_item_links`、`work_item_status_log`、`node_defs`（列见 §9，逐列对齐；
  含 `status_schemes`/`environments` JSON、work_item 的业务状态六维度列 + execState/claimed_* 列）。
- 全部用 `ownableColumns()`（owner 作用域，shares 表建结构、sharing UI 推迟，§9/§12）。
- 索引：队列认领热路径 `work_items(exec_state, priority)`、`work_items(project_id)`、
  `work_item_status_log(work_item_id)`、`work_item_links(from_item)`/`(to_item)`、`node_defs(key)`。
- 执行 P1 定义的 v1→v2 backfill（只读拷贝展示旧运行，不删 v1 表）。

#### B. 业务状态模型（DESIGN §6.2a/§6.2b，PM 核心）
- 六维度（statusCategory / status / environment / blocked / resolution / severity）+ 各 type 默认 pipeline +
  transition 规则（forward skip-forward / rework / reopen / cancel / rollback）+ `resolutionsAt` + scheme JSON 存储
  —— **全部按 DESIGN §6.2a 表实现，不在本文重列**。
- **`transition-work-item`（单写入口，§6.2b）**：校验 from→to（含 rework 反向边）、派生 statusCategory、
  强制“进 completed/cancelled 须给 `resolutionsAt` 内 resolution”、reopen 清 resolution、duplicate 须有 `duplicate-of` link、
  每次调用 append `work_item_status_log`。`update-work-item` **拒绝** status 字段。
- **watchdog（§6.2b L2，引擎硬保证）**：run 到终态时查 status_log“本 run 是否动过 status”，未动 → 置 `status_stale=true`
  + 看板 badge“AI 完成—状态未更新，请确认”。
- **finalize-status gate（§6.2b L1，结构）**：每交付 workflow 在 `end` 前必有 `finalize-status` library 节点；
  分解/校验**缺则自动注入**（与 git-push gate 同级，brain 不能省）。
- terminal closure（§6.2b）：agent 最后只到近终态（待发布）；终态（已上线/已关闭）本阶段**只实现人工“Mark shipped”**
  （经 `transition-work-item`）。**PR-merge/deploy webhook 整体推迟到 P6**（本阶段不做“接口预留”，避免空交付）。

#### C. 队列 + 跨任务并发（DESIGN §6.4）
- execState 机 `idle→queued→claimed→running→done|failed`(+paused/cancelled)；**与业务 status 严格分离**。
- **原子认领**：copy `claimA2ATaskForProcessing` 模式（`UPDATE … WHERE exec_state='queued'` → 查 affected rows → 单独 `SELECT`，
  **不用 RETURNING**，portability 规则，§6.4/§13）；single-flight + 死 worker 重认领。
- **worker pool**：`Promise.all(Array.from({length:N}, worker))` 模式（§6.4/§13），每 worker：claim → `run-start` → 循环。
- `concurrencyDegree` = `save-runtime-config` 值（Settings→Runtime 可调，§6.4）。
- **durable driver（D-3）**：pool loop 驻留单 server-plugin tick（仿 `jobs/scheduler.ts`）+ SQL heartbeat/reap 回收
  stranded running；serverless 用 cron tick/self-dispatch。
- **两并发上限都暴露**：`concurrencyDegree`（多少 work item 同时跑）+ `maxConcurrentVMs`（VM 容量，§6.4/§4.1）。
- 队列 actions：`enqueue-work-item`(priority, workflowId)、`dequeue-work-item`(queued→idle 出队)、`set-concurrency`、
  `queue-status`(返回 concurrencyDegree/running/maxConcurrentVMs/vmsInUse + **调度器自观测**：`schedulerAlive`/`lastTickAt`/`reapsFired`——
  防 tick 静默死后 run 静默挂起无信号)。`assign-work-item`=enqueue 简写。
- **无跨任务 dependsOn / 无 task 级 topo**（§6.4）：flat priority queue，跨任务排序是 brain 的判断（读 queue-status 规划）。

#### D. CRUD + links actions（DESIGN §10）
- Projects：`create-project`/`list-projects`/`get-project`/`update-project`。
- Work items：`create-work-item`/`list-work-items`/`get-work-item`/`update-work-item`（除业务状态字段外）/`delete-work-item`/`transition-work-item`。
- Links：`link-work-items`/`unlink-work-items`（duplicate-of/blocks/blocked-by/relates-to）。

#### E. Node Library（DESIGN §3.7）
- `node_defs` 表 + `save-node-def`/`list-node-defs`/`delete-node-def`（删除被引用时阻断并列出引用处）。
- **starter set**（§3.7/§12 phase3）：deterministic tool 节点 `run-tests`/`lint`/`git-commit`/`git-push`/`open-pr`/
  `apply-patch`/`finalize-status`；parameterized agent 节点 `code-review`/`security-review`/`secret-scan`/`pr-description`。
- 库节点带 `version`（可 pin）；graph 用 `nodeDefKey` 引用、可 per-use 覆盖（§3.7）。
- bundled 模板 `code-change-with-review`（§1.9/§3.7）。

#### F. 分解 + 动态编排 + promote（DESIGN §6.3/§6.5）
- 分解三序（§6.3）：显式 `workflowId` → 项目 `defaultWorkflowId` → brain 动态 build（bug：复现→定位→修复→测试→
  commit/push；deck：大纲→草稿→评审→导出），尾部接 vetted library gate。
- 动态编排（§6.5）：NL→`save-template` 生成 DAG（wiring library 节点）；runtime expansion 加 `dynamic:true` NodeRun；
  `promote-run-to-template(runId)` 把成功 run 蒸馏成模板。
- guardrail：authored graph 必须以项目要求的 gate 结尾（brain 只 wire vetted 库节点、不手搓 push/MR）。

#### G. 技能/文档改写到 v2（DESIGN §12 phase3 明确要求，四区之一）
- 改写 `orchestrating/SKILL.md`（`.agents` + `.claude` 两份同步）+ `CLAUDE.md`/`AGENTS.md` 到 v2 surface：
  从“手工走 step_runs”改为“分解 work item→图运行→在 §6.2a 判断点调 `transition-work-item`”（watchdog 的写半部分，
  否则每 run 都触发 watchdog）。
- 落 **docs 型默认 scheme**（如需求文档：待写作·撰写中·评审中·定稿），使非代码项目不被迫走测试/发布阶段（§12 phase3）。

#### H. 前端交付（PM 主面，FRONTEND §2/§3/§7/§10）
- **shared composites 基座一次性建在此**（看板首次需要它们，FRONTEND §Conventions C2/C3）：`app/lib/status-colors.ts`（单一语义色映射，
  看板列/badge/run canvas 同读）+ `<WorkItemCard>`/`<StatusBadge>`/`<ExecBadge>`/`<SeverityChip>`/`<EnvTag>`/`<DataTable>`/`<EmptyState>`/`<ConfirmDialog>`。
  **P4 §A 不重建这些，只验证/扩展并补编辑器专属的 `<NodeCard>`/`<ModelPicker>`**（消除重复建，§0.2.10）。
- **完整 Board kanban**（FRONTEND §2，构建于上述 composites）：by-status（按 scheme 列）+ Queue view（by execState）；filter bar；
  `<WorkItemCard>`（status/exec/severity/env/blocked/deliverable/stale/mini node strip）；拖拽=`transition-work-item`、⋯ run 控制=execState。
- **Projects** 列表 + 详情（FRONTEND §3）。**Library** 页（FRONTEND §7）。
- **human 审批 UI**：看板/item 页对 `awaiting-approval` 节点出审批入口 → dialog → `resolve-human-gate(approve|reject)`。
- Dialogs：D1（新建 work item）、D2（批量入队）、D3（新建/编辑项目）、D7（库节点）、D9（promote run→template）（FRONTEND §10）。
- 实时：`useDbSync()` 驱动看板/列表/dot-strip（poll `run-graph` 计数，非 N 个 per-card SSE，§2）。

### 关键实现逻辑（仅补设计未细化处）

- **transition 校验器**（DESIGN §6.2a“buildable validator spec”的算法化）：
  ```
  # helper 定义（消除歧义）
  stageIndex(s, scheme)  := s 在 scheme[type] pipeline 中的序号
  categoryOf(s, scheme)  := scheme 给 s 标的 statusCategory（todo|in_progress|completed|cancelled）
  forward(from,to,scheme):= stageIndex(to) > stageIndex(from) AND sameType
                            AND categoryOf(to) != "cancelled"     # 进 cancelled 必走 cancel 分支以强制 resolution

  transition-work-item(item, to, opts):
    scheme = project.status_schemes[item.type]; from = item.status
    if forward(from,to,scheme):                       # 合法（含 skip-forward：开发中→待发布一步）
       kind = "forward"
    elif (from,to) in scheme.transitions:
       kind = scheme.transitions[(from,to)].kind       # rework | cancel | reopen
    else: reject "illegal transition"

    if kind == "reopen":
       require to == scheme.reopenTarget[item.type]    # 必须回该 type 的再入阶段，否则 reject
       opts.resolution = null                          # reopen 清 resolution
    if kind == "cancel":
       opts.resolution = opts.resolution ?? "cancelled"  # cancel 默认 resolution

    cat = categoryOf(to, scheme)
    if cat in {completed, cancelled}:
       require opts.resolution in scheme.resolutionsAt[to]     # 否则 reject
       if opts.resolution == "duplicate": require link duplicate-of
    write {status:to, status_category:cat, environment/blocked/severity per opts}
    append work_item_status_log(actor, from, to, runId, at)
  ```
- **watchdog**（DESIGN §6.2b L2）：
  ```
  on run reach terminal execState(done|failed):
    changed = exists row in work_item_status_log where run_id==thisRun AND from!=to
    if not changed: set work_item.status_stale = true   # 看板出 confirm badge
  ```
- **worker tick**（DESIGN §6.4，原子认领，**不** RETURNING）：
  ```
  worker():
    loop:
      # 可移植认领（SQLite+Postgres 双跑）：排序在子查询，外层按 id 定位；不用 UPDATE...ORDER BY...LIMIT、不用 RETURNING
      affected = UPDATE work_items SET exec_state='claimed', claimed_by=me, claimed_at=now
                 WHERE id = (SELECT id FROM work_items WHERE exec_state='queued'
                             ORDER BY priority, id LIMIT 1)        # , id 作 tiebreaker 保确定性
                   AND exec_state='queued'                         # 双重判定防竞态
      if affected == 0: break
      item = SELECT * FROM work_items WHERE claimed_by=me AND exec_state='claimed' LIMIT 1
      run-start({workItemId: item.id}); on finish set exec_state=done|failed
  pool = Promise.all([worker() x concurrencyDegree])
  reap: 周期性把心跳超时的 'running'/'claimed' 回 'queued'（reapThreshold 显式常量）
  ```

### 验收标准（全勾选才 Done）

- [ ] 5 张新表加性应用；work_item 业务状态六维度列齐全；execState 列与业务 status 分离存储。
- [ ] **状态单写入口**：`update-work-item` 传 status 被拒；`transition-work-item` 是唯一写 status/env/blocked/resolution 的路径；
      每次调用写 `work_item_status_log` 一行。
- [ ] **transition 校验**：forward skip-forward 合法（开发中→待发布一步成功）；未列出的反向移动被拒；
      进 completed/cancelled 缺 resolution 被拒；reopen 清空 resolution；duplicate 缺 link 被拒。
- [ ] **watchdog**：跑完一个 agent 全程不调 transition 的 run → work_item `status_stale=true` + 看板出 confirm badge；
      调了的 run → 不 stale。
- [ ] **finalize-status gate（明确失败条件，非“合理”）**：构造无 finalize-status 的交付图 → save/分解后图中 `end` 前出现该库节点（节点存在可证）；
      run 结束时若该 work_item `status` 仍停早期阶段（agent 未调 transition 到 ≥待发布）→ finalize-status 节点 status=failed、run 失败；agent 调过 → pass。
- [ ] **队列并发（可测）**：批量 enqueue N（>concurrencyDegree）→ 运行中 `running` 峰值计数 == concurrencyDegree（采样断言 ≤ 且曾达到）、其余按 priority 排队；
      **原子认领单测**：K 个 worker 并发对同一批 queued 行 claim → 每行恰被一个 worker `claimed`（affected-rows 之和==行数、无重复 claimed_by）；
      手动将一 claimed/running 行心跳设过期 → 一次 reap tick 后回 queued 并被认领，同一 item 的 `workflow_run` 不出现两条 active（无双跑）。
- [ ] `set-concurrency` 调整后 worker pool 宽窄随之变化；`queue-status` 返回 concurrencyDegree/running/maxConcurrentVMs/vmsInUse。
- [ ] **分解优先级（断言来源，非仅“跑起来”）**：item 带 explicit workflowId 且项目有 default → 用 explicit（`run.templateId==explicit`）；
      无 workflowId、项目有 default → 用 default；二者皆无 → 触发 brain 动态 build（run 标 dynamic-authored）。三例各断言所选来源。
- [ ] **promote distill 匹配**：成功动态 run → `promote-run-to-template` 产出模板，其节点/边集合 == 该 run 实际执行拓扑（dynamic 固化为静态，节点数+关键 key 一致）；
      用该模板起新 run 走相同图形（无 dynamic 扩展即达交付）。
- [ ] **backfill 安全**：执行 v1→v2 backfill 后 v1 `tasks`/`workflows`/`step_runs` 行数与内容**零变化**（可证）；每个 v1 task 现为 v2 work_item 且能在看板打开；
      重复执行 backfill **幂等**（无重复行）。
- [ ] **项目绑定交付（P2 推迟项在此落地）**：code work_item 的仓库来自 `project.repo`、deliverable 记到 `work_item.deliverable`；
      非代码落 `project.workingDir`；与 P2 的 run 级路径一致但改读项目源。
- [ ] **human 审批闭环（UI）**：看板/item 页对 `awaiting-approval` 节点出审批入口；approve 放行、reject 分支 skip（走 `resolve-human-gate`）。
- [ ] **`dequeue-work-item` / `assign-work-item`**：dequeue 把 queued 项回 idle；assign 等价 enqueue（同 execState 转移可证）。
- [ ] **调度器自观测**：capacity popover/`queue-status` 显示 `schedulerAlive` + `lastTickAt`；杀掉 tick → UI 可见 stalled 信号（非静默）。
- [ ] **library starter set** 全部可拖入/被 brain 引用；删除被引用库节点被阻断并列出引用。
- [ ] `orchestrating/SKILL.md`（两份同步）+ `CLAUDE.md`/`AGENTS.md` 已是 v2 surface，明确 agent 在 §6.2a 判断点调 transition；
      docs 型默认 scheme 存在，非代码项目不被迫走测试/发布。
- [ ] 看板拖拽走 `transition-work-item`（非法落位回弹）；⋯ run 控制走 execState（不动业务 status）；二者 UI 上分离。
- [ ] D1/D2/D3/D7/D9 全部走对应 action（无手写 fetch）；乐观更新 + 失败回滚 + toast。

**风险**：状态机 6 维度复杂 → 以校验器单测矩阵（每 type 的 forward/rework/reopen/cancel/resolution 组合）兜底；
并发认领竞态 → 复用已验证的 `claimA2ATaskForProcessing` 模式 + 单测并发。

---

## P4 — 完整前端

**目标**：把前端从“最小切片”打磨到 **FRONTEND.md 完整规格**——React Flow 双模画布（编辑器 + run overlay）、
9 个页面全量、全部 dialog、全部 shared composites、C1–C5 约定（i18n zh/en、theme、status-colors、组件标准、a11y/keyboard）。
**可视化编辑器是本阶段重点，完整实现，不走 JSON 捷径。**

**前置依赖**：P1（图 schema + 统一 validator + run-graph/node-get/run-events）、P2（node inspector/terminal/diff 数据路径）、
P3（node_defs / projects / work_items / dialogs 所需 action）。

### 工作内容（按 FRONTEND.md 逐项落地，引用其规格不重写）

#### A. 共享基础（FRONTEND §Conventions C1–C5）
- C1 i18n：`i18next`+`react-i18next`，`en`/`zh` 平行资源树；status/exec/env/severity 标签皆 i18n key（存稳定 stage key，
  显示 `t("status.${key}")`）；数字/日期/相对时间走 `Intl`。
- C2 theme + **`app/lib/status-colors.ts` 单一语义色映射**（看板列/badge/run canvas 节点 tint 同读一处）。
- C3 组件标准（哪个 shadcn primitive 干什么，见 FRONTEND §C3 表）；**shared composites 基座已在 P3 §H 建**
  （`status-colors.ts`/`<WorkItemCard>`/`<StatusBadge>`/`<ExecBadge>`/`<SeverityChip>`/`<EnvTag>`/`<DataTable>`/`<EmptyState>`/`<ConfirmDialog>`）——
  **P4 只验证/扩展、不重建**，并**新增编辑器专属**：`<NodeCard>`（编辑器与 run overlay 共用）/`<ModelPicker>`。
- C4 数据/状态：统一 `useActionQuery`/`useActionMutation` + `useDbSync()`；run-events SSE 仅 item 页一条流；乐观默认。
- C5 icons（Tabler，统一 icon map）/ composer（`AgentComposerFrame`+`PromptComposer`+`TiptapComposer`）/ a11y（focus ring、
  dialog trap、⌘K、看板方向键、item 页 r/p 快捷键）。

#### B. 全局 shell（FRONTEND §0）
- topbar（Project ▾ / ⌘K / capacity `3/5 tasks · 7/12 VM` / theme / lang / account）；6 入口 sidebar；agent chat sidebar；
  每路由经 `navigate` 写 `navigation`（+ item 页写 `nodeRunId`），`view-screen` 回报。
- **auth/account（审查补，FRONTEND §0 + CLAUDE.md）**：`account ▾`（读 `session` + profile + sign-out）；未登录路由保护复用框架 `authentication`
  （若模板继承框架默认 auth shell，显式标注为复用，不当默认存在）。
- **画布单一来源**：P1 §F 的 list/dagre 画布是**一次性占位**，在此被 `<WorkflowCanvas mode="run">` **替换**；P2 §K 的 inspector+xterm 在此**复用**进新组件、不重复实现。

#### C. React Flow 编辑器（FRONTEND §6 + §6.3）⭐
- 单 `<WorkflowCanvas mode="edit"|"run">`（编辑器与 run overlay 同组件两模，build once）。
- 自定义节点类型（11 种 + dropped library 节点），全由 `<NodeCard>` 渲染；run 模式按 C2 色映射 tint。
- 容器节点（parallel/loop/fanout）= React Flow group/parent 节点，children 设 `parentNode`；边带 `when` label（custom edge）。
- 3 pane：**Palette**（Nodes tab + Library tab，库节点带 lock glyph，`list-node-defs`）；**Canvas**；
  **Inspector**（全字段：title/assignee/engine-model picker（**自定义 dropdown**，§8.5 white-list 绕过；**P4 仅写入 in-memory graph，真实路由生效与验证在 P5**——P4 “完整前端”不等于 picker 已生效）/
  effort/prompt（`{{deps.<id>.output}}` autocomplete）/outputSchema/condition builder/await/retry/timeoutMs/
  **runtime 子面板**（kind/image/baseRef/branch/mounts/creds 多选已注册 secret key/resources/onFailure）/
  fanout(itemsFrom+maxConcurrency)/loop(condition+maxIterations+dedupeKey+dryRounds)/**subworkflow(templateRef 选择器)**/**human(审批提示文案)**）。
- **实时校验 banner**（共享 validator，含 implicit-barrier lint；错误阻断 Save、warning 不阻）。
- **JSON view fallback**（power-user，与画布编辑同一 in-memory model，toggle 时 parse；保证画布与 agent-editable JSON 不分叉）。
- 按钮：Save（`save-template` 乐观 + 升 version）/Validate/Run once…（D1 预填模板 → run-start → 跳 item 页）/JSON view/Save as new。

#### D. Item/Run console 完整（FRONTEND §4）⭐
- (a) 左：live DAG canvas（`mode="run"`，`run-graph` + `run-events`/`useDbSync` 动画；节点按状态 tint；loop iteration 计数；
  dynamic fanout child 实时出现带 glyph；点节点写 `application_state.nodeRunId`）。
- (b) 右：node inspector（`node-get` 全字段 + runtime 信息 + xterm 终端 + 节点按钮 Re-run/Edit&re-run(D5)/View diff/Open sub-run）。
- (c) 底 tabs：Overview / Steps timeline / Terminal / Deliverable / Events。
- header run 控制（Run/Re-run/Pause/Resume/Cancel(D4)/Token budget chip/deliverable chip），enabled 规则见 §4 表。
- 状态：未挂 workflow → attach 提示；未起 run → 灰静态模板 + 大 Run；cancel mid-edit → cooperative abort banner。

#### E. 其余页面
- Board（P3 已建，确认达 FRONTEND §2 完整规格）；Projects/详情（§3）；Workflows 模板目录（§5，含 D9 promote）；
  Library（§7）；**Runs 全局活动页**（§8，`list-runs` 表 + filter）；Settings（§9，P5 扩展）。

#### F. Dialog 全集（FRONTEND §10）
- D1/D2/D3/D4/D5/D7/D8/D9（D6 已删）；统一 Esc/overlay 取消、primary 仅 in-flight 转圈、inline 校验、出错保持打开。

### 验收标准（全勾选才 Done）

- [ ] **画布 = JSON 双向一致（定义规范形）**：忽略画布坐标/视觉字段后，节点集合（按 id）+ 边集合（按 from,to,when）+ 每节点配置字段**深度相等**；
      画布→JSON→画布→JSON 二次序列化（规范化后）**字节一致**；改 JSON 中一节点 prompt → 画布该节点 inspector 显示新值。
- [ ] **校验拦截**：构造含环/缺 condition/缺 when/双 start 的图 → banner 报错且 Save 被禁；implicit-barrier 出 warning 不禁 Save；
      client banner 与 `save-template` 用**同一** validator（代码可证）。
- [ ] **编辑器 inspector 全字段可编辑**并写入 in-memory model，Save 前不触服务端；fanout/loop/branch/runtime 子面板齐全。
- [ ] **run overlay 实时**：起 run 后画布节点状态实时 tint；loop iteration 计数变化；dynamic fanout child 实时出现带 glyph；
      点节点 → 写 `nodeRunId` → 填 inspector。
- [ ] **同一 `<WorkflowCanvas>`/`<NodeCard>` 两模复用（证明法）**：grep 证 `WorkflowCanvas`/`NodeCard` 各仅一个定义文件、被编辑器与 run 页两处 import（同一符号）；
      改 `<NodeCard>` 渲染一处 → 编辑器与 run overlay **同时**变化（前后截图对比）。
- [ ] **item 页 5 个底 tab 各可用**：Steps timeline 行点击选中对应节点；Events 原始 `run-events` 可按节点过滤；Deliverable 显示 PR 卡/文件列表可下载；
      Overview 显示按状态计数 + 剩余预算；Terminal（P2 已验）在此宿主于新画布。
- [ ] **9 页全通 parity map**（FRONTEND §11）：每页读/写 action 与表一致；无任何手写 REST（grep 验证）。
- [ ] **每页空/加载/错误态齐全**：9 页每个 list/board/canvas 都有 skeleton(loading) + `<EmptyState>`(空) + 错误 toast/inline(失败)；无裸空白或全页 spinner。
- [ ] **i18n（自动检测无裸 key）**：i18next `missingKeyHandler` 在测试环境抛错/收集缺失 key；切 en/zh 渲染全部 9 页快照中无 `ns.key` 形态裸串；status/exec/env/severity 皆经 `t()`。
- [ ] **theme**：light/dark 切换无 reload；看板列/badge/canvas 节点同读 `status-colors.ts`（改一处全变，前后对比可证）。
- [ ] **shared composites 单实现**：grep 证每个 composite 仅一处定义、被多页 import；改一处多页生效。
- [ ] **a11y/keyboard**：⌘K palette、item 页 r/p、画布方向键选节点、dialog focus trap 均可用。
- [ ] 全 dialog（**D1, D2, D3, D4, D5, D7, D8, D9；D6 已删**）走对应 action、乐观 + 回滚 + toast；destructive（D4/D8）用 AlertDialog + 唯一允许的 click-blocking spinner。

**风险**：React Flow 容器/嵌套（fanout/loop group）复杂 → 先做 group/parentNode 原型；canvas↔JSON 同步 bug →
以“双向一致”为硬验收，single in-memory model 为唯一真相。

---

## P5 — Runtime 配置收尾

**目标**：完成 DESIGN §8.3 剩余的 runtime 配置缺口——per-node 模型选型真实路由、vLLM Test、模型列表、
orchestrator-runtime 路由消费的端到端验证，以及 Settings 的 Images/Credentials tab（FRONTEND §9）。

**前置依赖**：P2（三执行器 + 路由判定）、P4（编辑器 inspector 的 ModelPicker、Settings 页）。

### 工作内容

- **per-node engine/model picker 真实路由（§8.3 item1/§8.5）**：编辑器 inspector 的 `<ModelPicker>` = **自定义 dropdown**
  fed by `list-runtime-configs` + 内置 engine 列表（绕开框架 composer white-list `["anthropic","ai-sdk:openai","ai-sdk:google"]`，§8.5.3）；
  选中值经 P1 的 `resolveNodeExecutorChoice` 真实路由到对应 executor（vLLM/claude/hosted）。
- **`test-runtime-config`（§8.3 item2）**：一次性 `resolveEngine` + 小 completion 打到保存的 `baseUrl`，返回**真实**结果/错误
  （与 Claude Code Test 对等）。Settings→Runtime 加 vLLM “Test” 按钮。
- **模型列表来源（§8.3 item4）**：per-node picker 读各 `runtime_configs.model`（+ 可加性新增的 model-list 列），
  **不**重新注册模板级自定义 engine（dual-registry 陷阱，§8.5.1）。
- **orchestrator-runtime 路由消费验证（§8.3 item3）**：确认 marker 真正驱动 EXECUTE 选择（P2 已实现，此处端到端验证 + 暴露在 UI）。
- **Settings Images / Credentials tab（FRONTEND §9）**：base microVM image registry（image ref per 项目/语言运行时 + build 状态，§7.4.8）；
  Credentials（哪些 secret key 已注册 + runtime 挂哪些，复用框架 secrets/Vault surface，永不显值）。
- 并发控制 UI：`concurrencyDegree` + `maxConcurrentVMs` sliders → `set-concurrency` / runtime config（FRONTEND §9）。

### 验收标准（全勾选才 Done）

- [ ] 编辑器里给某节点选 vLLM、另一节点选 claude-code、第三个选 hosted → 起 run 后**各自真实路由**（`node-get.executor` 分别为三值，且与执行路径一致：
      claude 节点 logs 含 stream-json、vLLM 节点 logs 含 host baseUrl 调用）。
- [ ] **vLLM “Test” 真打网络**：指向**不存在** baseUrl → 返回明确连接错误（非 success）；指向有效 vLLM → completion 文本非空且与 prompt 相关（证明真打到模型，非 mock）。
- [ ] per-node picker 的模型来自 `runtime_configs`（非模板注册 engine）；未引入自定义 `"vllm"` engine（§8.5 约束1 不回归）。
- [ ] **marker 优先级（用无 `engine` 节点，D-7）**：切换 `orchestrator-runtime` marker（claude-code↔vllm）→ **未设 `engine`** 的 code 节点 `node-get.executor` 随之变；
      同图中**显式设 `engine`** 的节点不受 marker 影响（断言 per-node 覆盖优先）。
- [ ] **model-list 来源决策**：per-node picker 至少读 `runtime_configs.model`；`runtime_configs` 的 model-list 列**仅在单 endpoint 多模型需求时加性引入**（给出触发条件）；验收绑定实际所用来源。
- [ ] **Settings Images tab（明确只读语义）**：只读列出已烤 image ref + 来源 + build 状态，**无 in-app build**（§7.4.8 CLI 预烤）；Credentials tab 列已注册 key 与挂载关系、**不显任何值**。
- [ ] concurrencyDegree / maxConcurrentVMs sliders 生效（与 P3 队列联动）。

**风险**：§8.5 三约束（dual-registry / 服务端写占位 key / composer white-list）回归 → 验收明确各列一条“不回归”检查。

---

## P6 — Hardening

**目标**：把单机自用打磨成稳健可长跑、并为多机/无 KVM 环境预留路径（DESIGN §12 phase6、§14）。

**前置依赖**：P1–P5。

### 工作内容

- **持久化 run store + heartbeat/reap（§14 D-3）**：`startRun` 态 in-memory per isolate → 单驻留 driver + SQL 心跳，
  崩溃/重部署后恢复 stranded `running` NodeRun / work_item，多实例不双调度。
- **全并发上限与背压**：`maxConcurrentModelCalls`/`maxConcurrentVMs`/per-run backstop 在压力下不被突破；VM/资源耗尽
  与 token 预算分别上报与限流（§4.1）。
- **预算上限强制（§1.8）**：耗尽即拒新 dynamic 节点（含边界用例）。
- **审计日志**：control/transition/凭证解析关键动作落审计（复用 Vault audit，§7.4.7）。
- **多机 / 远程执行（§7.4.2/§14）**：**远程 microsandbox `NodeRuntime`**（microsandbox 经网络）+ durable run store
  （多 KVM host）。**仍仅 microsandbox**，无其他 backend。
- **PR-merge / deploy webhook 终态闭环（§6.2b）**：webhook 调 `transition-work-item(→已上线/已关闭, resolution:shipped)`，
  复用框架 `integration-webhooks`。
- **runtime_configs 作用域（D-5）**：如需 sharing，加性迁到 `ownableColumns()`。

### 验收标准（全勾选才 Done）

- [ ] **崩溃恢复（分场景断言，非“恢复或reap”二选一含糊）**：(a) 杀进程时一 run 含 done+running 混合 → 重启后 done 节点**不重跑**（journal 计数）、running 节点按 §1.7
      atomic re-run 整体重来；(b) 一 work_item 处 `claimed` 时杀 worker → 重启后被**恰一个** worker 重认领、`workflow_run` 不出现两条 active（无双跑）；
      (c) 任何被 reap 的行在 `work_item_status_log`/run 事件**留痕**（无静默丢失）。
- [ ] **压测量化**：以 M = 2×`maxConcurrentVMs` 个 work_item 同时入队压测 ≥ T 分钟：运行中 VM 峰值 ≤ `maxConcurrentVMs`（监控断言）；
      超额节点收 **`VMCapacityExhausted`** 错误类型（≠ `TokenBudgetExceeded`）并触发背压（排队而非误报 token 超预算）。
- [ ] 预算上限在边界用例下被强制（耗尽精确停新 dynamic 节点）。
- [ ] 关键动作有审计记录。
- [ ] （多机）远程 microsandbox runtime 经网络跑通同一 NodeRunner 七阶段；durable store 下崩溃恢复无双跑。
- [ ] PR-merge webhook 触发 → 对应 work_item 自动到终态 + resolution=shipped；人工“Mark shipped”路径同样可用。

---

## 附录 A：追溯矩阵

证明“无遗漏”：每个设计章节都落到某阶段。

| 设计章节 | 主题 | 落地阶段 |
|---|---|---|
| DESIGN §1.1–§1.10 | 动态工作流不变量（确定性/pipeline/预算/校验模式） | P1（引擎不变量）+ P3（§1.9 验证模式→library） |
| DESIGN §2 / §2a | 模板vs运行实例 / brain+engine 双组件 | 模型 P1；brain MCP 通道 P2 |
| DESIGN §3.1–§3.6 | 图 schema / 节点类型 / 边 / 条件 / 序列化 | P1 |
| DESIGN §3.1 `human` 节点 | 审批闸（挂起+resolve+UI） | P1（引擎挂起+`resolve-human-gate`）/P3（审批 UI），复用 §11 dispatch 审批 |
| DESIGN §3.1 `subworkflow` 节点 | 模板内联（一层嵌套+共享预算 §1.2） | P1（展开+配额共享）/P4（inspector 模板选择器） |
| DESIGN §3.7 | Node Library（可复用 gate/分析节点） | P3（编辑器 palette 在 P4） |
| DESIGN §4.1–§4.4 | 调度器 / item-correlation / 控制 API / 观测 API | P1 |
| DESIGN §5 / FRONTEND §6 | DAG 编辑器 | P4（schema/validator 在 P1） |
| DESIGN §6.1 | Project | P3 |
| DESIGN §6.2 / §6.2a / §6.2b | Work Item / 六维度状态 / 单写入口+watchdog+gate | P3 |
| DESIGN §6.3 | 分解三序 | P3 |
| DESIGN §6.4 | 队列 + 跨任务并发 | P3 |
| DESIGN §6.5 | 动态编排 + promote | P3 |
| DESIGN §7.0 / §7.0a / §7.0b | 隔离决策 / 调研 / 不用框架 harness | P0 spike + P2 |
| DESIGN §7.1 / §7.1a | in-VM git / 分支生命周期 | P2 |
| DESIGN §7.2 / §7.3 | 非代码交付 / 交付记录 | P2 |
| DESIGN §7.4.1–§7.4.9 | NodeRunner 七阶段 / NodeRuntime / 执行器 / 凭证 / image / 网络 | P2 |
| DESIGN §8.1 | 已有 runtime（复用） | 基线（§0.1） |
| DESIGN §8.3 / §8.5 | per-node 选型 / vLLM Test / 路由 / 三约束 | P5 |
| DESIGN §9 | 数据模型（新表） | 表分 P1（templates/runs/node_runs/artifacts）+ P3（projects/work_items/links/status_log/node_defs） |
| DESIGN §10 | Action surface | 见附录 B 分阶段 |
| DESIGN §11 | 现状vs待建 gap 表 | 全程对照 |
| DESIGN §12 | 设计自带分阶段 | 本规划细化/重排（microVM 前置、编辑器不缓） |
| DESIGN §13 | 框架 API 锚点 | 全程引用（实现时按 file:line） |
| DESIGN §14 | 开放风险 | §0.3 待确认决策 + 各阶段风险 |
| DESIGN §16 | 可行性结论 | P0（spike 闸门 + 顺序依据） |
| FRONTEND §Conventions / §0 | C1–C5 + shell + composites + auth/account | **composites 基座在 P3 §H**；shell/auth/account 在 P4 §B（复用框架 `authentication`）；C1–C5 在 P4 |
| FRONTEND §1–§9 | 9 页 | 最小切片随 P1/P3/P5，完整规格 P4 |
| FRONTEND §10 | Dialog D1–D9 | D1/D2/D3/D7/D9 随 P3；全集 P4 |
| FRONTEND §11 | parity map | P4 硬验收 |
| FRONTEND §12 | 跨切面交互模式 | P4 |
| FRONTEND §13 | build order | 本规划按 microVM 前置 + 编辑器不缓重排 |

## 附录 B：Action 全量清单与归属阶段

| Action | 归属 | 说明 |
|---|---|---|
| 已有 21 个（task/workflow CRUD、run-orchestrator、upsert/list-step-run、stop-task、runtime 6、navigate、view-screen） | 基线 | 保留；v1 表迁移后部分被 v2 取代但不删（DESIGN §9） |
| save/list/get/delete-template、promote-run-to-template | P1（promote 逻辑）/P3（真实数据） | DESIGN §6.5/§10 |
| run-start/pause/resume/cancel、run-retry-node、node-override | P1 | DESIGN §4.3 |
| resolve-human-gate | P1（引擎）/P3（UI） | DESIGN §3.1/§11；human 审批闸，复用 dispatch 审批 |
| run-get/run-graph/node-get/run-events、list-runs、node-report | P1 | DESIGN §4.4/§10 |
| save/list/delete-node-def | P3 | DESIGN §3.7 |
| create/list/get/update-project | P3 | DESIGN §10 |
| create/list/get/update/delete-work-item、transition-work-item | P3 | DESIGN §6.2b/§10 |
| link-work-items/unlink-work-items | P3 | DESIGN §10 |
| enqueue/dequeue-work-item、set-concurrency、queue-status、assign-work-item | P3 | DESIGN §6.4 |
| test-runtime-config | P5 | DESIGN §8.3 |

## 附录 C：数据表新增清单与归属阶段

| 表 | 阶段 | 列依据 |
|---|---|---|
| workflow_templates | P1 | DESIGN §9 |
| workflow_runs | P1 | DESIGN §9 |
| node_runs | P1（核心列）/P2（加 runtime 列） | DESIGN §9（journal 唯一键）；P2 加性补 `vm_id`/`runtime_info`（或 `kind:"runtime"` artifact）供 node-get 显示 executor/microVM id/branch/onFailure |
| artifacts | P1 | DESIGN §9 |
| projects | P3 | DESIGN §9/§6.1 |
| work_items | P3 | DESIGN §9/§6.2 |
| work_item_links | P3 | DESIGN §9 |
| work_item_status_log | P3 | DESIGN §9/§6.2b |
| node_defs | P3 | DESIGN §9/§3.7 |
| （runtime_configs 加 model-list 列，可选） | P5 | DESIGN §8.3 item4 |
| （v1 workflows/tasks/step_runs/runtime_configs/shares） | 不动 | DESIGN §9 加性约束 |

---

> **如何使用本规划**：按 P0→P6 顺序推进，每阶段“全勾选才 Done”才进下一阶段；§0.2 不变量是每个 PR 的 review 清单；
> §0.3 决策需在对应阶段开工前确认（默认值见表）。所有“怎么做”的细节以 DESIGN/FRONTEND 章节为准，本文只管
> “做什么、何时做、做到什么程度算过”。
