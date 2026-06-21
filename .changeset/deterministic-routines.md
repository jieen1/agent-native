---
"@agent-native/core": patch
---

Add deterministic execution mode for routines (jobs + event triggers).

`JobFrontmatter` gains an optional `mode: "agentic" | "deterministic"` (default
`agentic`); `parseJobFrontmatter` parses it and `buildJobContent` always writes
it so a scheduler write-back never silently reverts a deterministic schedule
routine to agentic. `TriggerFrontmatter` already carried `mode`.

The new `@agent-native/core/triggers` exports `runDeterministicStep`,
`parseDeterministicStep`, and `deterministicStepSchema`. `runDeterministicStep`
is a shared, LLM-free executor used by BOTH trigger paths: the cron scheduler
(`jobs/scheduler.ts`) and the event dispatcher (`triggers/dispatcher.ts`). When
`mode === "deterministic"` it runs a single fixed step declared as a fenced
` ```json ` block in the routine body and never starts an agent loop or calls a
model, while still recording a `routine_runs` row (running → success/error):

- `web-request` steps run through the already-wired `web-request` fetch-tool
  entry, so `${keys.NAME}` substitution, SSRF blocking, and per-key URL
  allowlisting are reused unchanged.
- `action` steps call a named, already-registered action with its declared
  `params`, under the routine's run-as identity (the ambient
  `runWithRequestContext`).

The dispatcher's former "deterministic mode not yet implemented" warn-and-skip
stub is replaced by a real `dispatchDeterministic` path that mirrors the agentic
run-as validation, `lastStatus` state machine, and `routine_runs` bookkeeping.
The TOCTOU in-flight guard now wraps both modes, and a deterministic trigger
with no natural-language condition no longer requires an LLM API key to fire.

`deterministicStepSchema` is the single source of truth for a valid single-step
declaration (a discriminated union on `kind`, `.strict()`), so an app's
`save-routine` validates with the exact schema the core executor parses with.
Pure additive: existing agentic schedule/event routines are unchanged.
