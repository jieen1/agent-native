---
"@agent-native/core": patch
---

ACP harness adapter (`acp-adapter.ts`): forward `AgentHarnessCreateSessionOptions.mcpServers`
and `.metadata` (as ACP `_meta`) into both the resume (`loadSession`) and fresh
(`newSession`) handshake calls instead of hardcoding `mcpServers: []`. Previously
any app driving Claude Code (or another ACP agent) through this adapter lost all
MCP tool access — there was no plumbing from the harness options to ACP's
`mcpServers`. Also fixes `AcpHarnessSession.id` to reflect the real ACP session id
once known (it previously stayed pinned to its pre-handshake placeholder forever),
so callers can detect a silently-forced fresh session by comparing `session.id`
against a requested `resumeState.sessionId`.

Also repoints the adapter at the renamed ACP packages: `@zed-industries/agent-client-protocol`
→ `@agentclientprotocol/sdk`, and the `acp:claude-code` preset's
`@zed-industries/claude-code-acp` → `@agentclientprotocol/claude-agent-acp`. The old
package names are deprecated upstream (rename only — API-compatible) in favor of
these.
