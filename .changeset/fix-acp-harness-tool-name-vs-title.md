---
"@agent-native/core": patch
---

ACP harness adapter (`acp-adapter.ts`): `tool-start`/`tool-done` `AgentHarnessEvent`s
now carry the real, canonical tool name (e.g. `Read`, `Glob`, `Bash`) instead of
`@agentclientprotocol/claude-agent-acp`'s own human-readable display `title`/`kind`
(e.g. `"Read File"`, `"Find"`). ACP's wire schema only exposes that display
title/coarse category — never the actual tool — so any consumer that needs the
real name (an allow-list gate, or just consistency with the `ai-sdk` harness
adapter's `toolName`-based `name`) could never recover it. The vendored
`claude-agent-acp` package does stamp the real name onto every
`tool_call`/`tool_call_update` as a `_meta.claudeCode.toolName` extension; the
adapter now reads it (falling back to `title`/`kind` for non-Claude ACP agents
like Gemini CLI, unchanged).

This fixes a real production bug: an orchestrator-template brain turn running
through the gated ACP harness path (`ORCH_BRAIN_HARNESS=1`) denied nearly every
genuinely-allowed `Read`/`Grep`/`Glob` tool call, because its dispatch-phase
tool face compared the mis-shaped display title/kind against the real tool-name
allow-list and never matched — surfacing as dozens of consecutive
`[tool.denied] "Find"` / `[tool.denied] "Read File"` events per turn even though
the model was calling only allowed tools correctly.
