---
"@agent-native/core": patch
---

ai-sdk:openai engine — use Chat Completions (not the Responses API) whenever an
OpenAI-compatible base URL is configured via the `OPENAI_BASE_URL` env, not only
when it is set explicitly on the engine. Many compatible gateways (vLLM, etc.)
do not implement/validate the Responses API, which broke multi-turn tool-use
agent loops against them.
