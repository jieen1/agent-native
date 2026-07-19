---
"@agent-native/core": patch
---

Fix builtin cross-app MCP tools (`list_apps`, `list_templates`, and any other
action that declares no `tool.parameters`) so their served `inputSchema` is
`{ type: "object", properties: {}, required: [], additionalProperties: false }`
instead of a bare `{ type: "object", properties: {} }`. OpenAI's and
Anthropic's own function-calling validators tolerate the bare form, but
stricter OpenAI-compatible validators (observed: Aliyun/DashScope) reject it
outright with `InvalidParameter: ... must confirm to a valid openai-compatible
JSON schema`, breaking every tool-calling turn that included one of these
tools. Tools that already declare real parameters are unchanged.
