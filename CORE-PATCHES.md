# Core patches (local fork of `@agent-native/core`)

`packages/core` is upstream-provided. Keep changes here **minimal, additive, and
listed below** so an `upstream/main` merge can re-apply / verify each one. Prefer
template-level solutions (call core's public APIs) over editing core. Only the
entries in this file should diverge from upstream in `packages/core`.

When merging upstream, search each patch's anchor and re-confirm it survived.

---

## 1. Model picker allow-lists a local `vllm` engine

- **Files:** `packages/core/src/client/MultiTabAssistantChat.tsx` **(the real
  one — this is what the chat/orchestrator sidebar composer's model-picker
  dropdown actually renders)** and `packages/core/src/client/use-chat-models.ts`
  (a separate, independently-fetched copy of the same list used by other
  surfaces, e.g. the Dispatch homepage hero composer — its own doc comment
  says so). **Both must carry this patch or the fix silently doesn't apply to
  whichever surface you didn't touch.** First pass at this patch only touched
  `use-chat-models.ts`, which is why the composer dropdown kept showing only
  "Claude" / `missing_credentials` even after that file was "fixed" — caught
  via a live Playwright repro against the deployed page days later.
- **Anchor:** `const allowedEngines = new Set([` (the non-builder branch, one
  occurrence per file).
- **Change:** add `"vllm"` to the set, in both files.
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
- **Revert:** remove `"vllm"` from the set, in both files.

## 2. Model picker self-heal must check `configured`, not just model-name presence

- **Files:** `packages/core/src/client/MultiTabAssistantChat.tsx` (module-level
  `resolveModelSelection` — the real one, see patch #1's note on why both
  files matter) and `packages/core/src/client/use-chat-models.ts`.
- **Anchor:** in `MultiTabAssistantChat.tsx`, the `preferredGroup` /
  `fallbackGroup` lookup inside `resolveModelSelection`; in
  `use-chat-models.ts`, the `findDefaultGroup` helper and the `selectedGroup`
  lookup inside `refreshEngines`.
- **Bug (upstream, not vllm-specific):** the picker persists the user's
  engine/model choice to `localStorage` (`agent-native:chat-models:selection`)
  and, on every load, tries to validate that choice is still usable by checking
  only `group.models.includes(selectedModel)` — it never checked
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
  Playwright repro (inject that exact localStorage value, reload, send) both
  before and after this patch.
- **Change:** added a `findDefaultGroup()` helper that prefers a `configured`
  group; the `selectedGroup` "is my persisted choice still good?" check now
  also requires `group.configured`, so an unconfigured match no longer counts
  as valid and the picker properly falls back to the configured default.
- **Upstream-friendly alternative (not taken, to stay minimal):** none needed —
  this is a straightforward correctness fix, upstream-mergeable as-is. Worth
  upstreaming directly rather than tracking indefinitely as a local patch.
- **Revert:** restore the plain `group.models.includes(...)` checks (drops the
  `configured` condition and the `findDefaultGroup` helper).

## 3. db-exec tool schema: drop top-level `oneOf` (Anthropic API rejects it)

- **File:** `packages/core/src/scripts/db/tool-schemas.ts`
- **Anchor:** `dbExecToolParameters()` — the removed
  `oneOf: [{ required: ["sql"] }, { required: ["statements"] }]` line.
- **Why:** the Anthropic Messages API rejects any tool whose `input_schema`
  carries a top-level combinator: `tools.N.custom.input_schema: input_schema
  does not support oneOf, allOf, or anyOf at the top level`. Because the
  orchestrator brain (a Claude Code session) receives the FULL action registry
  as MCP tools, this single schema 400-failed **every** brain turn on dispatch
  (first hit 2026-07-04 during the tracker→brain smoke test). OpenAI-compatible
  engines tolerate it, which is why in-app vLLM chats never tripped.
- **Change:** remove the top-level `oneOf`; the either-`sql`-or-`statements`
  rule remains documented in the field descriptions and is still enforced at
  `run()` time (`exec.ts` fails on both-given and neither-given).
- **Side effect:** `production-agent.spec.ts` / `tool-schemas.spec.ts` cases
  asserting oneOf-based pre-validation will fail upstream-style; acceptable in
  this fork, revisit on upstream merge.
- **Revert:** restore the `oneOf` line.

## Pre-existing (not from this work)

- `packages/core/src/server/better-auth-instance.ts` — a Postgres
  `pg_type_typname_nsp_index` 23505 guard around shared-DB table creation. Was
  already modified before this work; left as-is.
