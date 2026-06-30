# V3 实施规划修订总结

> 基于最新分支代码差异分析（v3-GAP_ANALYSIS.md）的整体修订说明

---

## 核心发现

最新分支包含大量 V3 设计所需代码（~10,000 LOC），覆盖 ~65% 需求。实施规划从"从零搭建"调整为"迁移+对接"。

## 工作量对比

| 阶段 | 原版估算 | 修订版估算 | 变化 |
|---|---|---|---|
| P0 | ~3 天 | ~1-2 天 | -33% |
| P1 | ~5 天 | ~5 天 | 0%（reconciler 是新复杂度） |
| P2 | ~4 天 | ~5 天 | +25%（patch 系统是核心增量） |
| P3 | ~3-4 天 | ~3-4 天 | 0% |
| P4 | ~2-3 天 | ~2-3 天 | 0% |
| **总计** | **~17-19 天** | **~16-19 天** | **-5%~-15%** |

## 主要变化

### P0 — Spike + 基础设施
- ~~Worker shim 从零搭建~~ → 复用 NodeRunner + acting-bridge
- ~~VM provision/teardown~~ → 复用 MicrosandboxRuntime
- ~~Tools 实现~~ → 复用 existing tool surface
- Spike 缩为纯验证 channel contract
- **新增**：双迁移配置（drizzle-kit 区分 V2/V3）、连接池策略
- **新增**：表达式解析器路径表达式（inputs/deps/item/iteration/history）
- **新增**：移除 `@xyflow/react`、Legacy action deprecation

### P1 — 核心引擎
- ~~Worker Dispatcher~~ → 复用 node-runner.ts
- ~~VM provision/teardown~~ → 复用 microsandbox-runtime.ts
- ~~Worker shim~~ → 复用 engine-loop.ts + claude-code-executor.ts
- ~~Git workspace CRUD~~ → 复用 git-wrapper.ts
- ~~Auth/secrets~~ → 复用 vm-creds.ts
- ~~VM networking~~ → 复用 networking.ts
- ~~Error/retry~~ → 复用 NodeRunner onFailure
- **新增**：V3 事件驱动 reconciler（V2 scheduler 不支持 mid-run 干预）
- **新增**：V3 dispatcher 适配层（封装 NodeRunner + channel contract）
- **新增**：插值上下文构建器
- **新增**：Node type adapter（V3 → NodeRunner Node）
- **新增**：Postgres advisory lock（确定性选择）
- **新增**：失败节点 cascade skip downstream
- **新增**：error class → onFailure 映射（transient→rollback, permanent→keep, workspace→recreate）

### P2 — 高级功能
- ~~ACP runtime~~ → 复用 acp-adapter.ts（869 LOC 完整实现）
- ~~ACP session~~ → 复用 harness/store.ts
- ~~Git delivery~~ → 复用 git-wrapper.ts
- ~~Warm pool~~ → 复用 backpressure.ts VmSemaphore
- Fork 语义修正：prune-based → clone + artifact cache（匹配设计 §8.4）
- **新增**：Patch 系统（5 种 mutation 与设计 §8.6 对齐：modify_node/add_node/remove_node/modify_loop/replace_dag）
- **新增**：`fromNode` transitive scope 明确定义
- **新增**：Tags 从"继承链"改为设计 §16"opaque JSONB"
- **新增**：ACP 对接改为注册表模式（`resolveAgentHarness()` 替代 `createAcpHarnessAdapter()`）
- **新增**：ACP error class 细化（未注册→permanent, npm→transient, 超时→transient）

### P3/P4 — UI + 硬化
基本不变。P3 增加 log_ref 查看器、dag_version 高亮、fork 按钮。

## 真正的增量工作

| 新增能力 | 设计 § | 原因 |
|---|---|---|
| V3 事件驱动 reconciler | §9 | V2 scheduler 不支持 mid-run patch/pause |
| V3 dispatcher 适配层 | §6.2 | channel contract 约束（4输入/3输出路径） |
| Patch 系统（CAS DAG mutation） | §8.6 | V2 无 runtime DAG mutation |
| Run fork（clone + artifact cache） | §8.4 | V2 无此能力 |
| Tags 约定 | §16 | V2 无跨应用追踪 |
| 插值上下文构建器 | §5.1 | V3 `{{deps.X.output.Y}}` 格式 |
| Ad-hoc spawn | §8.1 | 不关联 run 的轻量调用 |
| V3 数据模型（8 张 Postgres 表） | §3 | V2 用 LibSQL + V2 表名 |
| SSE route | §14 | V2 无事件流 |
| Server 启动插件 | — | V3 reconciler 需要 plugin 管理 |

## 文件清单

| 文件 | 状态 |
|---|---|
| [v3-GAP_ANALYSIS.md](./v3-GAP_ANALYSIS.md) | 新增 — 差异分析 |
| [v3-IMPLEMENTATION-P0-v2.md](./v3-IMPLEMENTATION-P0-v2.md) | 修订版 P0 |
| [v3-IMPLEMENTATION-P1-v2.md](./v3-IMPLEMENTATION-P1-v2.md) | 修订版 P1 |
| [v3-IMPLEMENTATION-P2-v2.md](./v3-IMPLEMENTATION-P2-v2.md) | 修订版 P2 |
| [v3-IMPLEMENTATION-P3.md](./v3-IMPLEMENTATION-P3.md) | 原版 P3（不受影响） |
| [v3-IMPLEMENTATION-P4.md](./v3-IMPLEMENTATION-P4.md) | 原版 P4（不受影响） |
| [v3-REVISION-SUMMARY.md](./v3-REVISION-SUMMARY.md) | 本文档 |
