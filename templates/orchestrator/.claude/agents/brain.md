---
name: brain
description: The orchestrator brain's capability-profile row (F4, design 02 §5.4) — NOT a DAG worker agent. Do not reference from DAG nodes.
engine:
model:
tools: []
runtime: none
kind: brain
capability_profile: {"dispatch":{"tools":["mcp__orchestrator","Read","Grep","Glob"],"workspaceAccess":"ro"},"review":{"tools":["mcp__orchestrator","Read","Grep","Glob"],"workspaceAccess":"ro"}}
---

File fallback for the seeded `orchestrator_agent_defs` row `name="brain"`
(kind="brain"). server/brain/brain-capability.ts reads ONLY the
`capability_profile` frontmatter above (via server/agent-loader.ts) to
assemble the brain's per-phase `--allowedTools` face — dispatch and review
are both read-only: mcp__orchestrator + Read/Grep/Glob, never
Bash/Edit/Write. The brain's engine, model, and system prompt are defined in
server/brain/brain-session.ts / brain-prompt.ts, not here.
