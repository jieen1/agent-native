---
name: orchestrating-v3
description: >-
  How the in-app chat agent acts as the V3 orchestrator BRAIN: decompose a task
  into a DAG of multi-model worker nodes, run it with workflowRun, monitor it by
  POLLING runState / v3RunEvents, review with runSummary + nodeSummary, then
  commit + open an MR with workspaceCommitPush. Read this before running any task
  on the V3 engine.
---

# Orchestrating on the V3 engine (you are the BRAIN)

You are the **orchestrator brain** — a persistent, resumable Claude Code session
that reaches the orchestrator's actions as MCP tools. The V3 backend is a pure
execution engine: it NEVER decomposes a task, never decides a task is done, and
never pushes work to you. **You** decide how to do the task, watch it by polling,
judge the result, and ship it.

`workflowRun` is **one** of your tools, not a mandate. For a multi-step coding
task the canonical design→develop→review→commit DAG below is the recommended
shape — but a quick task may be a single `spawnOnce`, a scratch `workspaceCreate`
+ inspection, or direct work with no workflow at all. Choose the lightest path
that does the job, then monitor and finish it.

> **A node/spawn with no `workspace` gets an EMPTY, non-git scratch directory —
> not the live monorepo checkout, not any repo at all.** This has caused real
> silent-failure runs: a fact-gathering `spawnOnce` was dispatched with no
> `workspace`, its agent found an empty `/tmp/v3-claude-*` dir with zero files,
> and (with no success guard) still reported "done." Any task that reads,
> greps, or diffs real repo files — including read-only investigation/audit
> spawns, not just code-editing ones — MUST call `workspaceCreate` first and
> pass the resulting `workspaceId` as `workspace` on every node/spawn that
> touches it. Only skip `workspace` for pure-reasoning tasks with no file
> access at all.

> This supersedes the v2 `orchestrating` skill (work-item + `run-start` +
> `transition-work-item`). v2 is retained as legacy. For new task execution use
> the V3 surface below.

## The loop (decompose → run → poll-monitor → review → commit)

```
1. DECOMPOSE  → author a DAG of worker nodes (see "Canonical DAG" below)
2. RUN        → workspaceCreate, then workflowRun({ dag, inputs, tags })
3. MONITOR    → poll runState(runId) + v3RunEvents(runId, since) until terminal
4. REVIEW     → runSummary(runId) + nodeSummary({ runId, nodeId, include:["full_diff"] })
5. COMMIT     → workspaceCommitPush({ workspaceId, message }) → report PR/MR
```

The backend does NOT tell you when to advance. After each step YOU decide the
next action.

## Node types (DESIGN §4)

- `agent` — the only work-doing node. Required fields: `id`, `type:"agent"`,
  `agent` (a `.claude/agents/<name>.md`), `prompt` (a template string).
  Optional: `deps`, `guard`, `workspace`, `output_schema`, `retry`,
  `timeout_seconds`, `engine_override`, `model_override`.
- `parallel_over` — dynamic fan-out over `items_from` (an expression yielding an
  array); each item runs the inline `body` agent with `{{item}}` available.
- `loop` — iterate `body` node ids until `until` is true (or `max_iterations`).
- `human_gate` — pause for approval; resolve with `node.resolve_gate`.

Implicit parallelism: nodes sharing the same `deps` run concurrently — no
`parallel` node needed. Conditional branches: two nodes off the same dep with
opposite `guard` expressions.

## The channel contract (DESIGN §0, §6) — READ THIS

Every spawn (one worker = one fresh context window) sees EXACTLY:
its agent system prompt + the **rendered `prompt` string** + the 6 tools
(Read/Edit/Write/Bash/Glob/Grep) + an optional `/work` workspace. **Nothing
else.** A worker never sees the DAG, other nodes' outputs, or your history.

**Upstream output reaches downstream ONLY through explicit prompt
interpolation that YOU wrote.** The backend never auto-injects deps. If node B
needs node A's plan, write `{{deps.A.output.plan}}` into B's `prompt`. Otherwise
B sees nothing about A.

Interpolation tokens (inside `{{ }}` in a node's `prompt`):

| Token | Means |
|---|---|
| `{{inputs.X}}` | a value from the run's `inputs` |
| `{{deps.NODE.output}}` | upstream node's whole output (string, or JSON-stringified object) |
| `{{deps.NODE.output.field}}` | one field of an upstream node's structured output |
| `{{item}}` | the current item inside a `parallel_over` body |
| `{{iteration}}` | the current 0-indexed loop iteration |

Default node output is a **string** (the worker's final assistant text). For an
**analysis / design / review** node — anything whose worker replies with a
natural-language plan or prose verdict — leave it a string and read its WHOLE
text downstream as `{{deps.NODE.output}}`. Do **NOT** attach `output_schema` to a
prose node: an object schema on a node that returns prose fails the node with
`Output does not match schema: expected object, got string` for no benefit.

Only opt into a **validated object** with `output_schema` (a small JSON-Schema
subset) when a node GENUINELY emits structured JSON; then read its fields
downstream as `{{deps.NODE.output.field}}` and gate on them in a `guard` like
`deps.review.output.verdict == 'pass'`. When in doubt, keep the node a string and
let the downstream worker (or you) read the prose.

## Workers: which agent for which job

**Standing policy: DAG worker nodes must never use `claude-code`.** Every
worker node — analyze/design, develop, review, and any ad-hoc fix/investigate
node you author on the fly (e.g. a one-off `fix_agent`-style node) — uses
`agent: "vllm"`, which routes through the owner's active `runtime_configs` row
(currently Aliyun `qwen3.8-max-preview`) via `RoutingNodeExecutor`. This is a
real decision, not a fallback: `claude-code` is reserved for **you, the
brain**, which is a separate MCP-tool-calling session outside the DAG, never a
DAG node. Do not fall back to `claude-code` for a node just because a `vllm`
attempt failed or looked slow — retry/replan on `vllm` instead (see the brain
patrol guidance for how to judge a stall vs. genuine progress).

| Job | Node `agent` | Runtime / engine |
|---|---|---|
| Analyze / design / review / any ad-hoc fix node (all DAG worker nodes) | `vllm` | routes to the active `runtime_configs` row |

The flow is: **vLLM analyzes → vLLM develops → vLLM reviews → you (the brain)
commit + open the MR.** Map every worker node — analyze, develop, review, and
any fix/cleanup node — to `vllm`.

## Canonical DAG: design → develop → review → commit

A code change with review. `workspaceId` is created first (see "Run" below) and
mounted on every agent node so they share one git checkout. Note how each node
explicitly interpolates ONLY what the next worker needs.

```json
{
  "nodes": [
    {
      "id": "design",
      "type": "agent",
      "agent": "vllm",
      "workspace": "{{inputs.workspaceId}}",
      "prompt": "Repo is checked out at /work on branch {{inputs.baseBranch}}.\nRequirement:\n{{inputs.requirement}}\n\nAnalyze the codebase and produce a concrete implementation plan: which files to touch and the exact change for each. Reply with a clear natural-language plan."
    },
    {
      "id": "develop",
      "type": "agent",
      "agent": "vllm",
      "deps": ["design"],
      "workspace": "{{inputs.workspaceId}}",
      "prompt": "Repo at /work. Implement this plan exactly, editing files in place:\n{{deps.design.output}}\n\nWhen done, run `git --no-pager diff` and reply with a concise summary of what you changed."
    },
    {
      "id": "review",
      "type": "agent",
      "agent": "vllm",
      "deps": ["develop"],
      "workspace": "{{inputs.workspaceId}}",
      "prompt": "Repo at /work. Review the working-tree diff (`git --no-pager diff`) against this requirement:\n{{inputs.requirement}}\n\nDeveloper summary:\n{{deps.develop.output}}\n\nDecide pass or fail and give actionable feedback. Start your reply with a single line 'VERDICT: pass' or 'VERDICT: fail', then the details."
    }
  ]
}

The `design` and `review` nodes return PROSE — no `output_schema`. `develop`
reads the whole plan as `{{deps.design.output}}`, and YOU read the review prose
(its `VERDICT:` line) when deciding to commit. Only add `output_schema` if you
deliberately make a node emit structured JSON.
```

After `review` is `done`, YOU (not a node) read its prose verdict and commit:

```
runSummary(runId)
nodeSummary({ runId, nodeId: "review", include: ["full_diff"] })
// read the review prose; if its VERDICT line says pass:
workspaceCommitPush({ workspaceId, message: "<requirement summary>", pushBranch: "<feature branch>" })
```

If you want the commit gated inside the DAG instead, make the review node emit
structured JSON (give it an `output_schema` with a `verdict` enum — this is the
one place a schema is worth it), then add a deterministic commit node with
`guard: "deps.review.output.verdict == 'pass'"` and a `fix` loop with the
opposite guard. The simplest reliable path is still to read the prose review and
commit from the brain.

## Run

1. `workspaceCreate({ repo, baseRef: baseBranch, ownerKind: "cc", tags })` →
   `{ workspaceId }`. `baseRef` is the base to cut FROM; leave `branch` unset so
   it defaults to a unique per-run name. Do NOT pass `baseBranch` as `branch` —
   that checks the base branch itself out under this app's shared git-worktree
   model, which collides with any other workspace already on it (fails a W1/
   provisioning check with a confusing git-level error instead of a clear one).
   (When launched from the `/launch` page in `auto` mode, the workspace is
   already created for you and its id is in your first message — do NOT create
   a second one.)
2. `workflowRun({ dag, inputs: { requirement, workspaceId, repo, baseBranch }, tags })`
   → `{ runId }`. Pass the SAME `tags` on every call (`workspaceCreate`,
   `workflowRun`, `spawnOnce`) so the activity stream is reassemblable
   (DESIGN §16). Include `orchestrationSessionId` in `tags` when launched from
   `/launch` so the run links back to this chat.

## Monitor — by POLLING (DESIGN §14, §19)

The backend NEVER pushes to you. Poll:

- `runState(runId)` → `{ status, nodeCounts, dagVersion, ... }`. Terminal when
  `status` is `done` / `failed` / `cancelled`.
- `v3RunEvents(runId, since)` → ordered events (`node.ready`, `node.done`,
  `run.completed`, …). Pass the last `seqNum` as `since` to page forward.

Loop: poll → if still running, wait and poll again → stop at terminal. Then
review.

## Review

- `runSummary(runId)` → roll-up (tokens, node outcomes).
- `nodeSummary({ runId, nodeId, include: ["full_diff", "full_log", "schema"] })`
  → one node's output + (optionally) the full workspace diff it produced.
- `workspaceDiff({ workspaceId })` → the raw diff across the whole run.

Read the diff, judge it, and decide: commit, re-run a fix, or patch the DAG.

## Mid-run intervention (DESIGN §8.6)

Patch only the FUTURE. `workflowPatch(runId, expectedDagVersion, ops)` edits
nodes that are still `pending`/`ready` (ahead of the execution frontier).
`running`/`done` nodes are immutable — to change those, `runFork`. "Patch the
future, fork the past."

## Hard rules

- Decompose yourself; the backend never does.
- Pass upstream data ONLY via `{{deps.X.output...}}` you wrote — no auto-inject.
- Monitor by polling; never expect a push.
- Never fabricate a node's output — report only what a real spawn produced.
- The backend never says "done"; YOU judge terminal and decide commit.
- Carry the same `tags` (and `orchestrationSessionId`) on every dispatched op.
