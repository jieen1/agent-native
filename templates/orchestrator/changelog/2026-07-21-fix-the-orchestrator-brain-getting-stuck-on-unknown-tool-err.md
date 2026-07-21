---
type: fixed
date: 2026-07-21
---

Fix the orchestrator brain getting stuck on 'Unknown tool' errors when running on a non-Claude runtime (e.g. Aliyun) by adding its real recovery actions (nodeRetry, runCancel, spawnCancel) to its tool catalog and giving it a corrective hint listing its real available tools instead of a dead end
