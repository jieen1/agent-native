---
"@agent-native/core": patch
---

Fix workspace MCP server resource loading on Postgres. In
`selectWorkspaceMcpResourceRows`, the `(? IS NOT NULL AND ...)` org/user guards
left their bind parameters used only inside `IS NOT NULL`, so Postgres could not
infer their type and threw `could not determine data type of parameter $N`
(SQLite tolerated it via dynamic typing). The guards now use
`CAST(? AS TEXT) IS NOT NULL`, which is portable across SQLite and Postgres and
gives Postgres an inferable type. Resolves the
`[mcp-client] Failed to load workspace MCP server resources` warning on
Postgres-backed apps.
