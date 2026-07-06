---
"@agent-native/core": patch
---

ACP harness adapter (`acp-adapter.ts`): translate the ACP `usage_update` session
notification (`{ used, size, cost? }` — tokens currently in context, total context
window size, and optional cumulative cost) into an `AgentHarnessEvent` of type
`usage` instead of silently dropping it (it previously fell through the `default:
return []` branch of `acpUpdateToHarnessEvents`). The `usage` event gained two
additive optional fields, `contextUsedTokens` and `contextWindowTokens`, to carry
this running context-fill shape alongside the existing per-call
`inputTokens`/`outputTokens`/`totalTokens`/`costCents` fields. Any app driving
Claude Code (or another ACP agent that emits `usage_update`) through this adapter
can now surface live token/context-window usage instead of it staying frozen.
