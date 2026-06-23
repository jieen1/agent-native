# Orchestrator v3 — 分阶段实施规划 P3（修订版）

> **修订说明**：P3（Web UI 表面）不受后端代码复用的影响。UI 层不变。
> 详见原版 [v3-IMPLEMENTATION-P3.md](./v3-IMPLEMENTATION-P3.md)。

---

## P3 — Web UI 表面

**目标**：工作流模板编辑器、Run 详情页、节点图可视化、Patch 界面。

**前置依赖**：P2（reconciler + patch + fork 全部可用）

**核心不变**。UI 消费 V3 action 表面，和原版 P3 一致。

### 微小调整

- **Run 详情页**：增加 `log_ref` 查看器（展示 VM stdout/stderr）
- **节点图**：显示 `dag_version`，patch 后高亮变更节点
- **Fork 按钮**：在 Run 详情页，支持 fromNode 选择

---

**工作量**：~3-4 天（与原版一致）
