---
type: fixed
date: 2026-07-23
---

接上了此前从未被真正调用过的数据生命周期清理任务(artifact/event TTL、过期 run 归档),现在会按周期自动运行,避免历史数据无限增长
