# Orchestrator v3 — 分阶段实施规划 P4（修订版）

> **修订说明**：P4（硬化 + 运维）基本不受影响。新增日志捕获对接。
> 详见原版 [v3-IMPLEMENTATION-P4.md](./v3-IMPLEMENTATION-P4.md)。

---

## P4 — 数据生命周期 + 网络安全 + 结构化日志 + 错误恢复 + 多用户隔离

**目标**：TTL 清理、网络白名单、结构化日志、Postgres/msb/shim 错误恢复、resolveAccess。

**前置依赖**：P3（全功能可用）

**核心不变**。硬化层与原版 P4 一致。

### 微小调整

- **日志管理**：`v3_spawns.log_ref` 文件需 TTL 清理策略（run 完成后 N 天删除）
- **错误恢复**：msb CLI 异常已有 NodeRunner `onFailure` 路径，需确保 V3 dispatcher 正确传播
- **网络白名单**：`networking.ts` 已有 NO_PROXY 配置，P4 收紧为 allowlist 模式

---

**工作量**：~2-3 天（与原版一致）
