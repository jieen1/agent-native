---
"@agent-native/core": patch
---

MCP server — surface the full result of `readOnly` actions via
`structuredContent` so cross-app / machine MCP callers can read it intact. The
concise `content[].text` rendering truncates results to ~2000 chars (correct for
chat-LLM context, but it silently breaks consumers that parse the text back into
JSON — e.g. an app reading another app's transcript or run state over MCP). For a
`readOnly` action whose result is a plain object and that produces no link/embed
artifacts, the PURGED raw result is now also returned as `structuredContent`.
Model-callable and link-producing tools are unchanged (the embed-ticket security
contract still holds).
