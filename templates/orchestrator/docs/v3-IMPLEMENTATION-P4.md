# Orchestrator v3 — 分阶段实施规划 P4

> 配套文档：[P0](./v3-IMPLEMENTATION-P0.md) [P1](./v3-IMPLEMENTATION-P1.md) [P2](./v3-IMPLEMENTATION-P2.md) [P3](./v3-IMPLEMENTATION-P3.md)
> 前置：P3 Done（UI 可用、所有后端能力可操作）

---

## P4 — 硬化 + 运维 + 数据生命周期 + 安全边界

**目标**：从可用到可运维。补齐数据清理、网络隔离、结构化日志、多用户隔离、错误恢复。

---

### 工作内容

#### A. 数据生命周期（审查发现 CRITICAL）

P0-P3 只写不删。P4 建清理策略。

- **Artifact TTL**：
  - `v3_artifacts` 加 `expires_at` 列（默认 run completed + 30 天）
  - 定时任务每日清理过期 artifacts，保留 metadata（byte_size 写入 v3_spawns）
  - `workspace.create` 带 `keep_after_run: true` 的 run，artifacts 不过期
- **Events 清理**：
  - `v3_events` 按 run 完成时间清理（默认 7 天）
  - SSE 消费完的数据不需要持久化
- **Run 归档**：
  - `runs.list` 加 `archived` 过滤
  - 新增 `run.archive(runId)` action，mark archived + 清理关联 spawns/artifacts
- **配置参数**：
  - `artifact_ttl_days`（默认 30）
  - `event_ttl_days`（默认 7）
  - `archive_after_days`（默认 90）

#### B. 网络安全边界（审查发现 CRITICAL）

Worker shim 在 microVM 内运行，文件系统隔离 OK，但网络无限制。

- **VM 网络限制**：
  - 默认禁用出站连接（Alpine 无 DNS）
  - 允许列表：host-gateway（LLM API）、workspace VM 内 `/work` 路径
  - `Bash` 工具的 `curl`/`wget`/`nc` 命令通过 allowlist 白名单域名
- **Tool 沙箱加固**：
  - Bash：超时（默认 30s）、无 sudo、无 SSH key 访问
  - 禁用 `ssh`, `scp`, `rsync`, `curl <external>`, `wget <external>`
  - 允许 `curl <host-gateway>`, `npm install`（如 agent 需要）
- **Symlink 防护**：
  - Read/Edit/Write 检测 symlink 跳出 `/work` → 拒绝
  - Glob/Grep 不跟随 symlink

#### C. 结构化日志 + 调试

- **日志框架**（`server/lib/logger.ts`）：
  - 结构化 JSON 日志（level, timestamp, module, run_id?, spawn_id?, message）
  - Reconciler 每次 tick 输出 summary（processed runs, dispatched nodes）
  - Dispatcher 每次 spawn 输出 lifecycle events
- **调试端点**（仅开发环境）：
  - `GET /_v3/debug/reconciler/state` — 返回 reconciler 内部状态
  - `GET /_v3/debug/pool/heap` — 返回 VM 内存占用
- **日志级别**：
  - ERROR：spawn 失败、reconciler panic、pool 耗尽
  - WARN：retry、timeout、guard skip
  - INFO：node 状态转换、run 开始/结束
  - DEBUG：reconciler 决策细节、插值结果

#### D. 错误恢复增强

- **Postgres 连接池监控**：
  - 连接池空 → spawn 排队等待，超时返回 transient error
  - 连接断开 → 自动重连（max 3 次），仍失败 → mark reconciler unhealthy
- **msb daemon 崩溃**：
  - 检测到 msb 不可达 → 暂停 pool 补位 + 新 spawn
  - msb 恢复 → 恢复调度，cancel 超时 spawn
- **Worker shim 崩溃**（OOM/segfault）：
  - VM 退出码非零 → 检查 exit code
  - 非 0 → error_class=permanent（代码 bug，retry 无意义）
  - 记录 exit code + stderr 到 v3_spawns.error

#### E. 多用户隔离（审查发现 WARNING）

设计 §19 说 single-tenant，但实际部署可能多用户共享。

- **Per-tenant pool cap**：
  - pool capacity 按 workspace 分，不是全局
  - `ownableColumns()` 确保用户只看到自己的 runs/spawns
- **Request context**：
  - 所有 V3 action 通过 `resolveAccess` 建立请求上下文
  - 确保 `accessFilter` 作用域到当前用户/workspace

---

### 验收标准（全勾选才 Done）

#### 数据生命周期

- [ ] **Artifact 清理**：设置 TTL=1 天 → 24h 后过期 artifacts 被清理
- [ ] **Events 清理**：设置 TTL=1 天 → 24h 后过期 events 被清理
- [ ] **Run 归档**：archive 后 runs.list 默认不显示已归档
- [ ] **keep_after_run**：标记 keep 的 run artifacts 不清理

#### 网络边界

- [ ] **出站禁用**：spawn 内 `curl http://example.com` → 连接失败
- [ ] **Allowlist 通**：spawn 内 `curl <host-gateway>` → 成功
- [ ] **Symlink 检测**：Read 跟随跳出 /work 的 symlink → 被拒

#### 日志

- [ ] **结构化日志**：日志输出为 JSON，含 module/run_id/spawn_id
- [ ] **Reconciler 日志**：每次 tick 输出 processed count
- [ ] **错误可追踪**：spawn 失败 → 日志可追溯到 run + node + spawn

#### 错误恢复

- [ ] **Postgres 断连**：断开 → 重连成功 → 调度继续
- [ ] **msb 崩溃**：杀 msb 进程 → spawn 返回 error → 恢复 msb → 新 spawn 正常
- [ ] **Shim OOM**：shim 退出码非零 → error_class=permanent

#### 多用户

- [ ] **ownableColumns 生效**：用户 A 看不到用户 B 的 runs/spawns
- [ ] **resolveAccess**：所有 v3 action 建立请求上下文

---

**风险**：
- VM 网络限制依赖 microsandbox 是否支持网络策略 — 如不支持，只能在 shim 层拦截
- 数据清理定时任务需独立于 reconciler tick — 建议用 Node `setInterval` 或独立 plugin
- 多用户隔离假设 framework `ownableColumns` + `accessFilter` 可用 — 需验证
