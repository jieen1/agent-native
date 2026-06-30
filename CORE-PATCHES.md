# Core patches (local fork of `@agent-native/core`)

`packages/core` is upstream-provided. Keep changes here **minimal, additive, and
listed below** so an `upstream/main` merge can re-apply / verify each one. Prefer
template-level solutions (call core's public APIs) over editing core. Only the
entries in this file should diverge from upstream in `packages/core`.

When merging upstream, search each patch's anchor and re-confirm it survived.

---

## 1. Model picker allow-lists a local `vllm` engine

- **File:** `packages/core/src/client/chat-model-groups.ts`
- **Anchor:** `function shouldShowDirectEngine(` — add `if (engine.name === "vllm") return true;`
  just before the `engine.requiredEnvVars?.length === 0` early-return.
- **Change:** surface the `vllm` engine in the model picker even though it
  declares no `requiredEnvVars`.
- **Why:** the chat/orchestrator model picker only shows certain direct engines.
  Upstream now hides any engine whose `requiredEnvVars.length === 0`, and the
  built-ins are otherwise unusable in our self-hosted, bundled, workspace deploy
  — `ai-sdk:openai` / `ai-sdk:google` are filtered out (`packageInstalled === false`,
  because the `@ai-sdk/*` packages are inlined and `require.resolve` can't see
  them) and `anthropic` has no key. So the picker forces a broken engine and
  every send fails with `missing_credentials`. Our templates register a custom
  local engine named **`vllm`** (a local OpenAI-compatible vLLM, key baked from
  env, hence `requiredEnvVars: []`) via core's public `registerAgentEngine` — see
  `templates/chat/server/vllm-engine.ts` and the orchestrator equivalent. This
  one allow-line lets that engine appear and become the default so the composer
  is usable and runs hit vLLM.
- **History:** before the upstream refactor this lived in
  `use-chat-models.ts` as `allowedEngines = new Set([... "vllm"])`; upstream
  extracted the logic into `chat-model-groups.ts`, so the patch moved here.
- **Revert:** remove the `vllm` line from `shouldShowDirectEngine`.

## Pre-existing (not from this work)

- `packages/core/src/server/better-auth-instance.ts` — a Postgres
  `pg_type_typname_nsp_index` 23505 guard around shared-DB table creation. Was
  already modified before this work; left as-is.
