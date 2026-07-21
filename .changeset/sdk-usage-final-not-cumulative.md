---
"@agent-native/core": patch
---

`runAgentLoop`'s streaming `usage` handling now keeps only the LAST usage event
seen per model call instead of summing every chunk. Provider streams report
`usage` cumulatively (Anthropic's `message_delta`, the AI SDK's
`finish.totalUsage`, and OpenAI-compatible `stream_options.include_usage` all
behave this way), so summing each chunk quadratically inflated recorded output
tokens — a real 4-minute spawn on a local 27B model logged ~1.3M output tokens
(~5200 tok/s), which is physically impossible. Any app relying on
`runAgentLoop`'s returned token usage for cost/throughput accounting now gets
the correct final totals, and `inputTokens` is populated instead of staying at
0.
