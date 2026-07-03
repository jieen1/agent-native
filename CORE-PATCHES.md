# Core patches (local fork of `@agent-native/core`)

`packages/core` is upstream-provided. Keep changes here **minimal, additive, and
listed below** so an `upstream/main` merge can re-apply / verify each one. Prefer
template-level solutions (call core's public APIs) over editing core. Only the
entries in this file should diverge from upstream in `packages/core`.

When merging upstream, search each patch's anchor and re-confirm it survived.

---

## 1. Model picker allow-lists a local `vllm` engine

- **File:** `packages/core/src/client/chat-model-groups.ts`
- **Anchor:** `function shouldShowDirectEngine(` — `if (engine.name === "vllm") return true;`
  just before the `engine.requiredEnvVars?.length === 0` early-return.
- **Change:** surface the `vllm` engine in the model picker even though it
  declares no `requiredEnvVars`.
- **Why:** the chat/orchestrator model picker only shows certain direct engines.
  Upstream hides any engine whose `requiredEnvVars.length === 0`, and the
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
- **History:** this logic used to be duplicated inline — once in
  `use-chat-models.ts` as `allowedEngines = new Set([...])`, and *separately*
  in `MultiTabAssistantChat.tsx` (the file the chat/orchestrator sidebar
  composer's dropdown actually renders) with its own copy of the same Set.
  First pass at this patch only touched `use-chat-models.ts`, which is why the
  composer dropdown kept showing only "Claude" / `missing_credentials` even
  after that file was "fixed" — caught via a live Playwright repro against the
  deployed page. Upstream has since unified both call sites onto this single
  `buildChatModelGroups()` / `shouldShowDirectEngine()` pair in
  `chat-model-groups.ts`, so the patch now lives in exactly one place and both
  consumers automatically get it.
- **Revert:** remove the `vllm` line from `shouldShowDirectEngine`.

## 2. Model picker self-heal must check `configured`, not just model-name presence

- **Files:** `packages/core/src/client/MultiTabAssistantChat.tsx` (module-level
  `resolveModelSelection` — `preferredGroup` / `fallbackGroup`) and
  `packages/core/src/client/use-chat-models.ts` (`findDefaultGroup` helper and
  the `selectedGroup` lookup inside `refreshEngines`). Unlike patch #1, this
  logic is **not** unified by `chat-model-groups.ts` — each file independently
  decides whether a *persisted* selection is still valid, so the fix still
  needs to live in both places.
- **Bug (upstream, not vllm-specific):** the picker persists the user's
  engine/model choice to `localStorage` (`agent-native:chat-models:selection`,
  namespaced per app, e.g. `...:selection:chat`) and, on every load, tries to
  validate that choice is still usable by checking only
  `group.models.includes(selectedModel)` — it never checked
  `group.configured`. Several engines share literal model **names**: our local
  `vllm` engine and the built-in `anthropic` engine both list
  `"claude-sonnet-4-6"` (same string, `ANTHROPIC_DEFAULT_MODEL_ID` in
  `model-config.ts`). Once a browser had ever persisted
  `{engine:"anthropic", model:"claude-sonnet-4-6"}` (e.g. from before patch #1
  existed, when the picker forced a broken built-in), the "still valid?" check
  found a matching group by model name alone, decided nothing was wrong, and
  never fell back to the working `vllm` engine — every send kept hitting the
  keyless `anthropic` engine and failing with `missing_credentials` /
  `ECONNRESET`, forever, regardless of any server-side/env fix. Confirmed via a
  Playwright repro (inject that exact localStorage value under the real
  per-app key, reload, send) both before and after this patch.
- **Change:** `preferredGroup` / `fallbackGroup` (and the equivalent
  `findDefaultGroup` in `use-chat-models.ts`) now also require
  `group.configured`, so an unconfigured match no longer counts as valid and
  the picker properly falls back to the configured default.
- **Upstream-friendly alternative (not taken, to stay minimal):** none needed —
  this is a straightforward correctness fix, upstream-mergeable as-is. Worth
  upstreaming directly rather than tracking indefinitely as a local patch.
- **Revert:** restore the plain `group.models.includes(...)` checks (drops the
  `configured` condition and the `findDefaultGroup` helper).

## Pre-existing (not from this work)

- `packages/core/src/server/better-auth-instance.ts` — a Postgres
  `pg_type_typname_nsp_index` 23505 guard around shared-DB table creation. Was
  already modified before this work; left as-is.
