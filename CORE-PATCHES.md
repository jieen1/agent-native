# Core patches (local fork of `@agent-native/core`)

`packages/core` is upstream-provided. Keep changes here **minimal, additive, and
listed below** so an `upstream/main` merge can re-apply / verify each one. Prefer
template-level solutions (call core's public APIs) over editing core. Only the
entries in this file should diverge from upstream in `packages/core`.

When merging upstream, search each patch's anchor and re-confirm it survived.

---

## 1. Model picker allow-lists a local `vllm` engine

- **File:** `packages/core/src/client/use-chat-models.ts`
- **Anchor:** `const allowedEngines = new Set([` (the non-builder branch)
- **Change:** add `"vllm"` to the set.
- **Why:** the chat/orchestrator model picker hard-codes which engines it shows
  (`anthropic`, `ai-sdk:openai`, `ai-sdk:google`). In our self-hosted, bundled,
  workspace deployment those built-ins are unusable — `ai-sdk:openai` /
  `ai-sdk:google` are filtered out (`packageInstalled === false`, because the
  `@ai-sdk/*` packages are inlined and `require.resolve` can't see them) and
  `anthropic` has no key. The picker therefore forces a broken engine and every
  send fails with `missing_credentials`. Our templates register a custom local
  engine named **`vllm`** (a local OpenAI-compatible vLLM, key baked from env)
  via core's public `registerAgentEngine` — see
  `templates/chat/server/vllm-engine.ts` and the orchestrator equivalent. This
  one-line allow-list entry lets that engine appear and become the default so
  the composer is usable and runs hit vLLM.
- **Upstream-friendly alternative (not taken, to stay minimal):** allow any
  engine that is `configured && requiredEnvVars.length === 0 && packageInstalled`.
- **Revert:** remove `"vllm"` from the set.

## Pre-existing (not from this work)

- `packages/core/src/server/better-auth-instance.ts` — a Postgres
  `pg_type_typname_nsp_index` 23505 guard around shared-DB table creation. Was
  already modified before this work; left as-is.
