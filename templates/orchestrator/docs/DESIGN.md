# Orchestrator v2 — Design Document

Status: **design for review.** A **v1.5 slice already ships** in this template
(runtime configs, a Settings → Runtime UI with live Claude Code login detection,
vLLM activation). v1 is the linear-DAG MVP (task → ordered `step_runs`,
chat-delegated execution). This document designs the **v2 graph engine** on top
of what exists: a graph workflow engine with a visual editor, dynamic runtime
expansion (Claude-Code-style), project / work-item management, and the
**load-bearing decision of this revision — every node executes inside its own
disposable microVM (microsandbox), under one unified lifecycle, with the model/
provider pluggable per node**, plus a finished runtime-model configuration.

> **Architecture revision (this version).** The isolation model changed from
> "Docker container per node, code nodes on the framework Claude Code harness" to
> a **unified microVM NodeRunner**: §7 is rewritten end-to-end. Two findings drove
> it (both verified this session): (1) the framework's `@ai-sdk/harness-claude-code`
> (canary.13) is **non-functional** — it requires a `HarnessV1SandboxProvider` the
> framework never supplies and none ships, so `createSession` crashes in
> `_acquireSandbox` (§7.0b); (2) once **every** node already runs in its own
> microVM, the harness's *own* sandbox is a redundant nested layer. The resolution:
> run the **real** Claude Code (`claude --output-format stream-json`) as one
> *executor* inside the node's microVM — not through the broken canary wrapper —
> which also makes the old `cwd`-gap blocker moot.

> **Grounding note.** Every framework API named here was verified against
> `packages/core/src` at `@agent-native/core@0.63.3` and is cited `file:line` in
> §13. Sandbox/microVM facts (§7.0a–b) were verified against the installed
> `@ai-sdk/harness@1.0.0-canary.13` source + the `@ai-sdk/sandbox-*@canary`
> packages + live `/dev/kvm` probing on the dev host. Where v1.5 already implements
> something, the section says so and links the real file. Do not trust the old
> status tables in your memory — trust §11 and §13.

---

## 0. Goals

1. **Visual workflow editor** — build/edit DAGs on a canvas, never hand-write
   JSON. (Today: `workflows.$id.tsx` is a raw JSON `<Textarea>` — the thing this
   replaces.)
2. **Rich control flow** — sequential, parallel, fan-out, join, conditional
   branch, loop/retry, async, and **dynamic** (orchestrator expands the graph at
   runtime, not a fixed shape).
3. **Full control + observability API** — start/pause/resume/cancel/retry, and
   query live state of every node so the orchestrator (and UI) can watch and
   steer execution.
4. **Project & work-item management, queue-driven** — projects with working
   directories; create requirements / bugs / production-issues; **drop them into a
   work queue with a workflow + config, set a concurrency degree, and the
   orchestrator pulls and runs N at a time** (§6.4) — not one-by-one babysitting.
   It decomposes and executes each.
5. **Isolated, repeatable, disposable execution — every node in its own microVM.**
   **Each** node (vLLM / remote-API / claude-code) runs inside its **own
   disposable microVM** (microsandbox, §7), under **one unified lifecycle**:
   provision → mount dirs+creds → init git branch → execute the node's model →
   collect → extract (push / copy out) → destroy. A node that fails is **destroyed
   and re-run cleanly, independently** of every other node. Code work
   commits/pushes to GitHub; non-code work writes deliverables to a local dir.
   **Every node run is journaled so a run resumes without re-spending on completed
   work** — "resume" replays the journal of *completed* NodeRuns, not re-derives
   identical outputs (agent outputs are non-deterministic; §1.7, §14). Resumable
   and repeatable, **not** bit-reproducible.
6. **Runtime config** — pick the engine/model per node; connect local Claude Code
   via harness (subscription); configure local vLLM and other providers. **Most
   of this is already built (v1.5); v2 finishes the per-node picker and the
   vLLM "Test" path.**

---

## 1. Learnings From Claude Code Dynamic Workflows

(Anthropic, 2025–2026. Sources in §15.) This section is expanded from the v1
draft because the engine in §4 must implement these mechanisms faithfully, not
just gesture at them.

### 1.1 Plan-as-script, executed by a background runtime

A dynamic workflow is **a JavaScript file Claude writes and a runtime executes in
the background**, separate from the conversation. The decisive shift: with
sub-agents/skills, *Claude is the orchestrator* and every intermediate result
lands in its context window; with a workflow, **the loop, branching, and
intermediate results live in script variables**, so the model's context only ever
sees the final answer. That is what lets one run coordinate **dozens to hundreds
of agents**.

The script is ordinary deterministic JavaScript (full `JSON`, `Math`, `Array`,
loops, conditionals); **only leaf `agent()` calls consume tokens or spawn model
work.** Module shape:

```js
export const meta = { name, description, phases: [{ title, detail }] } // PURE LITERAL
// body: agent() / parallel() / pipeline() / phase() / log()
```

**Architectural invariant (adopt):** the runtime has **no direct filesystem or
shell access** — only leaf agents touch the world; the script holds control flow
and intermediate state in plain variables. Our engine mirrors this: the
**scheduler** is pure orchestration; only `agent`/`tool` **NodeRuns** perform
side effects.

> **Framework reinforcement (verified).** The agent-native chat agent's *own*
> context is compacted by Observational Memory. Mechanism, exactly: once a
> thread's **unobserved** messages exceed ~30k tokens
> (`AGENT_NATIVE_OM_OBSERVATION_TOKEN_THRESHOLD`, default `30_000` —
> `agent/observational-memory/config.ts:13,56`) the Observer folds that tail into
> a dense dated **observation**; the most-recent **12** raw messages
> (`AGENT_NATIVE_OM_RECENT_RAW_MESSAGE_COUNT`, default `12`) are always kept
> verbatim and **never** folded; a second tier
> (`AGENT_NATIVE_OM_REFLECTION_TOKEN_THRESHOLD`, default `40_000`) condenses
> observations into reflections. The threshold is on the **unobserved tail**, not
> total context. Consequence for us: intermediate run state **must** live in
> NodeRun artifacts (id-addressable), never in the chat transcript, or it is
> silently summarized away. Same lesson as "results live in script variables,"
> enforced by the platform.

### 1.2 Primitives the runtime exposes

| Primitive | Meaning |
|-----------|---------|
| `agent(prompt, opts?)` | spawn one sub-agent in an isolated context; returns final text, or validated structured data if `opts.schema` is set |
| `parallel(thunks)` | **barrier** fan-out — run all, wait for all (see §1.3) |
| `pipeline(items, ...stages)` | **streaming** fan-out — no barrier between stages (see §1.3) |
| `phase(title)` / `log(msg)` | progress grouping + narrator line |
| `args` | global holding the JSON passed at launch (structured, no parsing) |
| `budget` | global token target (or null); used to scale depth/fleet (§1.8) |
| `workflow(nameOrRef, args?)` | compose another workflow inline; **one nesting level only**; child shares the parent's concurrency cap, agent counter, and token budget |

`opts` on `agent()`: `schema` (force structured output, §1.6), `model`, `effort`,
`agentType`, `label`, `phase`, `isolation: "worktree"` (§1.7).

### 1.3 `pipeline()` vs `parallel()` — the load-bearing distinction

This is the subtlest mechanism and the v1 draft omitted it entirely.

- **`parallel(thunks)` is a BARRIER.** Run all thunks concurrently, **wait for
  every one before returning.** The *waiting* is the point. A thrown thunk
  resolves to `null` (the call never rejects) → `.filter(Boolean)`.
- **`pipeline(items, ...stages)` has NO BARRIER between stages.** Each item flows
  through stages on its own clock: **item A can be at stage 3 while item B is
  still at stage 1.** Stage N+1 for item X starts as soon as item X clears stage
  N — no idle gap waiting for the slowest item. Stage signature:
  `(prevResult, originalItem, index)`.

**Rule we adopt for the engine and the editor:** default to pipeline semantics
between dependent nodes; only insert a **`join` barrier** when a node genuinely
needs *all* upstream results at once — full-set dedupe, an aggregate early-exit
("0 found → skip verify"), or a prompt that references "the other findings."
Choosing a barrier when a pipeline would do blocks the whole fleet on the slowest
item at every stage boundary — a real throughput regression. The editor should
make `join` an explicit, deliberate node, not the default wiring.

### 1.4 Concurrency model — split by substrate (do not conflate)

| Substrate | Concurrent | Total / roster | Delegation depth |
|-----------|-----------|----------------|------------------|
| **Claude Code workflow runtime** | up to **16** (fewer on low-core) | **1,000** total (runaway backstop); excess **queues** | n/a (script-driven) |
| **Claude Agent SDK managed-agents** | **25** threads | **20** unique agents in a roster | **1** (deeper ignored) |

Our engine targets the *workflow-runtime* model: a global concurrency cap
(default 8, configurable) + per-`fanout` `maxConcurrency`, with a per-run total
node backstop. Nested `workflow()`-style sub-workflows share the parent's caps.
**Do not present one set of numbers as universal** — the SDK roster model is a
different thing we may later expose for `@app` A2A delegation.

### 1.5 Dynamic expansion + loop catalog

Two layers: a **static shape** (the authored nodes/stages) and **dynamic
expansion** (fan-out width and loop depth computed at runtime from discovered
data). Patterns the engine must support first-class:

- **Fan-out N for N discovered items** — `fanout` whose `itemsFrom` is a
  discovery node's array output.
- **Loop-until-dry** — keep spawning finders until **K consecutive rounds surface
  nothing new**, deduping against everything *seen* (not just everything
  *confirmed*). Strictly stronger than a fixed counter; adapts depth to the
  problem. (Dedupe against `seen`, never against `confirmed`, or judge-rejected
  items reappear forever and the loop never converges.)
- **Loop-until-budget** — gate the loop on `budget.total` (§1.8).
- **Loop-until-condition** — repeat until a stop predicate holds.
- **Routing / classify-and-act** — one `agent({schema})` classifies, a JS
  `switch`/`branch` picks the path.
- **Orchestrator-workers** — discovery agent decomposes → dynamic fan-out →
  synthesis agent merges. Subtasks are *determined at runtime*, not pre-listed.
- **Evaluator-optimizer** — generate → critique → regenerate until convergence.

### 1.6 Sub-agent isolation & structured output

Each `agent()` runs in **fresh, isolated context**; only its **final text or
structured result** returns to the script — never its transcript. Pass **artifact
ids / paths and bounded summaries** between agents, not full dumps.

- **`schema`** forces a **validated structured output via a tool call** — the
  parent gets typed JSON, not prose to re-parse. Our `agent`/`tool` nodes adopt
  an optional `outputSchema`; the engine validates and stores the typed result as
  the node's artifact.
- **Per-agent overrides** (`model`, `effort`) map onto our per-node
  `engine`/`model`/`effort`. `effort` ∈ `low|medium|high` maps to the
  reasoning-effort option `runAgentLoop` already accepts; nodes that omit it
  inherit the run default. (No `assigneeProfile` — `assignee` + `engine` cover
  routing.)

### 1.7 Determinism & resume (NEW — make it an engine invariant)

The runtime **journals every `agent()` call by a deterministic key.** On resume,
agents that already completed **return cached results; the rest run live** (a
cached prefix replays at zero token cost; only the divergent tail re-runs).

This is *why* scripts must be deterministic: **`Date.now()`, `Math.random()`, and
argless `new Date()` throw inside a workflow** — a non-deterministic value would
change the derived key and break cache/resume. Workarounds: **pass timestamps via
`args`**; get variety across agents by **varying prompt/label by index**, not RNG.
Resume is **same-session only** in Claude Code.

**Adopt for our engine:** each `NodeRun` is keyed by `(runId, nodeId, iteration,
fanoutIndex)` and its input + output artifact are persisted. A `run-resume` or
`run-retry-node` replays completed NodeRuns from the journal and only re-executes
`failed`/`pending` nodes. The scheduler must contain **no wall-clock or RNG
branching**; any needed timestamp/seed is an explicit run input.

**Two preconditions the key depends on (state them or the model is fictional):**

1. **The key is stable only over a fully-replayed completed prefix.** A
   `fanout`'s width N comes from a *non-deterministic agent's* array output. If
   the array-producing node itself is the failed/divergent node, re-running it
   yields a different N → `fanoutIndex 0..N'-1` no longer matches the journaled
   `0..N-1`. **Rule: resume reuses a fanout subtree only if its array-producer
   completed and is replayed from journal; if the producer re-runs, its entire
   fanout subtree is invalidated, not partially reused.** Likewise loop depth can
   differ on re-run — `tokens_spent` and the deliverable are *not* reproducible
   (this is the resumable-not-reproducible point, Goal 5 / §14).
2. **Claude-code microVM nodes are atomic and re-run whole.** A claude node's VM is
   disposable (§7.4): a partially-complete claude NodeRun is journaled `failed` and
   **re-run from a clean VM** (destroy + reboot from `baseRef`), never resumed
   mid-turn. `claude`'s own `--resume`/`--continue` is used only for in-VM process
   recovery, never exposed to `run-resume` — one resume layer, not two. (Cross-
   process resume of an in-flight VM is out of scope until the durable run store +
   remote runtime exist — §14, phase 6.)

### 1.8 Budget-aware scaling (NEW)

The runtime exposes a `budget` (token target, or null = unlimited). Pattern:
**scale fleet size and loop depth to the budget** — gate `while`/recursion on
`budget.total`; if a budget exists, stop as it approaches; if not, run to the
agent-cap backstop. Our `run-start` accepts an optional `tokenBudget`; the
scheduler tracks spend per NodeRun (sub-agent usage is already returned as
`AgentLoopUsage`) and refuses to schedule new dynamic nodes once the ceiling is
hit. Surface remaining budget in `run-get`.

### 1.9 Verification / quality patterns (NEW)

For "deliver a PR/artifact" work, a single agent's output is not trustworthy by
default. Support these as reusable sub-graphs:

- **Adversarial refute** — for a candidate finding, spawn N independent skeptics
  *prompted to refute it*; keep only if a majority survives. Prefer **diverse-lens
  judges** (correctness / security / perf / does-it-build) over redundant
  identical ones.
- **Judge panel / tournament** — score N attempts, synthesize the winner +
  best ideas from runners-up.
- **Completeness critic** — a final agent asks "what's missing?" and its output
  seeds the next round.

These map onto `loop` + `parallel` + `branch` nodes; ship at least one as a
bundled template (`code-change-with-review`).

### 1.10 Design consequences

Our workflow is **not** a fixed graph executed verbatim. It is a **graph
template** + a **runtime instance** the orchestrator can grow. The visual editor
edits the template; the run view shows the live instance. Determinism (§1.7) and
pipeline-by-default (§1.3) are hard engine invariants, not style preferences.

---

## 2. Two-Layer Model: Template vs Run Instance

```
WorkflowTemplate (designed in the editor, reusable, versioned)
      │  instantiate for a work item
      ▼
WorkflowRun (live instance the orchestrator executes & mutates)
      │  contains
      ▼
NodeRun[] (one per executed node; dynamic nodes added at runtime,
           each journaled by (runId,nodeId,iteration,fanoutIndex))
```

- **Template** = authored graph (nodes + edges + config). Versioned.
- **Run** = a concrete execution. The engine **adds nodes at runtime** (dynamic
  fan-out / orchestrator-decided steps), recorded as `NodeRun`s with
  `dynamic: true`, so the run view shows what actually happened even when it
  diverges from the template.

> This generalizes v1's `tasks` + `step_runs`: a `task` becomes a `work_item`
> with a `workflow_run`; an ordered `step_run` becomes a graph `node_run`. v1
> rows migrate (see §9).

### 2a. Who orchestrates: Claude Code planner node (brain) + deterministic engine (hands)

"Orchestrator" is **two** components; conflating them breaks the design.

- **Deterministic engine (the hands).** Schedules ready nodes, enforces
  concurrency, journals NodeRuns, advances the DAG, drives the work queue (§6.4).
  **Not a model.** This is what makes runs replayable (§1.7) and the queue
  parallel (§6.4).
- **Orchestrator brain (default: a "planner" node running real Claude Code in its
  own microVM, §7.4).** *Decomposes* a work item into a graph, makes *decision-point*
  calls (`branch`/routing), *adds dynamic nodes* (§6.5), and *intervenes*
  (override/retry) when a node goes wrong. It does **not** hand-run every node. The
  brain is just another node (executor = claude `stream-json`), so it goes through
  the same NodeRunner — "一切皆 node".

**How the brain reads + controls the whole workflow (Q: "harness must fully
understand and operate the workflow and nodes").** The app already exposes its
**entire action surface as MCP tools** at `/_agent-native/mcp`
(`createMCPServerForRequest` + `mountMCP`, auto-wired by `createAgentChatPlugin`).
Connect the orchestrator's Claude Code to it — `agent-native connect
http://localhost:<port>/_agent-native/mcp --client claude-code --full-catalog` —
and the harness can call every control/status action as a native tool:
`run-graph`, `node-get`, `node-override`, `save-template`, `create-work-item`,
`run-start`, `run-pause`, etc. That **is** full read + control of the graph and
every node. Fallback with zero wiring: the harness has Bash, so `pnpm action
<name> --args` (the `run.ts`/`runScript` dispatcher) invokes any action headless
(set `AGENT_USER_EMAIL`/`AGENT_ORG_ID` in its env for correct data scoping).
A2A (`invokeAgent`) is for app-to-app "do the whole thing" delegation, **not** for
calling individual actions.

> **Design rule (do not regress).** The brain steers; it does not babysit. Giving
> the harness *full visibility + control hooks* (via MCP) is correct; making it
> manually execute every node throws away "plan as artifact, not in the model's
> head" (§1.1) — more cost, no replay. Decision points and exceptions go to the
> brain; mechanical scheduling stays in the engine.
>
> **Default-runtime wiring.** `orchestrator-runtime = claude-code` (written by
> `activate-runtime`) selects **claude** as the *brain* executor and the default
> *code-node* executor — both run as real `claude` in their own microVMs (§7.4),
> not the framework harness. Concurrency is bound by host microVM capacity
> (`maxConcurrentVMs`, §4.1/§7.4.7); the brain can run on a cheaper engine (vLLM)
> to save cost.

---

## 3. Workflow Graph Schema

### 3.1 Node types

| Type | Purpose | Control-flow role |
|------|---------|-------------------|
| `start` | Entry | single source |
| `agent` | Run a sub-agent (local or `@app` A2A) with engine/model/prompt | unit of work |
| `tool` | Call a single action directly (no LLM) | deterministic step |
| `parallel` | Container: run children concurrently, **barrier** | fan-out (static N) |
| `fanout` | Run one child template **per item** of an upstream list | fan-out (dynamic N) |
| `join` | Barrier: wait for all incoming, merge results | synchronize (§1.3) |
| `branch` | Evaluate a condition, pick one outgoing edge | conditional |
| `loop` | Repeat a sub-graph until condition / max iters (evaluator-optimizer, retry, loop-until-dry) | cycle (bounded) |
| `subworkflow` | Embed another template | composition |
| `human` | Pause for approval / input (gate) | manual gate |
| `end` | Terminal; collects the deliverable | sink |

### 3.2 Cycles, async, fan-out — how each is expressed

- **Parallel / fan-out:** `parallel` (static children, barrier) and `fanout`
  (dynamic, N = length of an upstream array, capped by `maxConcurrency`). Each
  branch is an independent NodeRun.
- **Pipeline (no barrier):** the default between two dependent `agent`/`tool`
  nodes — the scheduler advances a downstream NodeRun for item X as soon as X's
  upstream NodeRun is done, without waiting for sibling items. A `join` is the
  *only* place a barrier is introduced (§1.3).
- **Async:** every `agent` node runs as a background run; the scheduler never
  blocks — it advances any node whose deps are satisfied. `await: false` =
  fire-and-forget, joined later.
- **Cycles / loops:** expressed **only** through `loop` nodes (sub-graph +
  `condition` + `maxIterations`). The raw edge graph stays a **DAG**; iteration is
  a controlled construct, never a free back-edge. Each iteration's NodeRuns are
  tagged `iteration: n`, and **a loop barriers at the iteration boundary** —
  iteration n+1 cannot start until iteration n's nodes (including any
  `await:false` ones) settle, or convergence checks race.
  - **Loop accumulator state is a journaled artifact** keyed by `(runId,
    loopNodeId, iteration)`; iteration n+1 reads iteration n's accumulator. This
    keeps the scheduler pure (§1.1) while letting loops carry growing state.
  - **Loop-until-dry** config: `dedupeKey` is a JSONPath into each item's output
    that identifies it; the loop accumulates a **`seen`** set of those keys
    (dedupe against `seen`, never `confirmed`, §1.5) in the accumulator artifact;
    `dryRounds` = stop after that many consecutive rounds adding nothing new.
- **Branch:** `branch` holds a safe condition (§3.5) or an `agent` that returns a
  routing decision; the engine activates the chosen edge only.

### 3.3 Edge

```
Edge { id, from: nodeId, to: nodeId, when?: Condition }
```
`when` lets `branch` gate an edge. Absent = unconditional.

### 3.4 Node config (shared)

```
Node {
  id, type, title,
  // agent/tool nodes:
  assignee?: "local" | "@app",        // local sub-agent or A2A delegate
  action?: string,                    // for tool nodes
  engine?: string, model?: string,    // per-node routing
  effort?: "low"|"medium"|"high",     // reasoning-effort hint (§1.6)
  prompt?: string,                    // template with {{deps.<id>.output}} refs
  outputSchema?: JSONSchema,          // force structured output (§1.6)
  // containers:
  children?: nodeId[],                // parallel/loop/subworkflow body
  // fanout:
  itemsFrom?: nodeId, maxConcurrency?: number,
  // loop:
  condition?: Condition, maxIterations?: number,
  dedupeKey?: string, dryRounds?: number,   // loop-until-dry
  // execution:
  await?: boolean, retry?: { max, backoffMs }, timeoutMs?: number,
  runtime?: NodeRuntimeSpec           // per-node virtual env: kind/baseRef/branch/
                                      // mounts/creds/onFailure — full spec in §7.4.3
}
```

### 3.5 Condition (no arbitrary code execution in the engine)

A small, safe expression evaluated against run state — **not** `eval`:
- `{ kind: "jsonpath", path, op, value }` (e.g. `deps.review.output.score >= 8`)
- `{ kind: "status", node, equals: "done" }`
- `{ kind: "agent", prompt }` → an `agent` returns `{ decision: "yes|no|<edge>" }`

Keeps the engine deterministic and safe (§1.7); the only "thinking" is an explicit
`agent` condition.

### 3.6 Serialization

Template stored as JSON in SQL (`workflow_templates.graph`). The **canvas is the
authoring surface**; JSON is the storage format and the agent-editable format
(the agent patches a template via `save-template`). YAML export/import is a
convenience, not the primary path.

### 3.7 Reusable node library (fixed / pre-built nodes)

Node *types* (§3.1) are primitives; a **node library** is a catalog of
*pre-configured, named, reusable* nodes you define once and drop into any
workflow — the answer to "I want to define specific review / commit-push /
open-MR nodes." Stored in a `node_defs` table (`id, key, kind, title, config(JSON),
ownable`) and referenced from a graph by `nodeDefKey` (the node inherits the
library config, overridable per-use).

Two flavors:

- **Deterministic `tool` nodes** (no LLM, fixed behavior) — wrap one action:
  `run-tests`, `lint`, `git-commit`, `git-push`, `open-pr` / `open-mr`,
  `apply-patch`, **`finalize-status`** (asserts the agent set a sensible business
  `status` before `end`; **auto-injected by decomposition if absent** — the status
  guarantee of §6.2b, layer 1). Inputs come from `{{deps.*}}`; output is the action
  result. These are the "fixed pipeline steps" — same every run, fully auditable.
- **Parameterized `agent` nodes** (fixed prompt + `outputSchema`) — a locked-down
  review/analysis step: `code-review`, `security-review`, `secret-scan`,
  `pr-description`. The library pins the prompt, model, effort, and the structured
  verdict shape so every use behaves identically.

Authoring: the editor palette has a **"Library" tab** (drag a `code-review` or
`git-push` node onto the canvas); the orchestrator brain references library nodes
by `key` when it builds a graph (so a dynamically-authored bug-fix DAG ends with
the *same* vetted `run-tests → git-commit → open-pr` tail every time). A
template-supplied **starter library** ships the common code nodes; users add their
own. Library nodes carry their own `version` so a workflow can pin a known-good
review step.

> Why a library, not just inline nodes: it makes the **trust boundary** explicit.
> The dynamic/LLM-authored part of a graph is the *middle* (analysis, fixes); the
> *gates* (review, tests, push, MR) are fixed library nodes the agent composes but
> cannot silently reshape. This is how "let Claude build the workflow" (§6.5) stays
> safe — it wires together vetted nodes, it doesn't reinvent the push step.

---

## 4. Execution Engine

### 4.1 Scheduler (event-driven, async, deterministic)

State machine per NodeRun: `pending → ready → running → (done | failed | skipped)`.

```
loop:
  ready = nodes whose deps are all done AND whose inbound `when` holds
  for node in ready (up to global concurrency cap, minus running):
     start NodeRun (async)              // §4.2 picks the mechanism
  on NodeRun finish:
     persist output as an artifact (id), mark done/failed, record usage
     expand dynamics (fanout → child NodeRuns, one per item)
     re-evaluate loop conditions; if loop continues, clone body NodeRuns (iter+1)
     advance branch edges; release downstream pipeline nodes (no barrier)
  until no ready nodes and none running
  → set run status done/failed; end node collects the deliverable
  → STATUS WATCHDOG (§6.2b layer 2): if business `status` did not change during
    this run (per work_item_status_log), set work_item.statusStale = true
```

- **No wall-clock / RNG in scheduling** (§1.7). Any timestamp/seed is a run input.
- **Dynamic expansion** happens on NodeRun finish (fanout from a produced array).
- **Concurrency — substrate-aware (do NOT use one cap; §1.4).** The scheduler
  must build its own semaphores — **the framework has no global run cap, only a
  per-thread mutex (`tryClaimRunSlot`), so this is build-not-configure.** Split:
  `maxConcurrentModelCalls` (default 8, for `local` `runAgentLoop` + `tool` that
  need no VM), `maxConcurrentVMs` (sized to the KVM host's CPU/mem — **each node is
  one microVM**, §7.4.7), plus per-`fanout` `maxConcurrency` and a per-run
  total-node backstop. VM-provision/resource-exhaustion failures are surfaced
  distinctly, not folded into token budget.
- **Budget:** stop scheduling new *dynamic* nodes when `tokenBudget` is exhausted
  (§1.8). **Caveat:** only `local`/`tool` spend is counted; `@app` A2A returns no
  usage, so a mostly-`@app` workflow never self-limits (§14).
- **Termination:** acyclic base graph + bounded loops ⇒ guaranteed to finish.

### 4.1a Item correlation — the load-bearing rule pipeline/fanout/join depend on

The pipeline-by-default claim (§1.3) is only meaningful with explicit per-item
identity. This is a hard engine spec, not a detail:

- **NodeRun identity is `(nodeId, iteration, fanoutIndex)`** — the same key the
  journal uses (§1.7).
- **Inside a `fanout` scope, template edges are index-preserving.** Edge `A→B`
  under a fanout of width N means `B_i depends on A_i` (N independent chains),
  **not** "B waits for all A". This is what makes pipeline flow: `B_i` starts the
  moment `A_i` is done, regardless of siblings.
- **A `join`'s expected cardinality is sealed when its nearest upstream fanout's
  item array materializes** (when the array-producing NodeRun finishes). Before
  that, `join` is not ready; after, it waits for exactly N incoming. This prevents
  a join firing early (3 of an eventual 10) or deadlocking (waiting for an 11th).
- **Mid-pipeline item failure drops that item, siblings continue** (`.filter
  (Boolean)`, §1.3). A failed `B_i` removes item i from the downstream join's
  expected set; it does not fail the whole run unless a node is marked
  `failFast`.
- **`run-step` is dropped as infeasible-as-described** — a detached `startRun`
  background model isn't single-steppable. Debugging uses pause + inspect, not a
  tick.

### 4.2 Where work actually runs (grounded APIs — see §13)

| Node assignee | Mechanism (real framework API) |
|---------------|-------------------------------|
| `local` agent | server-side background run: `startRun(runId, threadId, runFn)` → inside `runFn`, `resolveEngine({ engineOption, model })` then `runAgentLoop({ engine, model, systemPrompt, tools, messages, send, signal, … })`. **This already works headless** — `jobs/scheduler.ts` does exactly this; copy that pattern. |
| `@app` A2A | `invokeAgent({ target, prompt, … })` from `@agent-native/core` (a2a) |
| `tool` | direct action call (the action's `run`) |
| code execution (any provider) | **`NodeRunner` over a microVM** (§7.4): provision microsandbox → mount repo+creds → checkout branch → **EXECUTE via the node's executor** → commit/push → destroy. The executor is `runAgentLoop` (vLLM/cloud, tools = `createCodingToolRegistry` re-pointed at `vm.exec`) or the **real `claude --output-format stream-json`** in-VM for a claude node. **Not** the framework `@ai-sdk/harness-claude-code` (non-functional, §7.0b). For trusted JS snippets only: `coding-tools/run-code.ts`. |

The orchestrator agent is **not** required to babysit every node — the scheduler
schedules nodes and delegates only the *thinking* steps to agents (§1.1). This is
the key upgrade over v1, where `run-orchestrator` merely seeds rows and **returns
an instruction string that the UI (`tasks.$id.tsx`) hands to the chat agent via
`sendToAgentChat`** to walk by hand.

> **Build note.** The headless engine must run inside a request context.
> `jobs/scheduler.ts` wraps execution in `runWithRequestContext(...)` so
> `resolveEngine`, ownable scoping, and secrets resolve correctly. The v2 engine
> runs as a server plugin / job, not in a route handler.

**Three `startRun` mechanics that are landmines if missed (verified against
`run-manager.ts` / `production-agent.ts`):**

1. **One `threadId` + one unique `runId` per concurrent NodeRun — mandatory.**
   `startRun` keys an in-memory `threadToRun` map by `threadId` and **aborts any
   existing run for that thread** (`run-manager.ts:222-226`); `activeRuns` is keyed
   by `runId` (`:241`). Fan out 8 ready nodes under one shared thread and 7 are
   silently aborted. Do one `createThread` per NodeRun (as `jobs/scheduler.ts`
   does one per job), with a unique `runId` (`an-<runId>-<nodeId>-<iter>-<idx>`).
2. **Re-establish request context inside each NodeRun, don't inherit it.** The
   detached background loop is outside the triggering request's
   AsyncLocalStorage frame; wrap each node in its own
   `runWithRequestContext({ userEmail, orgId }, …)` or `getRequestUserEmail()`
   returns `undefined` and scoped reads/writes (and `resolveSecret`, needed for
   the vLLM `OPENAI_API_KEY` gate, §8.5) break.
3. **Capture `AgentLoopUsage` inside `runFn`.** `startRun` only awaits
   `runFn`'s `Promise<void>` — the per-node token counts `runAgentLoop` returns are
   **dropped** unless you close over them in `runFn`. Required for
   `node_runs.tokens_spent` / the §1.8 budget. (`@app` A2A returns no usage at all
   — §14.)

### 4.3 Control API (actions)

| Action | Effect |
|--------|--------|
| `run-start(workItemId, { tokenBudget? })` | instantiate template → WorkflowRun, schedule |
| `run-pause(runId)` | stop scheduling new nodes; let running finish |
| `run-resume(runId)` | replay journaled NodeRuns, schedule the rest (§1.7) |
| `run-cancel(runId)` | `abortRun` running NodeRuns, skip pending |
| `run-retry-node(runId, nodeRunId)` | reset a failed node to `ready`, re-run live |
| `node-override(runId, nodeRunId, patch)` | edit a node's prompt/model and re-run |

**Abort is cooperative, not immediate.** `run-cancel` calls `abortRun(runId)`,
which fires each NodeRun's `AbortController`; the engine-model loop checks
`signal.aborted` **at loop boundaries**, and the in-VM `claude` process breaks
**between turn events** — so a code node mid-edit keeps running until its current
step yields. Treat cancel as "stop scheduling + best-effort interrupt"; the
microVM **teardown waits for the in-VM process to actually exit** (§7.1a), and any
half-done branch is simply never pushed. State this in the UI so users aren't
surprised.

### 4.4 Observability API (status queries)

| Action | Returns |
|--------|---------|
| `run-get(runId)` | run status, counts, deliverable, timing, budget remaining |
| `run-graph(runId)` | live graph: every NodeRun (status/iteration/dynamic flag) + edges, for the canvas overlay |
| `node-get(runId, nodeRunId)` | one node: input, output artifact, logs, sub-agent runId, model, timings |
| `run-events(runId, sinceSeq)` | streamed events bridged from `subscribeToRun(runId, fromSeq)` |

Live updates ride the existing `useDbSync()` + the run-event stream so the canvas
animates node state in real time.

---

## 5. Frontend & Interaction Design

> **The complete frontend/interaction spec is [FRONTEND.md](./FRONTEND.md)** —
> page inventory (9 surfaces), per-page layout, every data element + its source
> action, **every button + its exact click logic**, the dialog catalog (D1–D5,D7–D9), the
> per-page hook/action parity map, and cross-cutting interaction patterns. This
> section keeps only the DAG-editor specifics.

### 5.0 The DAG editor (page 6 in FRONTEND.md)

**Library:** React Flow (`@xyflow/react`) — **currently absent from
`package.json`; add it** (verify latest version at build time with
`pnpm view @xyflow/react version`). It replaces the raw JSON `<Textarea>` in
`workflows.$id.tsx`.

### 5.1 Surfaces

- **Canvas** — nodes as cards (type icon, title, engine/model badge); edges with
  `when` labels; drag to connect; container nodes (parallel/loop/fanout) render
  as groups.
- **Palette** — drag node types onto the canvas.
- **Inspector** — right panel to edit the selected node (title, assignee,
  engine/model picker, effort, prompt with `{{deps.*}}` autocompletion, condition
  builder, retry/timeout, `outputSchema`).
- **Validation** — live: acyclic base graph, `fanout.itemsFrom` resolves, `loop`
  has condition+maxIterations, `branch` edges have `when`, single start/end, and
  a **lint that flags an implicit barrier** where a `join` may be unintended
  (§1.3).
- **Run overlay** — same canvas tints nodes by status, shows iteration counters
  and dynamically-added fanout children, and opens a NodeRun's output on click.

### 5.2 Why keep JSON

JSON stays as storage + the agent-editable format (`save-template`). Humans use
the canvas. Both edit the same model. The JSON-textarea editor is a fallback for
power users, not the primary path.

---

## 6. Projects & Work Items

### 6.1 Project

A project is what a real issue tracker means by one: a named container for work
items, with its own board and id prefix. **It has no "type" you pick.** The same
project can hold a bug that ships a PR and a doc task that writes a file — **what a
work item delivers is decided by its workflow's `end` node (§7.3), not a project
kind.** A project optionally **links a git repo**; that's the only thing that
distinguishes "can do code work" from "can't", and it's a link, not a category.

```
Project {
  id, name,
  key,                         // id prefix for work items, e.g. "PAY" → PAY-14
  description?,
  workingDir,                  // deliverable/artifact root — ALWAYS set (top-level,
                               //   independent of repo; the §7.2 delivery target)
  repo?: { gitRemote, defaultBranch },  // set ONLY if work touches code
  environments?,               // env list (default dev/SIT/UAT/prod), §6.2a
  defaultWorkflowId?,          // workflow used to decompose an assigned work item
  ...ownableColumns()          // owner-scoped (sharing UI deferred, §12)
}
```

- **Has a `repo`** → code work items check that repo out inside each node's microVM
  (§7.1) and deliver a PR.
- **No `repo`** → still a full project for docs/decks/research; those workflows
  write file deliverables into `workingDir` via the `local-artifacts` module
  (`workingDir` exists for *every* project, so the §7.2 delivery target is never
  null). No "docs project" type exists — it's just a workflow whose `end` node
  produces files.

### 6.2 Work item (the thing you create and assign)

```
WorkItem {
  id, projectId,
  type: "requirement" | "bug" | "prod-issue" | "task",
  title, description, priority, assignee?,
  // ── business status (PM, §6.2a/§6.2b) — what the board shows; only writer is transition-work-item ──
  status,                       // pipeline stage, per-type configurable set
  statusCategory,               // todo|in-progress|completed|cancelled (= the stage's `category` in the scheme)
  environment?,                 // dev|SIT|UAT|prod (project.environments) — orthogonal to stage
  severity?,                    // SEV1..SEV4 (prod-issue)
  blocked, blockedReason?, blockedBy?,   // flag + optional link to the blocking item
  resolution?,                  // completed/cancelled: shipped|cancelled|rejected|duplicate|cannot-reproduce|rolled-back|deferred
  statusStale?,                 // watchdog (§6.2b): run finished but agent didn't update status
  // ── automation overlay (§6.4) — is an orchestrator run active right now ──
  execState,                    // idle|queued|claimed|running|paused|failed|done
  claimedAt?, claimedBy?,       // back the atomic single-flight queue claim
  workflowId?,                  // optional pre-picked template; blank → §6.3 resolves
  workflowRunId?,               // the latest run
  deliverable?: { kind, ref },  // PR url / commit / file paths
  ...ownableColumns()
}
```

Lifecycle:
```
create work item → assign to orchestrator
  → orchestrator decomposes into a WorkflowRun (dynamic DAG)
  → engine executes nodes in the project's isolated env
  → deliverable produced (PR pushed / files written)
  → work item → done, deliverable linked
```

> **The project-management ask lands here.** A `work_item` is the
> requirement/bug/incident/task. **Status management is the business `status`
> (§6.2a)** — a real per-type pipeline a human manages and the AI advances. "AI
> assists" = assigning it to the orchestrator, whose agent updates the status via
> `transition-work-item` (§6.2b). The board is a kanban grouped by `status` /
> `statusCategory`.

### 6.2a Work-item status model (the PM core — six orthogonal dimensions)

`status` ≠ `execState`. Conflating them deletes the PM tool. Status meaning is
carried by **six orthogonal dimensions**:

| Dimension | Field | Values | Managed by |
|-----------|-------|--------|-----------|
| Stage category | `statusCategory` | `todo` · `in-progress` · `completed` · `cancelled` — **completed ≠ cancelled** so throughput reporting separates shipped from killed (the Linear fix Jira lacks) | derived from `status` |
| Pipeline stage | `status` | per-type ordered set (below), **configurable per project** | human (drag) + agent (`transition-work-item`, §6.2b) |
| Environment | `environment` | nullable, from `project.environments` (default `dev · SIT · UAT · prod`) — **where** a test/release stage runs; **orthogonal**, NOT baked into stage names | set with the stage by `transition-work-item` |
| Blocked | `blocked` + `blockedReason` + `blockedBy?` | flag overlaying any in-progress stage; `blockedBy` optionally links the blocking item (auto-suggest unblock when it closes) | human / agent on external dep |
| Resolution | `resolution` | `shipped` · `cancelled` · `rejected` · `duplicate` · `cannot-reproduce` · `rolled-back` · `deferred` | **required** on entering a completed/cancelled stage |
| Severity | `severity` | `SEV1 · SEV2 · SEV3 · SEV4`, nullable (used by `prod-issue`) | human / agent at triage |

**Default per-type pipelines** — stages are **environment-agnostic** (env is the
separate `environment` field, so "测试中 @ SIT", "验收中 @ UAT", "已上线 @ prod"):

| type | todo | in-progress | completed | cancelled |
|------|------|-------------|-----------|-----------|
| **requirement** | 待分析 · 待开发 | 开发中 · 待评审 · 评审中 · 待提测 · 测试中 · 待验收 · 验收中 · 待发布 | 已上线 | 已取消 · 已拒绝 |
| **bug** | 待确认 · 待修复 | 修复中 · 待评审 · 评审中 · 待提测 · 测试中 · 待验收 · 验收中 · 待发布 | 已关闭 | 已取消 · 不予处理 |
| **prod-issue** | 已触发 | 止血中 · 已恢复 · 复盘中 · 根因修复中 · 修复验证中 · 灰度发布中 · 待发布 | 已关闭 | 已取消 |
| **task** | 待办 | 进行中 · 待评审 · 待测试 · 测试中 · 待验收 | 已完成 | 已取消 |

**Transition rules (buildable, not prose — this is the validator spec):**
- **Forward = skip-forward allowed.** Any move to a *later* in-progress/completed
  stage in the type's order is legal (so `finalize-status` can jump 开发中→待发布
  in one call; the agent need not walk every intermediate stage). The validator
  rule = "to-stage index > from-stage index, same type, not crossing into
  cancelled" — no per-pair enumeration needed for forward.
- **Rework (back-edge)** = an explicit `transitions[]` entry with `kind:"rework"`;
  default rework target = **the type's first in-progress stage** (bug/requirement →
  修复中/开发中) from 评审中/测试中/验收中. Back-moves not listed are illegal.
- **Reopen** (from a completed/cancelled stage) → a type-specific re-entry stage —
  bug→待修复, requirement→待开发, task→待办, prod-issue→复盘中 — and **clears
  `resolution`** (the classic "Done-but-resolved" defect; reopen must null it).
- **Cancel** = any non-terminal stage → the type's `已取消` stage,
  `resolution=cancelled` (≠ `execState` cancel, which only aborts the live AI run).
- **Rollback** (prod-issue) = → 已关闭 with `resolution=rolled-back`.

**Resolution allowed per terminal stage** (`resolutionsAt`, complete per type — not
samples): 已上线→`shipped`; 已关闭(bug)→`shipped`·`cannot-reproduce`·`duplicate`·`rolled-back`;
**已关闭(prod-issue)→`shipped`·`rolled-back`**; 已取消→`cancelled`·`deferred`;
已拒绝/不予处理→`rejected`·`duplicate`. **Entering any completed/cancelled stage
requires a resolution from its set** (enforced by `transition-work-item`).
`resolution=duplicate` requires a `duplicate-of` link (§9 `work_item_links`).
`resolution=deferred` is a **soft-cancel** (parked, reopenable) and is **excluded
from the "killed" throughput metric** even though it sits in the cancelled category.

**Status-set storage.** Each type's scheme is JSON:
`{ version, stages:[{key,label,category,terminal?,deprecated?}], transitions:[{from,to,kind:"rework"|"cancel"|"reopen"}], resolutionsAt:{<terminalStage>:[resolution…]} }`
(forward edges are implicit by stage order, §above; only rework/cancel/reopen are
listed). Defaulted from the template, **overridable per project**
(`projects.status_schemes`, §9). Bumping `version` + marking a removed stage
`deprecated` (never deleting it) is how a scheme evolves without stranding a live
item holding that stage.

**The agent updates business `status` — it is NOT auto-fired by the engine.** The
running node's agent calls `transition-work-item` at its own judgement points,
because only the agent knows when it actually hit a blocker, a rework, or produced
a deliverable. Typical points (the `orchestrating` skill mandates these; node
prompts remind them):

| moment in the run | the agent calls |
|-------------------|-----------------|
| starts real work | → 开发中 / 修复中 |
| hits an external blocker mid-run | `transition-work-item({blocked:true, reason})` |
| its own tests + review pass (it judges) | → 待验收 / 待发布 |
| delivers the PR / artifact | → the near-terminal stage |

`execState` (queued/running/failed) is the engine's automation state and **never
overwrites business `status`**; a human can also drag a card manually. **Why
agent-driven, not engine-auto:** a declarative "node X → status Y" rule is rigid —
it cannot represent "mid-run I decided to block / rework / the judge says not
ready." The agent decides; §6.2b guarantees it doesn't forget.

### 6.2b Who writes business status, and how it's guaranteed to get set

**Single writer.** `transition-work-item(itemId, toStatus, {environment?,
resolution?, blocked?, reason?, severity?})` (§10) is the **only** writer of
`status`/`environment`/`blocked`/`resolution`/`severity`. It validates `from→to`
against the project status scheme, derives `statusCategory`, **enforces "entering a
completed/cancelled stage requires a `resolution` from that stage's `resolutionsAt`
set"** and **clears `resolution` on reopen**. Both the agent (via MCP) and the
human (board drag) call it — same gate, no back door; `update-work-item` rejects a
`status` field.

**The agent owns the writes (flexible).** Per §6.2a the running node's agent calls
it at its judgement points — handling what an auto-rule can't: blocking mid-run,
rework, a judge deciding "not ready."

**Three layers guarantee the agent never silently forgets:**

1. **Required `finalize-status` gate (structural).** Every delivery workflow ends,
   right before `end`, with a `finalize-status` library node (§3.7).
   Decomposition/validation **auto-injects** it if a graph lacks it — the brain
   cannot omit it, exactly like the `git-push` gate. It forces the agent to set a
   sensible terminal/near-terminal `status` before the run can succeed; if unset,
   the node is `failed`.
2. **Reconciliation watchdog (engine — the hard guarantee).** When a run reaches a
   terminal `execState` (`done`/`failed`), the engine checks the status activity
   log (§9 `work_item_status_log`): did business `status` change during this run?
   If **not**, it sets `work_item.statusStale = true` and surfaces a board badge
   **"AI finished — status not updated, confirm."** A finished run can **never**
   silently leave `status` stale — it is either updated by the agent or flagged for
   the human (one-click confirm the engine's suggested status, or re-prompt the
   orchestrator to set it). This is the actual guarantee, not "the skill says so."
3. **Blocked fallback (mid-run).** When the agent calls
   `transition-work-item({blocked:true, reason})`, the run may pause
   (`execState→paused`); the human sees the 阻塞 badge + reason, intervenes, and
   re-runs when unblocked.

Every `transition-work-item` call (agent or human) appends to
`work_item_status_log` (actor, from→to, ts, runId) — the trail that answers "why is
this 已上线 / did the AI skip a gate," and the data the watchdog reconciles against.

**Terminal closure (PR merge / prod deploy).** The agent's last write is the
**near-terminal** stage (`待发布`) when it opens the PR / produces the artifact — it
does **not** mark `已上线`/`已关闭`, because shipping is an event that happens *after*
the run (PR merged, deployed to prod). The terminal move is made by **either** a
human (board "Mark shipped" → `transition-work-item(→已上线, resolution:shipped)`)
**or** an optional **PR-merge / deploy webhook** (the framework `integration-webhooks`
skill) that calls `transition-work-item` on the merge event. So an item rests at
`待发布` by design, not by accident — and the board surfaces "delivered, awaiting
merge" rather than stranding it silently.

### 6.3 Decomposition

When a work item is assigned, where its DAG comes from is **resolved in this
order** (a work item may carry an optional `workflowId`):

1. **Explicit `workflowId`** — the user picked a template at creation (D1) → use it.
2. **Project `defaultWorkflowId`** — no pick but the project has a default → use it.
3. **Dynamic build** — neither set → the orchestrator brain (§2a) **dynamically
   builds** a DAG from the item's description (bug: reproduce → locate → fix → test
   → commit/push; deck: outline → draft → review → export), wiring vetted library
   nodes for the gates (§3.7).

So picking a template and letting the brain auto-build are **both** first-class —
template optional, dynamic when blank. Either way, decomposition writes a
`WorkflowRun` and the engine takes over.

### 6.4 Work queue & cross-task concurrency (the primary usage model)

**This is how the system is actually used: a queue you feed, not tasks you
babysit.** You drop many work items into a queue (each tagged with a workflow +
config); the orchestrator **pulls and runs them, N at a time**, at a concurrency
degree you set. No per-task hand-holding.

**The queue uses `execState`, NOT business `status` (§6.2a) — do not conflate.**
Feeding the orchestrator is an *automation* concern; it must never touch the PM
pipeline. So the queue/worker operates on a separate `work_item.execState`:

`execState`: `idle → queued → claimed → running → done | failed`, plus `paused`,
`cancelled`. (`workflow_run.status` is the per-run detail under it; the Run console
shows that.)

| execState | meaning | board signal |
|-----------|---------|--------------|
| `idle` | no AI run active (default) | no badge |
| `queued` | enqueued to the orchestrator, waiting for a worker slot (priority-ordered) | "queued" badge |
| `claimed` | a worker atomically grabbed it, run starting — **transient, sub-second** | folded into "running" |
| `running` | its `workflow_run` is executing | pulsing "AI running" badge |
| `paused` | run paused | "paused" badge |
| `done` | the latest run finished (its outcome advanced business `status`, §6.2a) | no badge |
| `failed` | run failed after retries | "failed" badge |
| `cancelled` | AI run cancelled (business `status` unchanged) | no badge |

- The **board groups by business `status`** (§6.2a); `execState` is a **badge** on
  the card, plus an optional separate "Queue" view grouped by `execState` for
  watching the AI fleet. `enqueue-work-item` sets `execState: idle→queued` and
  **does not change business `status`**.
- Business `status` is moved by the run's **agent** calling `transition-work-item`
  (§6.2b), guarded by the watchdog — not by `execState`. **Re-running** a
  `done`/`failed` item = a new `workflow_run`, `execState` back to `running`;
  business `status` only moves if the agent updates it. `dequeue-work-item` sets
  `execState` back to `idle`.

```
enqueue work items (workflowId + config + priority)   ← you, in bulk
        │
        ▼
worker pool (size = concurrencyDegree, a runtime config)
  each worker loop:
    atomically claim next item  (UPDATE…SET exec_state='claimed',claimed_by=me
                                 WHERE exec_state='queued' [ORDER BY priority LIMIT 1];
                                 if affected_rows>0 → SELECT the claimed row)
    → run-start(item)  → engine executes its DAG
    → on finish: set exec_state done/failed, claim next
        │
        ▼
N items run concurrently; you watch the board, not a single run
```

**Built on existing primitives (no framework queue exists — verified):**
- **Atomic claim** — copy the proven `claimA2ATaskForProcessing` pattern
  (`a2a/task-store.ts:147-172`, used at `a2a/handlers.ts:128`): **`UPDATE … WHERE
  exec_state='queued'` → check affected-row count → separate `SELECT`** (NOT
  `RETURNING` — the framework portability rule forbids `RETURNING` in shared app
  code, `portability/SKILL.md:76`; the cited primitive uses the affected-rows+SELECT
  form). Single-flight so one item is never double-run; the stuck-item reclaim
  (re-`queued` if a worker dies) is already modeled there.
- **Worker pool** — `Promise.all(Array.from({length: N}, worker))` (the pattern at
  `cli/workspace-dev.ts:1259`); each `worker()` claims → `run-start` → repeat.
- **`concurrencyDegree` = a `save-runtime-config` value** (Settings → Runtime), so
  you tune it without code.
- **Durable driver** — the pool loop lives in one place (a server-plugin tick, like
  `jobs/scheduler.ts`'s 60s loop); SQL heartbeat/reap recovers stranded `running`
  items after a crash/redeploy (§14). On serverless, pump from the cron tick /
  self-dispatch rather than a long-lived in-memory loop.

**⚠ Two concurrency ceilings to expose, not hide:**
1. **Task-level** = `concurrencyDegree` (how many work items run at once).
2. **Within a run** = node concurrency (§4.1) and the **microVM capacity cap**
   (§7.4.7: each running node = one microVM; total bounded by the KVM host's
   CPU/mem/disk = `maxConcurrentVMs`). Surface both `concurrencyDegree` and
   `maxConcurrentVMs` in the UI so the ceiling is never a surprise; on a small host,
   raising task concurrency means raising VM headroom (or sizing VMs smaller via
   `runtime.resources`).

**Ordering is the orchestrator's job, not a formal task-DAG.** Cross-task
sequencing stays simple: a **flat priority queue**, and the orchestrator *brain*
plans order/batching by reading `queue-status` (the whole queue) — serialize tasks
touching the same module, parallelize across modules, reprioritize. **No
cross-task `dependsOn` edges, no task-level topo sort** at the *queue* level (the
per-item business `blocked` flag in §6.2a is a different thing — it marks one item
stuck at its stage, not a queue dependency). The DAG belongs
*inside* a task's workflow (§3), where execution order genuinely needs it; between
tasks, a `priority` field + the brain's judgment is enough. (If hard cross-task
ordering is ever required, the brain simply enqueues the dependent task only after
the prerequisite reports `done` — a planning decision, not a scheduler mechanism.)

Control actions: `enqueue-work-item` (`priority`, `workflowId`), `dequeue-work-item`,
`set-concurrency`, `queue-status`, plus the per-run control API (§4.3) for any
single item you want to steer.

### 6.5 Dynamic workflow authoring (Claude-Code-style) + promotion

The orchestrator brain (§2a) doesn't only *instantiate* templates — it **authors**
them, the dynamic-workflow capability:

1. **NL → new template.** From a work item's description the brain calls
   `save-template` to generate a fresh DAG (wiring **library nodes**, §3.7, for the
   fixed gates). This is "Claude builds the workflow."
2. **Runtime expansion.** During a run it adds `dynamic: true` NodeRuns —
   `fanout` over a discovered list, an extra `loop` round, a `branch` it chose
   (§4.1). The run canvas renders these live so you see what it actually grew.
3. **Promote a run → reusable template.** When a dynamically-authored run succeeds,
   one action — `promote-run-to-template(runId)` — distills the *actual* executed
   graph (minus one-off dynamic indices) into a saved `workflow_template`. Next
   time the same kind of work reuses it as a fixed `defaultWorkflow`. This is the
   loop that turns "let the agent figure it out once" into "a vetted standard
   pipeline."

Guardrail: authored graphs must terminate in the project's required gate nodes
(e.g. `run-tests → open-pr` for code projects) — the brain composes vetted library
nodes (§3.7); it does not hand-roll the push/MR step.

---

## 7. Isolated Execution & Delivery

### 7.0 Decision: every node runs in its own microVM (microsandbox); claude-code is one executor, not a nested sandbox

**Decision (this revision): the isolation boundary is a per-node *microVM* via
[microsandbox](https://github.com/microsandbox/microsandbox) (libkrun/KVM).** Not
git-worktree-on-host (no boundary), not the framework harness `sandbox` flag
(cosmetic, and broken — §7.0b). **microsandbox is the sole runtime backend** —
there is no alternative or fallback backend; a **real VM-grade boundary is
mandatory**, and **every** node (vLLM / remote-API / claude-code) gets one, under
**one unified lifecycle** (§7.4). A git worktree is only *how the repo is checked
out inside* the microVM, never the boundary itself.

**Honest status: there is no container/microVM runtime in the repo at all — it is
built new** (verified repo-wide: no `dockerode`/`podman`/`microsandbox`/`e2b`, no
git deps; the harness `sandbox:true` is a flag forwarded to an external SDK with
no boundary we control). What *does* exist and is reused: the `run-code` JS
child-process sandbox (`coding-tools/run-code.ts`, JS-snippet only) and
`createCodingToolRegistry` (`coding-tools/index.ts:114`, the model-agnostic
bash/edit/read/write surface we re-point at `microsandbox exec`).

#### 7.0a Why microsandbox (libkrun/KVM microVM)

microsandbox is the **sole** runtime backend because it is simultaneously VM-grade
isolated (true microVM via libkrun/KVM, not a shared-kernel container),
single-binary self-hostable (`msb`, Apache-2.0), fast (<100 ms cold start +
snapshot/fork), and Node-controllable (`exec`/`execStream`/`fs`/port + loopback
mapping). It runs real native binaries (`claude` + node + pnpm) and mounts creds —
everything the NodeRunner (§7.4) needs.

**Caveats, stated plainly (there is no alternative backend — these are accepted
constraints, not hedged against a fallback):** (1) **beta** (v0.5.x, breaking
changes expected) — **pin versions**; the P0 spike is the go/no-go gate before
committing (§16). (2) needs **`/dev/kvm`** — verified available on the dev host
*inside WSL2 Ubuntu 24.04* (nested virt on; CPU VT-x on; `/dev/kvm` present). KVM is
a **hard requirement**: a production host must be bare-metal or a
nested-virt-enabled VPS. The orchestrator app + scheduler are plain Node and run
anywhere; only the microVM runtime needs KVM, and on Windows that means running it
inside WSL2 (already set up on the dev host).

#### 7.0b Why NOT the framework Claude Code harness for node execution (verified — the crash)

The framework's `@ai-sdk/harness-claude-code@canary.9` + `@ai-sdk/harness@canary.13`
**cannot run as wired**, and even if patched would be the wrong shape here:

1. **It requires a `HarnessV1SandboxProvider` the framework never supplies.**
   `HarnessAgent.createSession` reads `sandboxProvider = this.settings.sandbox`
   (`@ai-sdk/harness/dist/agent/index.js:2307`) and calls
   `sandboxProvider.createSession(...)` in `_acquireSandbox` (`:2521`). The framework
   adapter constructs `new HarnessAgent({...})` **without** a `sandbox`
   (`ai-sdk-adapter.ts:148-161` only forwards `sessionOptions.sandbox`, which is
   `undefined`), so `_acquireSandbox` dereferences `undefined.createSession` →
   `TypeError: Cannot read properties of undefined (reading 'createSession')`. The
   run completes with **zero events, no output** (the error is swallowed by the
   runner). Reproduced this session end-to-end.
2. **No local sandbox provider ships.** The two providers that exist are
   `@ai-sdk/sandbox-just-bash@canary.13` (an **in-memory JS bash** — `getPortUrl`
   throws, can't execute a real native `claude`) and `@ai-sdk/sandbox-vercel@canary.13`
   (a **cloud** Firecracker sandbox needing a Vercel account; the local subscription
   login isn't in it). Neither fits "real local claude on my subscription."
3. **Even fixed, it would nest.** The framework *does* expose the extension point —
   `AgentHarnessCreateSessionOptions.sandbox?: unknown` (`harness/types.ts:46`) is
   forwarded into the HarnessAgent (`ai-sdk-adapter.ts:151`) — so a microsandbox
   provider **could** be injected with **zero framework change**. But in the
   per-node-microVM model that provider would open a **second** sandbox *inside* the
   node's microVM = redundant nesting + the bridge/port/canary-version fragility.

**Resolution: run the real Claude Code as a normal executor inside the node's
microVM** — `claude --output-format stream-json` (or the Claude Agent SDK),
launched by `microsandbox exec` with the working directory set to the per-run
worktree. You get the **full real** Claude Code agent loop + tools + structured
events (stream-json), the microVM **is** the isolation, and the broken canary
wrapper is dropped. **This makes the v1.5 `cwd`-gap blocker moot** — the microVM,
not a harness option, sets the working directory. (The framework harness stays
available behind the seam for a future hosted/no-microVM mode, but is not on the
v2 path.)

### 7.1 Code work items (git) — checkout + commit + push happen *inside* the node microVM

The whole git story moves inside the node's microVM, which removes the v1.5
`cwd`-gap blocker entirely (the microVM's working directory is set by
`microsandbox exec`, not a harness option).

- **Checkout in-VM.** On INIT (§7.4 stage 3) the node clones/fetches the project
  repo into the microVM and creates a per-run branch (`an/run-<runId>`) from
  `baseRef`. For a host repo, the repo is **mounted** into the VM and a worktree is
  cut inside it; for a remote, it's cloned fresh. Either way the working tree lives
  **in the VM**, never in the user's main checkout — so concurrent/retried runs
  never collide.
- **Edit + test + commit in-VM, model-agnostically.** The EXECUTE step (§7.2)
  acts through tools bound to the in-VM working dir:
  `createCodingToolRegistry({ cwd, restrictToCwd:true })` re-pointed at
  `microsandbox exec` for **engine-model** nodes (vLLM/cloud), or the **real
  `claude`** running in the VM with `cwd = worktree` for **claude-code** nodes.
  Same env, different brain.
- **Push + PR.** A `git-push` library node (§3.7) or the in-VM `claude` runs
  `git push` + opens the PR via `gh`. Auth = the **`GITHUB_TOKEN`** framework
  secret (registered, `register-framework-secrets.ts`), resolved at run time with
  `resolveSecret("GITHUB_TOKEN")` and injected as scoped VM env / a credential
  helper — **never** baked into source. **Push is not assumed to succeed**:
  non-fast-forward rejection is the common case; it surfaces as a `failed` node
  with a clear error, and a `{kind:"pr"}` deliverable is set only once a PR URL
  actually exists.
- **No git deps in the repo today — build a thin git wrapper** over
  `microsandbox exec` (branch/commit/push). Do not assume the framework provides
  one.
- A **PTY substrate exists** (`node-pty` + `@xterm/*` in `package.json`) — stream
  the in-VM terminal output (claude/git) into the run terminal panel.

### 7.1a Per-run worktree/branch lifecycle (inside the microVM)

Branch management is core correctness; spec it as a state machine, not a risk
bullet. It now lives **inside** the disposable VM, so teardown is trivial (destroy
the VM) and the only durable artifact is the pushed branch/PR.

- **Naming:** one branch per run, deterministically unique — `an/run-<runId>` — so
  concurrent or retried runs of the same work item never collide.
- **States:** `provision VM → checkout branch from baseRef (in-VM) → execute
  (cwd = worktree) → on success: commit + push + open PR → on failure: per
  runtime.onFailure (§7.4.5) → destroy VM (the branch survives only via push)`.
- **Cancel races (§4.3).** Abort is cooperative; the in-VM process may still be
  writing after a run is marked cancelled. **Destroy waits for the VM's process to
  exit**; a half-done branch is simply never pushed.
- **No host GC needed for worktrees** — they die with the VM. The only sweep is for
  **un-pushed work**: on failure with commits but no push, optionally snapshot the
  VM (§7.4.2) for inspection instead of destroying immediately.

### 7.2 Non-code work items (files)

- Sub-agents produce artifacts; the orchestrator writes final files into the
  project `workingDir` (Local File Mode, the `local-artifacts` module) — e.g.
  `deck.pptx`, `report.md`.
- Intermediate artifacts use the **Resources store** (`resources/store.ts`:
  `resourcePut` / `resourceGetByPath`; `workspace-files` is a thin compat wrapper
  over it) at `agent_scratch` visibility, and are passed between nodes by
  **artifact id**, not pasted content. (Do not conflate `workspace-files`,
  `resources`, and `local-artifacts` — they are three layers; see §13.)

### 7.3 Delivery record

The `end` node collects the deliverable and writes it to the work item:
`{ kind: "pr", ref: "<url>" }` or `{ kind: "files", ref: ["report.md", …] }`.

### 7.4 The unified NodeRunner — one lifecycle, pluggable executor

**This is the core of "isolated, repeatable, disposable execution," and the answer
to "统一设计".** Every node — whatever its model/provider — runs through **one
`NodeRunner` skeleton** that owns a per-node microVM and runs an **identical
7-stage lifecycle**. Only **one** stage (EXECUTE) varies by provider, behind a
small `NodeExecutor` interface. Get this right and a node is independently
re-runnable, comparable across models, and disposable by construction.

#### 7.4.1 The orthogonality that makes it work: model ⟂ environment

A node has **two independent axes**:

- **Brain** (`engine` + `model` + `executor`) — *how it reasons/acts at EXECUTE*:
  cloud API, local **vLLM**, or **real Claude Code** (`stream-json`) in-VM. Per
  node (§8.3).
- **Runtime** — *where it runs*: its **own microVM** (§7.0), provisioned and torn
  down **identically regardless of brain**.

"Each node supports a different model" and "each node runs in its own virtual
environment" are therefore not in tension — the `NodeRunner` provisions the
microVM, runs the same init/mount/branch/extract/destroy around it, and plugs
whichever **executor** the node selected into the EXECUTE slot.

#### 7.4.1a The 7-stage lifecycle (identical for every node; only stage 4 differs)

| Stage | vLLM node | remote-API node | claude-code node |
|-------|-----------|-----------------|------------------|
| 1. **PROVISION** microVM | same | same | same |
| 2. **MOUNT** dirs + creds | + vLLM key | + remote key | + `~/.claude` |
| 3. **INIT** git branch/worktree + env + `setup` | same | same | same |
| 4. **EXECUTE** ⭐ *only difference* | run script → call host vLLM | run script → call remote API | `claude --output-format stream-json` in-VM |
| 5. **COLLECT** output + events + metrics (duration, tokens, exit) | same | same | same |
| 6. **EXTRACT** copy results out / `git push` + PR | same | same | same |
| 7. **TEARDOWN** destroy VM (or snapshot) | same | same | same |

Stages 1–3 and 5–7 are **shared infrastructure**; stage 4 is the **only**
pluggable part. That is the whole "unified design".

```ts
// NodeRunner — the shared skeleton (owns the microVM lifecycle)
async function runNode(node, ctx): Promise<NodeResult> {
  const vm = await runtime.provision(node.runtime);              // 1
  try {
    await runtime.mount(vm, node.workspace, node.creds);         // 2
    await runtime.init(vm, node.branch, node.env, node.setup);   // 3
    const result = await node.executor.run({ vm, node, deps });  // 4 ← only provider-specific
    const out = await runtime.collect(vm, result);              // 5 (output + AgentLoopUsage + timing)
    await runtime.extract(vm, node.output);                     // 6 (copyOut / push+PR)
    return out;
  } finally {
    await runtime.teardown(vm, node.runtime.onSuccess);          // 7 (destroy | snapshot | keep)
  }
}

// NodeExecutor — the ONLY thing that varies by provider
interface NodeExecutor { run(c: ExecCtx): Promise<ExecResult> }   // c.vm = exec/spawn/fs handle
//   VllmExecutor       → runAgentLoop(engine=ai-sdk:openai, baseUrl) with tools = createCodingToolRegistry re-pointed at vm.exec
//   RemoteApiExecutor  → same shape, hosted engine + key
//   ClaudeCodeExecutor → vm.spawn(`claude --output-format stream-json -p …`), parse the event stream
```

> **The executor receives an already-provisioned, mounted, branch-initialized VM
> handle.** It only runs the model; it never manages the VM lifecycle. That is why
> a claude-code node is **zero nesting** — no second sandbox, no framework harness
> (§7.0b) — just "run `claude` in the VM I was handed."

**The model-agnostic acting bridge (grounded):**
`createCodingToolRegistry({ cwd, restrictToCwd, canWrite, beforeBash })`
(`coding-tools/index.ts:114`) returns `{ bash, read, edit, write }` `ActionEntry`
tools bound to a `cwd`. For engine-model executors (vLLM/cloud) re-point its
`bash`/`edit`/… at `vm.exec`/`vm.fs`, so a vLLM node edits files + runs git/tests
**inside its microVM**, on any model. The claude-code executor uses claude's own
native tools, working dir = the in-VM worktree.

> ⚠ Verify the `./coding-tools` subpath is exported from `@agent-native/core`; if
> not, it's a one-line package export. This primitive is what lets **vLLM/cloud**
> nodes do real code work in the VM — without it, code work would be claude-only.
>
> ⚠ **Precision — "re-point" = reimplement, not configure.** `createCodingToolRegistry`'s
> built-in `bash`/`edit`/`read`/`write` spawn on the **host** (`runCodingCommand`,
> `coding-tools/index.ts:450`, local `process.env`). For a microVM node you reuse
> its **tool contract/shape** (the 4 `ActionEntry` schemas the model sees) but
> implement them against the VM: `bash → vm.exec`, `read/write → vm.fs`. The agent
> loop runs on the host (the scheduler process); only the *tool side effects* cross
> into the VM. Don't pass the host-spawning impl a `cwd` and expect VM isolation.

#### 7.4.2 `NodeRuntime` interface (the microVM abstraction) + microsandbox backend

```
NodeRuntime {                         // the microVM abstraction the NodeRunner sees
  provision(spec): VM                  // microsandbox Sandbox.builder(image).create()
  mount(vm, {repo,folders,creds,env})  // --mount-dir + fs().copyFromHost() (creds RO)
  init(vm, branch, env, setup)         // exec: git checkout -b branch baseRef; run setup once
  exec(vm, cmd, {cwd,env}): {code,stdout,stderr}   // microsandbox exec()
  spawn(vm, cmd, {cwd,env}): Proc      // execStream() → streamed stdout/stderr (for stream-json)
  fs(vm): { read, write, copyFromHost, copyToHost }
  getPortUrl(vm, port): string         // ws://127.0.0.1:<mapped>  — only if an executor needs a port
  snapshot(vm): Ref                    // msb snapshot (warm re-start / inspection)
  teardown(vm, policy)                 // stop() + remove()  | snapshot | keep
}
```

Two runtimes implement this interface: **`MicrosandboxRuntime`** (the `microsandbox`
npm SDK driving libkrun microVMs — the backend for **every** node that runs tools,
code, or an agent) and **`NoneRuntime`** (pure-reasoning nodes only — branch
conditions, planners with no file/git side effects — no VM). There is **no other
backend** (no Podman/E2B/Docker path); any node that executes tools or code uses
`microvm`. Mapping to the microsandbox SDK:
`provision`→`Sandbox.builder(name).image(IMG).port(...).create()`,
`exec`→`sandbox.exec()`, `spawn`→`sandbox.execStream()`, `fs`→`sandbox.fs()`,
`teardown`→`sandbox.stop()/remove()`. Note `getPortUrl` is **not** needed for the
chosen design (claude runs via `spawn`+stream-json, not a bridge port); it stays
on the interface only for a future bridge-style executor.

#### 7.4.3 Node `runtime` config (extends §3.4)

```
runtime: {
  kind: "microvm" | "none",          // microvm = MicrosandboxRuntime (default; all tool/code/agent nodes); none = pure-reasoning only
  image?: string,                    // OCI image (default: the prebaked node+pnpm+git+claude image, §7.4.7)
  baseRef?: string,                  // branch/commit to fork (default: project.defaultBranch)
  branch?: string,                   // default: an/run-<runId> — ONE branch per run,
                                     //   SHARED across the run's nodes (fix→test→push
                                     //   accumulate on it). The microVM is disposable;
                                     //   the branch lives in the repo, so the next node
                                     //   checks out the same branch + the prior commit.
  mounts?: [{ host, path, mode }],   // extra folders to attach (RO by default)
  creds?: string[],                  // secret keys → injected as scoped VM env (resolveSecret), NEVER baked into source
  env?: Record<string,string>,
  setup?: string[],                  // init commands (e.g. ["pnpm install"]) run once after checkout
  resources?: { cpus?, memMB?, diskMB? },          // per-VM caps (concurrency budget, §7.4.7)
  onFailure: "rollback" | "recreate" | "keep",     // recovery policy (§7.4.5)
  onSuccess?: "destroy" | "snapshot" | "keep"      // default destroy
}
```

#### 7.4.4 The fixed init sequence per node ("固定初始化 → then execute")

The `NodeRunner` runs these **in order** before the executor does any work; each
is journaled so the node is replayable:

1. **PROVISION** — `runtime.provision` boots the microVM from the node's image.
2. **MOUNT** — attach the project repo + any `mounts`; inject `creds` as **scoped
   VM env** via `resolveSecret` (e.g. `GITHUB_TOKEN`, the model key, or mount
   `~/.claude` for a claude node) — **never written into source/files**.
3. **INIT (branch)** — `git fetch` + create/switch to `branch` from `baseRef`
   inside the VM.
4. **INIT (setup)** — run `runtime.setup` once (extra deps) inside the VM.
5. **EXECUTE** — `node.executor.run({ vm, … })` — the only provider-specific step
   (vLLM / remote / claude stream-json), acting through tools bound to the VM.
6. **CHECKPOINT** — `git add -A && git commit` in-VM → record the SHA as the
   node's output ref (also the rollback point, §7.4.5).

#### 7.4.5 Lifecycle state machine + exception recovery

```
PROVISION → MOUNT → INIT(branch,setup) → ready
   → EXECUTE (executor acts via VM-bound tools)
   → CHECKPOINT
   → done       (success → onSuccess: destroy | snapshot | keep)

   FAIL at any stage  →  apply runtime.onFailure:
     "rollback" : git reset --hard baseRef && git clean -fdx (in-VM) → retry in SAME VM (cheap)
     "recreate" : teardown(VM) → provision()+mount()+init() from baseRef → retry (CLEAN VM)
     "keep"     : snapshot the VM for inspection, mark node failed
   (attempts++ each retry, capped by node.retry.max → then run fails)
```

- **rollback** = reset the in-VM worktree to the pre-node commit. Fast; use when the
  failure is logical (bad edit, test fail).
- **recreate** = "**直接把 node 运行时销毁重新来**" — destroy the whole microVM
  (corrupted `node_modules`, half-applied patch, wedged process) and boot a clean
  one from `baseRef`. This is the microVM's headline strength: a clean slate is one
  `teardown`+`provision`, ~<100 ms.
- Both are triggered by `run-retry-node` (§4.3) or auto-applied by `node.retry`.

**Independent re-run falls straight out of this:** because each node owns its
**own** microVM keyed by `(runId,nodeId,iteration,fanoutIndex)`, re-running one
failed node destroys+reboots **only that VM**, leaving every sibling untouched. No
special code path — it is the lifecycle used again.

#### 7.4.6 Repeatability & recovery = the §1.7 journal made physical

- Each NodeRun journals `{ input artifact ids, baseRef (exact commit forked), brain
  model, checkpoint ref }`.
- **Repeat** a node = re-provision from the **same `baseRef`** → identical
  *starting* environment. (Agent output is non-deterministic, §1.7: "repeatable"
  means same inputs + same env, **not** identical bytes.)
- **Resume** a whole run = completed NodeRuns replay from their checkpoint refs
  (zero re-spend); only `failed`/`pending` nodes re-provision and run.

#### 7.4.7 Credentials — reuse the Vault, build only the injection (verified)

Credential handling is **mostly reuse**, contrary to "build it all":

| Need | Reuse | Build |
|------|-------|-------|
| Scoped secret store + grants + request/approval + audit | dispatch **Vault** (`dispatch/src/server/lib/vault-store.ts:44-71, 911-1020`) | — |
| Resolve a secret headless | `resolveSecret(key)` inside `runWithRequestContext({userEmail,orgId})` (`credential-provider.ts:870`) | — |
| Resolve model API key | `getOwnerActiveApiKey()` → provider env-var map (`production-agent.ts:273`, `provider-env-vars.ts`) | — |
| Resolve connector OAuth (github/slack/…) | `resolveWorkspaceConnectionCredentialForApp()` access-checked (`workspace-connections/credentials.ts:543`) | — |
| Encrypt at rest | AES-256-GCM (`secrets/crypto.ts`) | — |
| **Inject resolved creds into the VM env** | precedent: codex `auth.json` copy (`ai-sdk-adapter.ts:220-255`) | **build** — microsandbox `--mount-file` / `fs().copyFromHost()` (RO) + scoped VM env; never bake into source |
| **Claude subscription into a claude node** | the local `~/.claude` OAuth (the dev host's Max login, verified) | **build** — mount `~/.claude` **read-only** into the VM so the in-VM `claude` reuses your subscription. (Token refresh won't persist on a RO mount; tokens last weeks. RW mount if refresh-persistence is needed — the one isolation/subscription trade-off, §14.) |
| **git push auth** | `GITHUB_TOKEN` resolves, but **no push wiring exists** | **build** — `https://x-access-token:$GITHUB_TOKEN@github.com/...` remote or a credential helper |

VM env = real credential isolation (per-VM, not host process). **One microVM per
running node** — VM count = node concurrency; cap it on CPU/mem/disk
(`runtime.resources`) + the KVM host's capacity (`maxConcurrentVMs`, §4.1).

#### 7.4.8 Base image (prebake, or every node is slow)

The node image must carry the fixed toolchain so INIT is fast: **node + pnpm + git
+ the `claude` CLI (`@anthropic-ai/claude-code`) prebaked**, plus the project's
language runtime. Without prebaking, every node re-runs `pnpm install
@anthropic-ai/claude-code` (+ project deps) on cold boot — the dominant cost.
Build one OCI image per language/runtime (projects have no "kind"; §6.1), version
it, and pin `runtime.image`. Warm re-starts use a microsandbox **snapshot**
(§7.4.2) of the post-`setup` state.

#### 7.4.9 Networking (host vLLM + outbound)

- **In-VM → host vLLM.** vLLM nodes call the **host's** vLLM endpoint
  (`http://localhost:8080` on the dev host) from inside the microVM. microsandbox
  gives the VM host-reachable networking; map the host vLLM as a VM-reachable address
  (the host-gateway equivalent of `localhost:8080`) and pass it as the node's
  `baseUrl` env. Confirm the exact in-VM address form in the P0 spike (a known config
  point, not a blocker).
- **Outbound.** Remote-API nodes + `git push` + the claude node's API calls need
  outbound egress from the VM. Default allow-egress; a per-node network policy can
  tighten it later (the `NodeRuntime` can expose a `setNetworkPolicy` like the
  provider interface, deferred).

---

## 8. Runtime Model Configuration — **mostly built (v1.5); v2 finishes it**

The v1 draft said "no first-class UI exists." **That is now false.** A working
slice ships in this template. v2 *completes* it, it does not start it.

### 8.1 What already exists (do not rebuild)

| Piece | Where |
|-------|-------|
| `runtime_configs` table (`id, name, kind, baseUrl, model, active, ownerEmail, orgId, …`) | `server/db/schema.ts` |
| `save-runtime-config`, `list-runtime-configs`, `delete-runtime-config` | `actions/` |
| `activate-runtime` — vLLM → writes `agent-engine` setting; Claude Code → writes `orchestrator-runtime` marker | `actions/activate-runtime.ts` |
| `get-runtime-status` — current chat engine/model/baseUrl + execution runtime + `claudeCodeInstalled` probe | `actions/get-runtime-status.ts` |
| **Claude Code login detection + real test result** (reads `~/.claude` expiry server-side; shows logged-in/expired + actionable `claude login`; test surfaces the real output/error, no fake "success") — **added this session** | `server/claude-code-status.ts`, `get-runtime-status.ts`, `start-claude-code.ts`, `settings.tsx` |
| `start-claude-code` — attempts a `startAgentHarnessRun`, **but the framework harness is non-functional** (§7.0b); kept only as the login-detection probe + superseded by the microVM `ClaudeCodeExecutor` (§7.4) | `actions/start-claude-code.ts` |
| Harness registration (`registerBuiltinAgentHarnesses()`), idempotent — kept for the probe; **not the v2 execution path** | `server/register-runtime.ts` |
| vLLM activation = **built-in `ai-sdk:openai` engine + baseUrl** (NOT a custom engine): writes `agent-engine` setting `{ engine:"ai-sdk:openai", model, config:{ baseUrl } }` + a server-written placeholder `OPENAI_API_KEY` secret | `actions/activate-runtime.ts` |
| Settings → Runtime UI (vLLM form, Claude Code connect/use/test, status card) | `app/routes/settings.tsx` |
| Client hooks (`useRuntimeConfigs`, `useRuntimeStatus`, `useActivateRuntime`, `useStartClaudeCode`, …) | `app/hooks/use-orchestrator.ts` |
| Harness packages **installed**: `@ai-sdk/harness@1.0.0-canary.13`, `@ai-sdk/harness-claude-code@1.0.0-canary.9` | `package.json` |

Three storage locations to keep straight: the **`runtime_configs` table**
(catalog + which row is `active`), the **`agent-engine` setting** (the live chat
engine `resolveEngine` reads), and the **`orchestrator-runtime` setting** (the
Claude-Code execution marker).

### 8.2 Engine resolution (grounded facts)

- `resolveEngine({ engineOption?, apiKey?, model?, appId? })` resolves in a 9-step
  order (options → `AGENT_ENGINE` env → app default → user `app_secrets` →
  settings row → env auto-detect → default `anthropic`).
- Built-in engines: `builder`, `anthropic`, and `ai-sdk:{anthropic,openai,
  openrouter,google,groq,mistral,cohere,ollama}` (registered by
  `registerBuiltinEngines()`).
- **`ai-sdk:openai` supports a `baseUrl` override** (`AISDKEngineConfig.baseUrl`),
  and when set it flips OpenAI to Chat-Completions mode — this is what makes vLLM
  work against any OpenAI-compatible gateway. vLLM activates **this built-in
  engine**; the app does NOT register a custom engine (see §8.5).
- The API-key paste route `POST /_agent-native/agent-engine/api-key`
  (`createAgentEngineApiKeyHandler`) writes to `app_secrets` via `writeAppSecret`.
  For vLLM, the placeholder key is written **server-side** by `activate-runtime`
  (see §8.5), not pasted by the user.

### 8.3 What v2 still adds (the real remaining gap)

1. **Per-node engine/model picker** in the editor inspector — route specific
   nodes to vLLM / Claude Code / hosted while others use the default. (Schema
   already has `engine`/`model` per node; the editor must expose them as a
   dropdown fed by `list-runtime-configs` + built-in engines.)
2. **A vLLM "Test" button** (parity with the Claude Code "Test") — a
   `test-runtime-config` action that does a one-shot `resolveEngine` + tiny
   completion against the saved `baseUrl`.
3. **Make `orchestrator-runtime` actually route execution.** Today the marker is
   written but the engine doesn't consume it (execution is chat-delegated). The v2
   `NodeRunner` (§7.4) reads the node's executor choice: `claude-code` → the
   **ClaudeCodeExecutor** (real `claude --output-format stream-json` in the node's
   microVM); `vllm`/hosted → the engine executor (`runAgentLoop`). Same microVM
   lifecycle either way (§7.4.1a); the marker only selects the EXECUTE step.
4. **vLLM model list comes from the saved `runtime_configs` row, not an engine.**
   There is **no longer a custom `"vllm"` engine** (`register-runtime.ts` is
   harness-only; vLLM rides built-in `ai-sdk:openai`, §8.5). So the built-in engine
   exposes no app-specific `supportedModels`; the per-node picker must read each
   saved runtime's `model` (and an optional model list column we add to
   `runtime_configs`) to populate. Do not reintroduce a template-registered engine
   for this (dual-registry pitfall, §8.5.1).

### 8.4 Manual setup (still useful as docs)

```bash
# Claude Code (subscription, no API key). Packages are ALREADY installed here.
claude login                    # or: claude setup-token → CLAUDE_CODE_OAUTH_TOKEN
# vLLM / any OpenAI-compatible endpoint: add via Settings → Runtime (no code).
#   name, baseUrl (e.g. http://localhost:8000/v1), model (e.g. qwen2.5-coder)
```

### 8.5 Runtime integration constraints (hard-won — do not regress)

Three constraints discovered the hard way. They are **why** vLLM rides the
built-in engine instead of a custom one, and they must stay true:

1. **Dual-registry pitfall — a template-registered engine is invisible to the
   framework.** `registerAgentEngine` from a template writes to a `_registry`
   Map that, in the dev runtime, is a *different module instance* than the one
   `resolveEngine` / `listAgentEngines` / the engine-status route read (template
   imports the package dist; the framework runs its own copy). A custom `"vllm"`
   engine registered in the template **never appears** to the framework → status
   reports `configured:false`, the chat falls back to `anthropic`. **Rule: do not
   register custom engines from the template; use a built-in (`ai-sdk:openai`)
   and pass `config.baseUrl`.** Built-ins are safe because the framework
   registers them itself via a top-level side-effect import.

2. **The placeholder key must be written server-side.** `ai-sdk:openai` requires
   `OPENAI_API_KEY` to pass its usability gate (vLLM ignores the value). Secrets
   are encrypted with a per-process machine-local fallback when
   `SECRETS_ENCRYPTION_KEY` is unset, so a **CLI-written** secret can't be
   decrypted by the **server**. `activate-runtime` therefore writes the
   placeholder via `writeAppSecret` from inside the action (server process).
   **Consequence: activating a vLLM runtime works from the Settings UI (HTTP →
   server), not from `pnpm action activate-runtime` (CLI).** Set
   `SECRETS_ENCRYPTION_KEY` to make secrets portable across processes.

3. **The composer model picker is a hard white-list.** It only lists
   `["anthropic","ai-sdk:openai","ai-sdk:google"]` (`client/use-chat-models.ts`,
   `MultiTabAssistantChat.tsx`). Because vLLM activates `ai-sdk:openai`, its
   active model is surfaced via the "current model" unshift — but a custom engine
   name would never show. **The §8.3 per-node picker must be a CUSTOM dropdown
   fed by `list-runtime-configs` + the built-in engine list — not the framework
   composer picker, which the template cannot extend.**

---

## 9. Data Model (SQL, additive — extends v1.5, not a rewrite)

**Already present (v1 + v1.5):** `workflows`, `tasks`, `step_runs`,
`runtime_configs`, `task_shares`, `workflow_shares`.

**v2 adds (additive — never drop/rename existing tables per the data contract):**

```
projects            (id, name, key, description, git_remote, default_branch,
                     working_dir, default_workflow_id, status_schemes(JSON),
                     environments(JSON), ...ownableColumns())
                     -- no project 'kind'; delivery type is per-workflow (§6.1).
                     --   working_dir = deliverable root, ALWAYS set (§7.2 target).
                     --   git_remote/default_branch set only when the project links
                     --   a code repo; null otherwise.
                     --   status_schemes = per-type business-status pipelines +
                     --   transitions + resolutionsAt (§6.2a), defaulted from the
                     --   template, overridable here. environments = the project's
                     --   env list (default dev/SIT/UAT/prod), §6.2a.
work_items          (id, project_id, type, title, description, priority, assignee,
                     -- business status (§6.2a/§6.2b — what the board shows):
                     status, status_category, environment, severity,
                     blocked, blocked_reason, blocked_by, resolution, status_stale,
                     -- automation overlay (§6.4 — is an AI run active right now):
                     exec_state, claimed_at, claimed_by,
                     workflow_id, workflow_run_id, deliverable, ...ownableColumns())
                     -- status/environment/blocked/resolution written ONLY by
                     --   transition-work-item (§6.2b), validated against the scheme.
                     --   status_category = todo|in-progress|completed|cancelled
                     --   (derived; completed≠cancelled). environment orthogonal to
                     --   stage. severity = SEV1..4 (prod-issue). blocked_by links
                     --   the blocking item. resolution required at a completed/
                     --   cancelled stage (shipped|cancelled|rejected|duplicate|
                     --   cannot-reproduce|rolled-back|deferred).
                     --   status_stale = watchdog flag (§6.2b L2): run finished but
                     --   the agent never moved status → board asks for confirm.
work_item_links      (id, from_item, to_item, kind, created_by, created_at)
                     -- kind: duplicate-of | blocks | blocked-by | relates-to.
                     --   duplicate-of backs resolution=duplicate; blocked-by backs
                     --   the blocked flag (auto-suggest unblock when to_item closes).
                     -- exec_state = idle|queued|claimed|running|paused|failed|done
                     --   (§6.4); the queue claims WHERE exec_state='queued'.
                     --   claimed_at/claimed_by back the atomic single-flight claim.
                     --   workflow_id = optional pre-picked template (blank → §6.3).
                     --   priority orders the flat queue (the brain plans order).
work_item_status_log (id, work_item_id, run_id, actor, from_status, to_status,
                     blocked, resolution, at)
                     -- append-only transition trail (§6.2b); every
                     --   transition-work-item call writes one row. actor = the
                     --   agent runId or a user email. The watchdog reconciles
                     --   "did status change during this run" against it.
node_defs           (id, key, kind, title, config(JSON), version,
                     ...ownableColumns())
                     -- reusable library nodes (§3.7): tool gates + parameterized
                     --   agent nodes; referenced from graphs by `key`.
workflow_templates  (id, name, description, graph(JSON), version,
                     ...ownableColumns())
workflow_runs       (id, template_id, work_item_id, status, deliverable,
                     token_budget, tokens_spent, started_at, completed_at,
                     ...ownableColumns())
node_runs           (id, run_id, node_id, type, title, assignee, engine, model,
                     status, iteration, fanout_index, dynamic, input_ref,
                     output_ref, error, agent_run_id, attempts, tokens_spent,
                     started_at, completed_at)
artifacts           (id, run_id, node_run_id, kind, ref, summary, created_at)
```

- **`node_runs.attempts`** backs `run-retry-node`; **`tokens_spent`** backs the
  per-node budget accounting `run-get`/§1.8 promise (run-level lives on
  `workflow_runs.tokens_spent`). Per-node **logs are an artifact** (kind
  `"log"`), not a column. Per-node `effort`/`timeoutMs`/`await`/retry-policy are
  **template-graph config** (stored in `workflow_templates.graph` JSON), not
  `node_runs` columns — only their runtime *outcomes* are columns.
- **Artifact references:** `node_runs.input_ref`/`output_ref` point at
  `artifacts.id`; `artifacts.ref` holds the Resources-store id/path
  (`resources/store.ts`) or a local-file path (§7.2). There is one artifact
  index (`artifacts`) over one content store (Resources) — not two stores.

Notes:
- **Do not "replace" v1 tables.** The data contract forbids destructive
  migrations. `workflows`/`tasks`/`step_runs` stay; v2 introduces the new tables
  alongside. A one-way **backfill** (not a schema drop) can copy `task→work_item`,
  `workflow→workflow_template`, `step_run→node_run` for users who want their old
  runs visible in the new UI.
- **`runtime_configs` already exists** with a *different* shape than the v1 draft
  imagined (`kind`/`model`/`active`/hand-rolled `ownerEmail`+`orgId`, **not**
  `ownableColumns()`). Keep it as-is; if v2 wants `ownableColumns()` scoping,
  that's an **additive column migration**, not a rename.
- Reuse the sharing primitives: `ownableColumns()` + `createSharesTable()` +
  `accessFilter`/`assertAccess` for every new ownable table (§13).

---

## 10. Action Surface (control + status)

**Already built (v1 + v1.5):** `create-task`, `list-tasks`, `get-task`,
`update-task`, `delete-task`, `save-workflow`, `list-workflows`, `get-workflow`,
`delete-workflow`, `run-orchestrator` (seeds only), `upsert-step-run`,
`list-step-runs`, `stop-task`, `navigate`, `view-screen`, **`save-runtime-config`,
`list-runtime-configs`, `delete-runtime-config`, `activate-runtime`,
`get-runtime-status`, `start-claude-code`**.

**v2 adds:**
- Templates: `save-template`, `list-templates`, `get-template`, `delete-template`,
  `promote-run-to-template` (§6.5).
- Node library: `save-node-def`, `list-node-defs`, `delete-node-def` (§3.7).
- Projects: `create-project`, `list-projects`, `get-project`, `update-project`.
- Work items: `create-work-item`, `list-work-items`, `get-work-item`,
  `update-work-item` (everything **except** business `status`/`environment`/`blocked`/`resolution`),
  `delete-work-item`, **`transition-work-item`** — the **sole writer** of business
  `status`/`environment`/`blocked`/`resolution`/`severity`; validates `from→to`
  against the scheme, derives `statusCategory`, enforces "completed/cancelled ⇒
  resolution from `resolutionsAt`", clears `resolution` on reopen, appends to
  `work_item_status_log` (§6.2b). Called by the agent (MCP) and the human (board
  drag). (`assign-work-item` = enqueue shorthand; `enqueue-work-item` is primary.)
- Work-item links: `link-work-items` / `unlink-work-items`
  (`duplicate-of`/`blocks`/`blocked-by`/`relates-to`, §9 `work_item_links`).
- Queue (§6.4): `enqueue-work-item`, `dequeue-work-item`, `set-concurrency`,
  `queue-status` (returns `{concurrencyDegree, running, maxConcurrentVMs, vmsInUse}`).
- Control: `run-start`, `run-pause`, `run-resume`, `run-cancel`,
  `run-retry-node`, `node-override`.
- Status: `run-get`, `run-graph`, `node-get`, `run-events`, `list-runs`
  (cross-item run history for the global Runs page).
- Engine reporting: `node-report` — a sub-agent attaches **interim
  progress/artifacts** only. **Terminal status (`done`/`failed`) is owned by the
  scheduler** when the sub-agent's run completes (it observes the run), so the
  two paths never double-write the same field.
- Runtime: `test-runtime-config` (the missing vLLM "Test").

All are `defineAction` with `run` + `schema`/`parameters` (note: **no `handler`
or top-level `access` field** — scope inside `run` via `accessFilter`/
`assertAccess`). All are automatically headless (CLI/HTTP/MCP/A2A).

---

## 11. Current Status vs To-Build (corrected, honest gap)

| Capability | v1 / v1.5 (now) | v2 (this design) |
|------------|-----------------|------------------|
| Linear step list (`step_runs`) | ✅ built | superseded by graph (kept for migration) |
| JSON workflow storage | ✅ built | kept; canvas added |
| **Runtime config table + CRUD actions** | ✅ **built (v1.5)** | reuse; extend per-node |
| **vLLM / OpenAI-compatible engine + UI** | ✅ **built (v1.5)** | add Test button + model list |
| **Settings → Runtime UI + Claude Code login detection** | ✅ **built (v1.5)** — reads `~/.claude` expiry, shows logged-in/expired, real test result | reuse |
| **Framework Claude Code harness (exec)** | ❌ **non-functional** (canary needs a SandboxProvider; crashes in `_acquireSandbox`, §7.0b) | **dropped** — replaced by real `claude` in a microVM (§7.4) |
| **microVM execution (microsandbox) per node** | ❌ (no runtime code; survey done, §7.0a) | **to build** (§7.4) — the core |
| Visual editor | ❌ (raw JSON textarea) | **to build** (React Flow) |
| Parallel/fanout/loop/branch/join | ❌ (ordered list only) | **to build** (engine §4) |
| Pipeline-vs-barrier semantics | ❌ | **to build** (§1.3, §4.1) |
| Dynamic runtime expansion | ❌ | **to build** |
| Determinism / journaled resume | ❌ | **to build** (§1.7) |
| Budget-aware scaling | ❌ | **to build** (§1.8) |
| Control API (pause/resume/cancel/retry) | partial (`stop-task` only) | **to build** |
| Status/graph API | partial (`list-step-runs`) | **to build** |
| Projects / work items | ❌ | **to build** |
| Work queue + cross-task concurrency (pull model, degree) | ❌ (no queue/pool primitive) | **to build** (§6.4) |
| Per-node execution runtime (provision/mount/branch/recover) | ❌ | **to build** (§7.4) |
| Model-agnostic acting tools (bash/edit/read/write bound to a `cwd`) | ✅ `createCodingToolRegistry` exists | re-point at `microsandbox exec` (§7.4.1a) |
| microVM `NodeRuntime` (provision/exec/fs/snapshot/destroy per node) | ❌ (no runtime code; microsandbox not installed) | **to build** (§7.4.2) — microsandbox SDK |
| Credential store + grants + approval + injection | ✅ dispatch **Vault** + core resolvers (reuse) | build only **VM env injection** + `~/.claude` mount + git-push auth (§7.4.7) |
| Human approval gate (`human` node) | ✅ dispatch approval state machine (reuse) | register changeType (`dispatch-store.ts:426-604`) |
| Git branch / commit / push / PR | ❌ (no git deps in repo) | **to build** — thin `git` CLI wrapper over `runCodingCommand` |
| Reusable node library (fixed review/commit/push/MR nodes) | ❌ | **to build** (§3.7) |
| Orchestrator brain controls graph via MCP action surface | partial (MCP auto-mounted; harness not connected, passes no tools) | **wire** `connect` (§2a) |
| Dynamic authoring (Claude builds workflow) + promote-to-template | partial (decomposition concept only) | **to build** (§6.5) |
| Server-side DAG execution (scheduler) | ❌ (action returns an instruction; the UI calls `sendToAgentChat`) | **to build** (`startRun`+`runAgentLoop`, model on `jobs/scheduler.ts`) |
| Headless single-run trigger | ✅ **partial** (`start-claude-code` probes login + attempts a run) | generalize to the microVM `NodeRunner` for all node types (§7.4) |
| **Complete isolated/virtual exec env (microVM per node)** | ❌ **(code runs unisolated on host today)** | **to build** (§7.4 — microsandbox) |
| `run-code` JS sandbox (Node perm-model + scrubbed env + bridge) | ✅ built (JS snippets only) | reuse for trusted `tool`-node snippets |
| In-microVM git checkout + commit + push + PR | ❌ (no git deps) | **to build** (§7.1 — thin git wrapper over `microsandbox exec`) |
| Harness working-dir (`cwd`) for code nodes | ⚠️ adapter drops `cwd` (verified) | **moot** — code runs claude in-microVM (cwd set by VM); framework harness dropped (§7.0b) |
| Non-code deliverables to local dir | ❌ | **to build** (`local-artifacts`) |
| PTY/terminal streaming | ✅ deps present (`node-pty`+`@xterm/*`) | wire into run terminal panel |

**Housekeeping (Phase 0) — DONE (verified this session, no longer open):**
- ✅ `orchestrating` skill synced into `.claude/skills/orchestrating/SKILL.md`
  (identical to `.agents/skills/`).
- ✅ `server/plugins/agent-chat.ts` now uses `appId:"orchestrator"`, an
  orchestrator system prompt, and orchestrator `initialToolNames`.
- ✅ `AGENTS.md`/`CLAUDE.md` action lists now include all 6 runtime/harness
  actions.

Remaining Phase-0 item (still open): make the `orchestrator-runtime` marker
actually route execution (today it's written but unused — §8.3 item 3).

---

## 12. Phased Implementation Plan

Each phase ships behind the four-area checklist (UI / actions / skills / state)
and is verified before the next begins.

0. **Reconcile v1.5 + housekeeping — mostly DONE** (skill synced, `agent-chat.ts`
   identity, doc action lists; see §11). **Only remaining:** make
   `orchestrator-runtime` consumable so the existing UI actually routes
   execution. Cheap, unblocks everything.
1. **Engine core** — graph schema, substrate-aware deterministic scheduler
   (sequential → pipeline → parallel/fanout → branch → loop) with the **item-
   correlation rules (§4.1a)**, NodeRun journal + resume (§1.7 preconditions),
   control+status actions, **and per-node `timeoutMs` enforcement + stuck-run
   detection from day one** (an engine coordinating subprocesses needs liveness
   immediately, not in "hardening"). Headless via `startRun`+`runAgentLoop`,
   modeled on `jobs/scheduler.ts`. Verify via CLI (`pnpm action run-start …`).
   **Also wire the orchestrator brain's control channel now (§2a):** connect the
   Claude Code orchestrator (planner) node to the app's MCP surface (`claude mcp
   add` / `agent-native connect …/mcp`) so it can read+drive the graph — without it,
   it can't author or steer.
2. **Run viewer first, editor later.** Build a **read-only graph overlay** (live
   NodeRun status on a canvas) — high value, low effort. Keep **JSON/YAML as the
   authoring path** (it's already the agent-editable format). Only build the full
   React Flow drag-edit editor **if hand-authoring proves painful** — for a solo
   developer-user it is the highest-effort, lowest-marginal-value phase, so it is
   explicitly deferred, not assumed.
3. **Projects, work items & the queue (the primary usage model)** — project +
   work-item tables, CRUD, kanban-by-status board, **the full status model
   (§6.2a/§6.2b): `transition-work-item` validator + watchdog + `work_item_status_log`
   + `work_item_links`**, **the work queue + atomic-claim worker pool with a
   configurable `concurrencyDegree` (§6.4)**, the **reusable node library (§3.7)**
   (ship a starter set: `code-review`, `run-tests`, `git-commit`, `git-push`,
   `open-pr`, **`finalize-status`**), and **dynamic authoring + promote (§6.5)**.
   Tables use **`ownableColumns()`** for owner scoping (the framework standard);
   the **shares tables + sharing UI are deferred** until multi-user is needed —
   additive later (§9). **Also rewrite `orchestrating/SKILL.md` + `CLAUDE.md` to the
   v2 surface** — they are still v1 (task/`step_runs`); they must mandate the agent's
   `transition-work-item` calls at the §6.2a judgement points (the writer half of
   §6.2b), or the watchdog fires on every run. **Ship a docs-shaped default scheme
   too** (e.g. requirement-docs: 待写作 · 撰写中 · 评审中 · 定稿) so a non-code
   project isn't forced through 测试/发布 stages it can't reach.
4. **Unified `NodeRunner` over a microVM (§7.4) — microsandbox.** Build the
   `NodeRuntime` (microsandbox SDK: provision/mount/init/exec/spawn/fs/snapshot/
   teardown) + the 7-stage `NodeRunner` skeleton + the three executors
   (`VllmExecutor`, `RemoteApiExecutor`, `ClaudeCodeExecutor` = `claude
   --output-format stream-json` in-VM). Prebake the base image (node+pnpm+git+claude,
   §7.4.8); inject creds as scoped VM env + mount `~/.claude` (§7.4.7); wire host
   vLLM networking (§7.4.9). Build the thin **git wrapper** (branch/commit/push over
   `microsandbox exec`) + **git-push auth** + **PR creation**. Validate the headline
   property end-to-end: **independent node re-run** (destroy+reboot one VM). Then
   `local-artifacts` delivery for
   non-code; PTY terminal panel. microsandbox is the **sole** backend (no
   Podman/E2B/Docker path). **Infra prereq:** `msb` installed + KVM (WSL2 on the dev
   host, bare-metal/nested-virt VPS in prod).
5. **Runtime config completion** — per-node model picker, vLLM Test, model lists.
6. **Hardening** — concurrency caps, retries, idempotent resume, budget ceilings,
   audit log, optional **remote microsandbox `NodeRuntime`** (multi-host, over the
   network) behind the §7.4.2 interface, durable run store.

---

## 13. Framework API Reference (verified `file:line`)

Use these exact symbols; do not reinvent. Paths under `packages/core/src`.

**Engines**
- `resolveEngine(config)` — `agent/engine/registry.ts:404`; config
  `{ engineOption?, apiKey?, model?, appId? }`.
- `registerAgentEngine(entry)` — `agent/engine/registry.ts:52`; entry =
  `{ name, label, description, installPackage?, capabilities, defaultModel,
  supportedModels, requiredEnvVars, create }`.
- `registerBuiltinEngines()` — `agent/engine/builtin.ts:37` (engines).
- `createAISDKEngine(provider, config)` — `agent/engine/ai-sdk-engine.ts:412`;
  `baseUrl` at `:188`/`:390`; openai+baseUrl→chat-completions `:402`.

**Harness (framework wrapper — NOT used for v2 execution; §7.0b)**
- `registerBuiltinAgentHarnesses()` — `agent/harness/builtin.ts:13`
  (ids `ai-sdk-harness:{claude-code,codex,pi}`).
- `resolveAgentHarness(name, config?)` — `agent/harness/registry.ts:38`.
- `startAgentHarnessRun(opts)` — `agent/harness/runner.ts:34` (wraps `startRun`).
- **⛔ Non-functional as wired (verified this session).** `ai-sdk-adapter.ts:148`
  builds `new HarnessAgent({...})` with **no `sandbox`**; canary.13
  `HarnessAgent.createSession` requires `this.settings.sandbox`
  (`@ai-sdk/harness/dist/agent/index.js:2307`) and
  `_acquireSandbox` (`:2521`) dereferences it →
  `TypeError: Cannot read properties of undefined (reading 'createSession')`;
  the run yields **zero events**. No local SandboxProvider ships
  (`@ai-sdk/sandbox-just-bash@canary.13` = in-memory JS, no ports, can't run native
  claude; `@ai-sdk/sandbox-vercel@canary.13` = cloud). **The extension point exists**
  — `AgentHarnessCreateSessionOptions.sandbox?: unknown` (`harness/types.ts:46`) is
  forwarded at `ai-sdk-adapter.ts:151` — so a custom provider could be injected with
  **zero framework change**, but v2 deliberately does **not** (it would nest a
  sandbox inside the node microVM; §7.0b). Run real `claude` in the microVM instead.
- Sandbox provider interface (for reference / the `NodeRuntime` shape): types in
  `@ai-sdk/harness/dist/agent/index.d.ts` (`HarnessV1SandboxProvider`,
  `HarnessV1NetworkSandboxSession` — `run/spawn/readFile/writeFile/getPortUrl/ports/
  stop/destroy/restricted/defaultWorkingDirectory`); concrete reference impl =
  `@ai-sdk/sandbox-vercel@canary.13` (473 LOC, the blueprint our `MicrosandboxRuntime`
  mirrors).

**Runs (headless)**
- `runAgentLoop(opts)` — **`agent/production-agent.ts:2228`** (single options
  object: `{ engine, model, systemPrompt, tools, messages, send, signal, … }`,
  returns `AgentLoopUsage`).
- `startRun(runId, threadId, runFn, onComplete?, options?)` — `agent/run-manager.ts:212`
  (continues even with no SSE subscribers).
- `abortRun(runId, reason?)` — `agent/run-manager.ts:1018`.
- `subscribeToRun(runId, fromSeq)` — `agent/run-manager.ts:622`.
- **Canonical headless pattern:** `jobs/scheduler.ts` — `runWithRequestContext` →
  `resolveEngine` → `createThread` → `startRun` → `runAgentLoop`.

**Agent teams (background controller per CLAUDE.md)**
- `spawnTask`, `processAgentTeamRun`, controllers — `server/agent-teams.ts`.

**A2A**
- `invokeAgent({ target, prompt, … })` — `a2a/invoke.ts:142`; re-export
  `a2a/index.ts:10`; `callAgent` re-exported from `a2a/client.js`. (`call-agent`
  is the script `scripts/call-agent.ts`, not a function.) **A2A returns response
  text only — no usage/token data** (relevant to §1.8 budget; see §14).

**Orchestrator brain control surface (§2a)**
- Action→MCP-tools bridge: `createMCPServerForRequest` — `mcp/build-server.ts`;
  mounted at `/_agent-native/mcp` by `mountMCP` — `server/agent-chat-plugin.ts`
  (auto-wired by the template's `createAgentChatPlugin`). Connect a harness with
  `agent-native connect <url>/_agent-native/mcp --client claude-code`
  (`--full-catalog` to skip `tool-search`).
- CLI fallback: `runScript()` — `scripts/runner.ts:58` (`pnpm action <name>
  --args`); needs `AGENT_USER_EMAIL`/`AGENT_ORG_ID` for scoping.
- Harness session **does not** get `mcpServers` as a first-class option
  (`harness/types.ts:36-56`); `tools`/`skills` are forwarded but
  `start-claude-code.ts` passes none today.

**Work queue (§6.4) — no ready primitive; build from these**
- Atomic single-flight claim pattern: `claimA2ATaskForProcessing` —
  `a2a/task-store.ts` (used `a2a/handlers.ts:128`), stuck-reclaim
  `handlers.ts:779-815`.
- Concurrency-limited worker pool pattern: `Promise.all(Array.from({length:N},
  worker))` — `cli/workspace-dev.ts:1259` (only example in repo; not exported).
- The cron scheduler is **sequential**, not a pool (`jobs/scheduler.ts:210-260`).

**Sandbox / code exec**
- `registerSandboxAdapter`, `getSandboxAdapter`, `AGENT_NATIVE_SANDBOX` —
  `coding-tools/sandbox/index.ts:58/68`; only `local` wired; Docker =
  `blueprints/sandbox/docker.md` (doc, not code).
- `run-code` — `coding-tools/run-code.ts`. **No git-worktree helper exists — build
  one.**
- **`createCodingToolRegistry({ cwd, restrictToCwd, canWrite, beforeBash })`** —
  `coding-tools/index.ts:114`; returns `{ bash, read, edit, write }` ActionEntry
  tools bound to a `cwd`. The model-agnostic acting surface for engine-model nodes
  in a runtime (§7.4.1). `bash` inherits parent process env (`:460`) — see §7.4.7
  credential caveat. **Verify `./coding-tools` is exported from core** (else add
  the export).

**Artifacts / files (three distinct layers — don't conflate)**
- Resources store (id-addressable): `resources/store.ts` — `resourcePut`,
  `resourceGetByPath`.
- `workspace-files/store.ts` — thin compat wrapper over Resources (`scratch/` →
  `agent_scratch`).
- `local-artifacts/` — `agent-native.json` Local File Mode (repo-file source of
  truth).

**Data / actions / scoping**
- `ownableColumns()` — `sharing/schema.ts:36`; `createSharesTable(name)` — `:66`.
- `accessFilter` — `sharing/access.ts:91`; `resolveAccess` — `:219`;
  `assertAccess` — `:308`.
- `defineAction(options)` — `action.ts:543`; uses `run` + `schema`/`parameters`
  (**no `handler`, no top-level `access`**).

**Secrets**
- `GITHUB_TOKEN` registered — `secrets/register-framework-secrets.ts:66`.
- `writeAppSecret`/`readAppSecret` — `secrets/storage.ts:103/157`;
  `resolveSecret(key)` — `server/credential-provider.ts:870`.
- API-key route `POST /_agent-native/agent-engine/api-key` —
  `server/agent-engine-api-key-route.ts` (`createAgentEngineApiKeyHandler`).

**Credentials & approvals — reuse from dispatch + core (verified §7.4.7)**
- Scoped vault (store + grants + request/approval + audit + env push):
  `dispatch/src/server/lib/vault-store.ts:44-71` (ctx scope), `:801-832`
  (`syncGrantsToApp` env push), `:911-1020` (request/approve).
- Model key headless: `getOwnerActiveApiKey()` — `agent/production-agent.ts:273`;
  provider→env-var map `agent/engine/provider-env-vars.ts`.
- Connector OAuth (access-checked): `resolveWorkspaceConnectionCredentialForApp()`
  — `workspace-connections/credentials.ts:543`.
- Cred-file-into-sandbox precedent: `installCodexCliAuthIntoSandbox` —
  `agent/harness/ai-sdk-adapter.ts:220-255`.
- Human approval gate: `createApprovalRequest`/`approveRequest` +
  changeType apply switch — `dispatch/src/server/lib/dispatch-store.ts:426-604`.

**microVM / git execution — build new (verified: nothing to reuse but primitives)**
- microVM runtime: the **`microsandbox`** npm SDK (libkrun) — `Sandbox.builder()
  .image().port().create()`, `.exec()`, `.execStream()`, `.fs()`, `.stop()/.remove()`,
  snapshots. **Beta (v0.5.x), Apache-2.0.** Not installed yet; needs `/dev/kvm`
  (verified on the dev host's WSL2). Reference provider impl to mirror:
  `@ai-sdk/sandbox-vercel@1.0.0-canary.13` (`dist/index.js`, 473 LOC).
- Generic exec primitives (to shell `msb`/`git` from Node if needed):
  `runCodingCommand` / `spawnBackgroundCommand` — `coding-tools/index.ts:450/500`
  (inject scrubbed env yourself — they default to full `process.env`).
- No git deps in the repo (no simple-git/isomorphic-git/octokit); only a one-off
  `git clone` at `packages/skills/src/install.ts:409` — build a thin git wrapper
  over `microsandbox exec`.

**Verified gotchas (won't surface from signatures alone)**
- **`startRun` per-thread singleton** — one run per `threadId`; a new `startRun`
  on the same thread **aborts** the prior (`run-manager.ts:222-226`). → distinct
  thread + runId per concurrent NodeRun (§4.2).
- **`startRun` is in-memory per isolate** (`activeRuns`/`threadToRun` module Maps);
  multi-isolate deploys rely on the SQL fallback + heartbeat/reap. Drive the
  scheduler from one durable place (§14).
- **`runAgentLoop` usage is dropped by `startRun`** — capture inside `runFn`
  (§4.2).
- **Harness `cwd` is non-functional** — declared (`types.ts:41`), forwarded by the
  runner, **never read** by `ai-sdk-adapter.ts:125-163`. **Moot for v2** — we don't
  use the framework harness; the microVM sets the working directory (§7.0b).
- **microsandbox needs `/dev/kvm`** — verified present in the dev host's WSL2
  (Ubuntu 24.04, nested virt on). On a Linux server: bare-metal or nested-virt VPS.
  The app/scheduler are plain Node (run anywhere); only the microVM backend needs
  KVM. Beta API → pin the version, keep the `NodeRuntime` seam (§7.4.2).
- **Settings are global, key-only** (`settings/store.ts`, no owner/org column).
  `orchestrator-runtime` / `agent-engine` are deployment-wide — fine for solo
  self-host, not per-user. The headless scheduler reads them with no context, which
  is *why* the read works (§8.5).
- **`resolveEngine` vLLM path is gated by `OPENAI_API_KEY`** (usability gate) and
  **Builder creds outrank the stored row** (`detectEngineFromUserSecrets` runs
  first). The placeholder secret must be resolvable in the run's context (§8.5.2).
- **Node soft-timeout walls** — hosted runs clamp ~40s and serverless kills ~60s
  (`run-manager.ts`); long code nodes need the auto-continue path or chunking, not
  an assumption they run unbounded.

---

## 14. Open Risks & Decisions

- **Determinism vs live agents.** Agent outputs are non-deterministic, so
  "replay" means *replay the journal* (cached completed NodeRuns), not
  *re-derive identical outputs*. `run-resume` replays journaled artifacts;
  `run-retry-node` is the explicit "re-run this node live" escape hatch. Make this
  distinction loud in the UI so users aren't surprised.
- **microsandbox is beta (the biggest unknown).** v0.5.x, breaking changes
  expected, and its stability as a long-lived server hosting many concurrent
  microVMs is unproven at our scale. It is the **sole** backend by decision — there
  is no alternative runtime. Mitigation: **pin the version**, and gate commitment on
  the **P0 spike** (boot N concurrent VMs + run claude in one) before building phases
  2/4 on it; if the spike fails, the microsandbox/KVM issue must be resolved (version
  pin, host config) rather than swapped out.
- **Subscription auth inside an isolated VM (the one real trade-off).** Using the
  Max subscription in a sandbox means mounting `~/.claude` into the VM (§7.4.7) — a
  read-only mount works but won't persist token refresh (tokens last weeks); a RW
  mount persists refresh but widens what the VM can touch. Decide RO + periodic
  re-login vs RW per node. (vLLM/remote nodes don't have this — they take a scoped
  key env.)
- **Host vLLM reachability from the VM (§7.4.9).** The in-VM node must reach the
  host's vLLM endpoint; confirm the host-gateway address form for microsandbox early
  (a config point, but verify in the phase-4 spike, not at the end).
- **KVM availability is a hard requirement.** microVMs need `/dev/kvm` — fine on
  bare metal / nested-virt VPS / the dev host's WSL2, but **many cheap cloud VMs
  disable nested virt**. There is no non-KVM backend: the deployment host **must**
  provide `/dev/kvm` (bare-metal or nested-virt-enabled). Verify KVM on any target
  host before deploying.
- **Where the scheduler loop lives (durability).** `startRun` state is in-memory
  per isolate. Decide the single durable driver: a server-plugin tick (like
  `jobs/scheduler.ts`'s 60s loop) that advances ready NodeRuns and relies on the
  SQL heartbeat/reap to recover stranded `running` rows after a crash/redeploy.
  Without one durable owner, a multi-instance deploy double-schedules or strands
  nodes.
- **Budget accounting across `@app` A2A.** Sub-agent usage is local; an `@app`
  delegate's tokens aren't in our `AgentLoopUsage`. Decide whether A2A spend
  counts against the run budget (probably: best-effort, logged, not enforced).
- **`runtime_configs` scoping.** It uses hand-rolled `ownerEmail`+`orgId`, not
  `ownableColumns()`. Decide whether to migrate to the standard primitives
  (additive columns) or leave as-is. Leaving as-is is fine if no sharing is
  needed.
- **Single-machine assumption.** The scheduler, the KVM host, and PTY assume one
  Linux host (or WSL2). Multi-host execution needs a **remote microsandbox
  `NodeRuntime`** (microsandbox over the network) behind the §7.4.2 interface + a
  durable run store — out of scope for v2 phase 1–5, gated behind phase 6.

---

## 15. Sources

- Claude Code — Dynamic workflows (docs): https://code.claude.com/docs/en/workflows
- Anthropic — Introducing dynamic workflows: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- Anthropic — A harness for every task: https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
- Claude Agent SDK — multi-agent: https://platform.claude.com/docs/en/managed-agents/multi-agent.md
- Anthropic — Building Effective Agents: https://www.anthropic.com/engineering/building-effective-agents
- Deterministic-orchestration deep-dive: https://alexop.dev/posts/claude-code-workflows-deterministic-orchestration/
- **microVM runtime (§7.0a — microsandbox, the sole backend):**
  - microsandbox (libkrun microVMs, self-host): https://github.com/microsandbox/microsandbox
  - microsandbox Node SDK: https://docs.microsandbox.dev
  - `@ai-sdk/sandbox-vercel` SDK (interface-shape reference only, not a backend we use): https://vercel.com/docs/sandbox/sdk-reference
- **Sandbox provider crash (§7.0b):** verified against installed
  `@ai-sdk/harness@1.0.0-canary.13` + `@ai-sdk/harness-claude-code@1.0.0-canary.9` +
  `@ai-sdk/sandbox-{just-bash,vercel}@1.0.0-canary.13` source.
- Framework APIs (this repo, verified §13): `agent/engine/*`, `agent/harness/*`,
  `agent/run-manager.ts`, `agent/production-agent.ts`, `jobs/scheduler.ts`,
  `coding-tools/sandbox/*`, `coding-tools/run-code.ts`, `resources/store.ts`,
  `workspace-files/store.ts`, `local-artifacts/*`, `a2a/*`, `server/agent-teams.ts`,
  `sharing/*`, `secrets/*`, `action.ts`.
- This template's v1.5 implementation: `actions/{save,list,delete}-runtime-config.ts`,
  `actions/activate-runtime.ts` (built-in `ai-sdk:openai` + placeholder secret),
  `actions/get-runtime-status.ts`, `actions/start-claude-code.ts`,
  `server/register-runtime.ts` (harness-only registration), `server/plugins/runtime.ts`
  (thin startup wrapper), `server/plugins/agent-chat.ts` (orchestrator identity),
  `app/routes/settings.tsx`, `app/hooks/use-orchestrator.ts`, `server/db/schema.ts`.

---

## 16. Feasibility Verdict (code-grounded, this review)

**The architecture is buildable on existing framework primitives.** The headless
scheduler spine — `action.run` → `runWithRequestContext` → `resolveEngine` →
`createThread` → `startRun` → `runAgentLoop` → persist → advance DAG, with no
browser — is exercised end-to-end today by `jobs/scheduler.ts`; `startRun` is
explicitly background-detached and survives request return and SSE-subscriber
disconnect (`run-manager.ts:205-211,408-409`). Every API the design leans on was
verified present with the signature claimed (§13). The `orchestrator-runtime` marker
reads back, and `resolveEngine` forwards the vLLM `config.baseUrl` into
`createAISDKEngine` (§8.5). The one thing that **does not** work — the framework
Claude Code harness — is verified broken (§7.0b) and **designed out**: v2 runs real
`claude` in a microVM, which removes that dependency rather than patching it.

**Two items must be resolved before the phases that depend on them — neither is a
re-architecture:**

1. **microVM execution spike (gates phase 4).** Prove microsandbox end-to-end on the
   target host: boot a VM from a prebaked image, mount `~/.claude`, run `claude
   --output-format stream-json`, reach the host vLLM, and destroy+reboot for a clean
   re-run — plus N concurrent VMs for the resource cap. Beta + KVM are the
   unknowns (§14); microsandbox is the sole backend, so this spike is a hard
   go/no-go on KVM + beta stability. **Run it before committing phase 4.**
2. **`startRun` concurrency mechanics (shapes phase 1).** Distinct thread + runId
   per NodeRun, per-node context re-establishment, and in-`runFn` usage capture
   (§4.2). Correctness requirements, not blockers — but the scheduler must be
   written for them from the start.

Everything else (engine core, journal/resume, projects/work-items, run viewer,
runtime completion) is unblocked and **independent of the microVM work** — the
scheduler treats a node's executor + runtime as opaque. **Recommended order:** Phase
0 (finish `orchestrator-runtime` routing) → Phase 1 (engine core, built for the §4.2
mechanics) → Phase 3 (projects/PM board, the project-management ask, runs on
vLLM/cloud with no microVM) → Phase 4 (microVM `NodeRunner`, after the spike). The
project-management + multi-model value lands in 0–1–3 **before** the hardest piece.

> **Scope cut to de-risk:** the project-management + multi-model orchestration
> ask (Goals 4, 6) is reachable through Phases 0–1–3 **without** the hardest piece
> (isolated git execution, Phase 4). A solo user gets define-project →
> create-work-item → orchestrator decomposes → runs a DAG across vLLM / Claude
> Code / hosted models → delivers file artifacts, long before worktree-isolated
> PR delivery lands. Sequence so value arrives before the `cwd`/worktree work.
