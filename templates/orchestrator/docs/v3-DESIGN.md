# Orchestrator v3 — Multi-Model Workflow Execution Engine

A standalone agent-native app for executing AI workflows on a multi-model worker pool. **No task model. No status machine. No project management.** Pure execution: workflows + runs + spawns + workspaces.

**Modeled on Claude Code's Dynamic Workflow runtime** — same data-flow contract (one channel = prompt string; default return = text; opt-in schema validation; no auto-injection of upstream into downstream context), but with multi-model workers and DAG-as-data instead of JS.

The user's local Claude Code is the brain. This backend is one of CC's tools. Other apps (like `tracker`) dispatch work via A2A.

This document is the complete design.

---

## Table of Contents

0. [Goal, Layering, Invariants, Channel Contract](#0-goal-layering-invariants-channel-contract)
1. [Architecture](#1-architecture)
2. [Core Concepts](#2-core-concepts)
3. [Data Model](#3-data-model)
4. [DAG Node Types](#4-dag-node-types)
5. [Prompt Templates and Expressions](#5-prompt-templates-and-expressions)
6. [Inter-Node Data Flow (CC-Aligned)](#6-inter-node-data-flow-cc-aligned)
7. [Agent & Model Resolution (Reuses Framework)](#7-agent--model-resolution-reuses-framework)
8. [MCP Surface — CC's Toolbox](#8-mcp-surface--ccs-toolbox)
9. [Reconciler Behavior](#9-reconciler-behavior)
10. [Worker Lifecycle (microVM + ACP)](#10-worker-lifecycle-microvm--acp)
11. [Output Discipline](#11-output-discipline)
12. [Error / Retry / Timeout](#12-error--retry--timeout)
13. [Auth / Secrets](#13-auth--secrets)
14. [Observability](#14-observability)
15. [Template Reuse + Input Interpolation](#15-template-reuse--input-interpolation)
16. [A2A Inbound (Other Apps Calling Orchestrator)](#16-a2a-inbound-other-apps-calling-orchestrator)
17. [End-to-End Example](#17-end-to-end-example-how-cc-handles-a-real-task)
18. [Consistency & Concurrency Invariants](#18-consistency--concurrency-invariants)
19. [Explicit Non-Goals](#19-explicit-non-goals)

---

## 0. Goal, Layering, Invariants, Channel Contract

### Goal

Pure workflow execution engine. User's local Claude Code is the orchestrator brain. This backend provides: structured DAG execution, multi-model workers in isolated microVMs (or driven via ACP for local coding agents), workspaces, mutable runs, full observability.

### Three-layer separation

```
LAYER 1 — TASK / INTENT       (CC's chat or dispatching app; backend NO awareness)
LAYER 2 — RUN / SPAWN / WS    (this backend; bounded executions)
LAYER 3 — WORKER RUNTIME      (microVM via msb, OR ACP for local CLI agents)
```

### Channel contract (the CC-aligned heart of the design)

Every spawn (= one worker invocation = one agent context window) sees **EXACTLY** these inputs and **NOTHING ELSE**:

1. **Agent system prompt** (from agent.md `system_prompt`)
2. **Rendered user prompt string** (the node's `prompt` field, with `{{ ... }}` interpolations resolved at render time)
3. **Tools list** (the 6 standard: Read/Edit/Write/Bash/Glob/Grep, allowlisted per agent)
4. **Optional workspace** (mounted as `/work`, when agent isolation = workspace)

Every spawn returns **EXACTLY**:
- Default: a **single string** (the final assistant text)
- With `output_schema` set: a **validated JSON object** per the schema (worker re-prompts on mismatch, errors after retry budget)

**No other channel exists.** Specifically:
- A spawn does NOT see the parent run's state, other nodes' outputs, the orchestrator's history, peer subagents' work, or any backend internal.
- Upstream node outputs reach downstream ONLY via **explicit prompt interpolation** the author wrote (`{{deps.upstream.output.field}}`). Author controls what crosses.
- The backend does NOT auto-dump dependencies into prompts. If you want B to see A's plan, write `{{deps.A.output.plan}}` in B's prompt. Otherwise B sees nothing about A.

This mirrors Claude Code Subagents exactly:
> "The only channel from parent to subagent is the Agent tool's prompt string, so include any file paths, error messages, or decisions the subagent needs directly in that prompt." — code.claude.com/docs/en/agent-sdk/subagents

> "A workflow script holds the loop, the branching, and the intermediate results itself, so Claude's context holds only the final answer. Intermediate results stay in script variables instead of landing in Claude's context." — code.claude.com/docs/en/workflows

The DAG-as-data equivalent: **the DAG holds intermediate state; spawn contexts only see what the author explicitly interpolated.**

### Why DAG-as-data, not workflow code

Every other durable workflow engine worth studying — Temporal, Restate, Inngest,
Prefect, LangGraph — and agent frameworks like Flue define workflows as **code** (a
function in a real language). That is the right choice when the workflow's author
is a **human writing it once, ahead of time**: developer ergonomics and expressive
control flow win, and the engine only has to durably run what was written.

Our author is different. The author is **Claude Code, re-planning a live run
mid-flight.** The headline requirement (§8.6) is: an hour into a run, with several
nodes already done, CC inspects progress and rewrites the *not-yet-executed* part —
effective immediately, without re-running what completed. That demands the
unexecuted plan be **inspectable, addressable, mutable state, stored separately
from the execution that already happened.**

- In a **code** model, "the rest of the workflow" is the continuation of the
  program — the remaining statements, the closure, the call stack. There is no
  first-class object named "node 7" to point at and rewrite; the future is implicit
  in control flow. This is exactly why every code engine can only "deploy new code
  → new runs only" (Temporal `patched()`, Step Functions, Restate deployment
  pinning) or "recompile the whole graph and resume the thread" (LangGraph). None
  lets you address and edit one future step of a live run, because that step is not
  a thing — it is a not-yet-reached point in code.
- In **DAG-as-data**, "node 7" is a row with a stable id and `status = pending`.
  Editing it is an ordinary data mutation; the reconciler reads the new data on its
  next pass. Live re-planning is not a workaround — it is the natural consequence of
  representing the plan as data.

So the data model is **not** a concession versus code; for this system's defining
capability it is the correct and essentially the only clean representation. The
cost of data — weaker expressiveness than a real language — is paid down by the
layering: **complex logic lives in CC (the brain) and in agent prompts, never in
the DAG.** Engines without a brain (Temporal, Camunda, Argo) are *forced* to grow a
DSL plus a code escape hatch (`rawscript`, Code node, script task) because nothing
above them can hold the logic. **CC is that escape hatch here — the structural
advantage this design must protect.** The rule that protects it: when a
`guard`/`until` expression (§5.2) wants arithmetic, string munging, or nested
conditionals, that logic belongs in CC or in an agent's prompt — never grow the
expression language into a programming language.

### The Execution Frontier (what is mutable)

Picture a run as a moving line — the **execution frontier** — separating what has
happened from what is planned. The frontier is the **dispatch boundary**: a node is
*ahead* of it until a worker has been handed its rendered prompt.

- **Ahead of the frontier** (`pending`, or `ready` but not yet dispatched): the
  **mutable plan.** Editable in place via `workflow.patch` (§8.6).
- **At / behind the frontier** (`running`/`done` + their artifacts): the
  **immutable journal.** Frozen (I5); outputs referenced by id.

This single line answers every "what can I change in a live run?" question:

| Want to change… | Node status | Mechanism |
|---|---|---|
| A future node not yet dispatched — its prompt, model, guard, deps, or the forward node set | `pending` / `ready` | **`workflow.patch`** — in place, live (§8.6) |
| A node already dispatched, or its produced output | `running` / `done` | **`run.fork`** — branch a new run, done artifacts reused as cache (§8.4) |

**Litmus test: is it ahead of the frontier? Yes → patch. At/behind → you cannot
edit it in place; fork instead.** "Patch the future, fork the past" is the whole
mutation story. Under concurrency the frontier is a **set, not a point** — with
`parallel_over` fan-out and implicit parallelism many nodes sit at the frontier at
once and it advances as each completes; §9 (Patch application & the moving
frontier) defines exactly which nodes are patchable as the set moves.

### Invariants (never broken)

| ID | Invariant |
|----|-----------|
| I1 | Worker intermediate output never enters CC's main context. CC sees results CC explicitly pulled. |
| I2 | Every spawn has its own context window. Spawn inputs limited to the 4 above; outputs limited to string or schema'd object. |
| I3 | Output discipline per spawn: bounded by `output_schema` (if set) and `max_summary_tokens` (always). Full content kept separate from summary. |
| I4 | Backend state is durable. Reconciler restart resumes any run. |
| I5 | Running or done nodes are immutable. Outputs referenced by ID. |
| I6 | Backend never inferences about tasks. No task state machine, no "task done" signal, no auto-summary at run boundary. |
| I7 | **No implicit cross-node data injection.** Author writes every `{{deps.X.output.Y}}` reference. Backend never auto-stuffs upstream output into downstream context. |
| I8 | Orchestrator is callable from any app (via MCP or A2A). No special knowledge of any dispatching app. |
| I9 | **Patch the future, fork the past.** Only nodes not yet dispatched to a worker (`pending`/`ready`) are mutable in place via `workflow.patch`. Nodes `running`/`done` and their artifacts are an immutable journal — change them only by `run.fork`. |

---

## 1. Architecture

```
┌────────────────────────────────────────────────────────────┐
│  User's local Claude Code (subscription)                    │
│   - Plans, decomposes, judges, course-corrects               │
│   - Reads/edits LOCAL files using CC's native tools          │
│   - Reaches orchestrator via MCP                             │
└────────────────────────┬──────────────────────────────────┘
                         │ MCP
                         ▼
┌────────────────────────────────────────────────────────────┐
│  App: orchestrator                                           │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ MCP Server (8 categories — §8)                        │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Reconciler (event-driven, per-run scope only)         │   │
│  │   - applies pending patches                           │   │
│  │   - computes ready nodes, dispatches                  │   │
│  │   - handles retry / timeout / cancel / pause          │   │
│  │   - DOES NOT auto-summarize. DOES NOT touch tasks.    │   │
│  │   - DOES NOT auto-inject deps into prompts.           │   │
│  └────────────────────────┬─────────────────────────────┘   │
│                           ▼                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Worker Dispatcher                                     │   │
│  │   - Resolves agent (.md) + engine/model               │   │
│  │   - RENDERS node.prompt with explicit {{ }} interp    │   │
│  │   - Routes to microVM OR ACP based on agent.runtime   │   │
│  │   - Validates output (schema if set + token cap)      │   │
│  │   - Persists artifact                                 │   │
│  └────────────────┬─────────────────────┬───────────────┘   │
│                   ▼                     ▼                    │
│  ┌──────────────────────────┐  ┌──────────────────────┐    │
│  │ microVM Pool (msb)        │  │ ACP Adapter           │    │
│  │  - prebaked alpine image  │  │  (framework           │    │
│  │  - warm pool of N idle    │  │   acp-adapter.ts)     │    │
│  │  - per-spawn 1 fresh VM   │  │  - drives local CC/   │    │
│  │  - workspace VMs are      │  │    Gemini-CLI/etc     │    │
│  │    long-lived per ws      │  │  - no VM              │    │
│  └──────────────────────────┘  └──────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Postgres — durable state                              │   │
│  │   workflow_templates, runs, nodes, spawns,            │   │
│  │   workspaces, patches, events                         │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
                           │
                           │ A2A inbound (optional)
                           ▼
              ┌──────────────────────────────────┐
              │ App: tracker / other apps        │
              │ dispatch workflows via A2A       │
              └──────────────────────────────────┘
```

Reuses framework facilities — does not reinvent:
- **Models** = framework's engine registry (`@agent-native/core/agent/engine`: `resolveEngine`).
- **Agents** = framework's `.claude/agents/*.md` subagent format + loader.
- **ACP** = framework's `acp-adapter` (upstream PR #1349).
- **Secrets vault** = framework's `app_secrets` + `resolveSecret`.
- **MCP exposure** = framework auto-mounts every `defineAction`.

---

## 2. Core Concepts

| Concept | Definition |
|---------|-----------|
| **Workflow Template** | Named, versioned DAG + input schema. Immutable. |
| **Run** | One execution instance of a DAG. Holds DAG snapshot + inputs + live state. Optional opaque `tags`. |
| **Node** | One unit in a DAG. Has a type (`agent`, `parallel_over`, `loop`, `human_gate`). |
| **Spawn** | One worker invocation. Smallest unit. May be ad-hoc (no run) OR a node's execution attempt. |
| **Spawn Context** | What the worker sees: agent system_prompt + rendered prompt + tools + optional workspace. NOTHING ELSE. |
| **Spawn Result** | What the worker returns: string (default) OR validated object (when output_schema set). |
| **Workspace** | Long-lived microVM with git checkout. Shared across spawns. Owned by a run or by CC ad-hoc. |
| **Agent** | A `.md` with YAML frontmatter declaring runtime/engine/model/tools/system_prompt. Reuses framework subagent format. |
| **Artifact** | A spawn's persisted result + metadata. May reference a separate full-content blob. |
| **Patch** | A mutation operation against a live run's DAG. Versioned, CAS-protected. |

---

## 3. Data Model

Postgres. Key fields only. Ownership scoping via framework `ownableColumns()` on rows noted.

```sql
workflow_templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  version         INT NOT NULL,
  description     TEXT NOT NULL,
  dag             JSONB NOT NULL,
  input_schema    JSONB NOT NULL,
  created_at      TIMESTAMPTZ,
  UNIQUE (name, version),
  ...ownableColumns()
)

runs (
  id              TEXT PRIMARY KEY,
  template_id     TEXT,
  template_version INT,
  inputs          JSONB NOT NULL,
  dag             JSONB NOT NULL,
  dag_version     INT NOT NULL DEFAULT 1,
  status          TEXT NOT NULL,
  priority        INT NOT NULL DEFAULT 0,
  tags            JSONB,                   -- opaque: {source: "tracker", item_id: ...}
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  ...ownableColumns()
)

nodes (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  node_id_in_dag  TEXT NOT NULL,
  type            TEXT NOT NULL,
  status          TEXT NOT NULL,
  iteration       INT NOT NULL DEFAULT 0,
  fanout_index    INT NOT NULL DEFAULT 0,
  current_spawn_id TEXT,
  output_artifact_id TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error           TEXT,
  UNIQUE (run_id, node_id_in_dag, iteration, fanout_index)
)

spawns (
  id              TEXT PRIMARY KEY,
  node_id         TEXT,                    -- NULL for ad-hoc spawns
  attempt         INT NOT NULL,
  agent_name      TEXT NOT NULL,
  engine_ref      TEXT,                    -- NULL when runtime is acp
  model_ref       TEXT,                    -- NULL when runtime is acp
  runtime         TEXT NOT NULL,           -- "microvm" | "acp:<runtime>"
  workspace_id    TEXT,
  rendered_prompt TEXT NOT NULL,           -- the FULL prompt string sent (post-interpolation)
  vm_name         TEXT,
  acp_session_id  TEXT,
  status          TEXT NOT NULL,
  output_artifact_id TEXT,
  output_kind     TEXT,                    -- "string" | "object"
  tokens_input    INT,
  tokens_output   INT,
  latency_ms      INT,
  error           TEXT,
  error_class     TEXT,
  tags            JSONB,                   -- opaque: {source: "tracker", item_id: ...}
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  ...ownableColumns()
)

artifacts (
  id              TEXT PRIMARY KEY,
  spawn_id        TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- spawn-output | workspace-diff | committed-pr
  -- One of:
  text_content    TEXT,                    -- for output_kind="string"
  object_content  JSONB,                   -- for output_kind="object" (schema-validated)
  full_content_ref TEXT,                   -- pointer to large blob (FS/S3) when separated
  byte_size       INT NOT NULL,
  truncated       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ
)

workspaces (
  id              TEXT PRIMARY KEY,
  owner_kind      TEXT NOT NULL,           -- run | cc
  owner_id        TEXT,
  tags            JSONB,                   -- opaque: {source: "tracker", item_id: ...}
  vm_name         TEXT NOT NULL,
  repo_url        TEXT NOT NULL,
  branch          TEXT NOT NULL,
  state           TEXT NOT NULL,           -- live | destroyed
  created_at      TIMESTAMPTZ,
  destroyed_at    TIMESTAMPTZ,
  created_by      TEXT NOT NULL
)

patches (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL,
  dag_version_before INT NOT NULL,
  dag_version_after  INT NOT NULL,
  patch_ops       JSONB NOT NULL,
  actor           TEXT NOT NULL,
  reason          TEXT,
  applied         BOOLEAN NOT NULL,
  applied_at      TIMESTAMPTZ
)

events (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  spawn_id        TEXT,
  kind            TEXT NOT NULL,
  payload         JSONB NOT NULL,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

**Notable decisions:**
- `spawns.rendered_prompt` stores the EXACT string sent to the worker (post-`{{ }}` interpolation). Reproducibility + debugging.
- `artifacts` split `text_content` / `object_content` by `output_kind` — type-safe storage.
- No `agents` table (use framework subagents).
- No `models` table (use framework engine registry).
- No `tasks` table (intent lives outside).

---

## 4. DAG Node Types

**4 types core + 1 optional.** Covers all CC native workflow capabilities. Implicit parallelism via deps. Conditional execution via `guard`.

### Shared by all node types

```jsonschema
{
  "id":    "string (unique within DAG)",
  "type":  "agent | parallel_over | loop | human_gate",
  "deps":  ["upstream_id", ...],       // optional; empty = no upstream
  "guard": "<expression>"              // optional; false → skip + cascade
}
```

**`guard` replaces the old `branch` node type.** When false, the node is `skipped` AND any downstream that depends ONLY on skipped nodes cascades to `skipped`. Two paths from same upstream = both are nodes with opposite guards:

```json
{ "id": "commit", "deps": ["review"],
  "guard": "deps.review.output.verdict == 'pass'" }
{ "id": "fix",    "deps": ["review"],
  "guard": "deps.review.output.verdict != 'pass'" }
```

### 4.1 `agent` — the only work-doing node

```json
{
  "id": "design",
  "type": "agent",
  "agent": "designer",                    // REQUIRED: .claude/agents/<name>.md
  "prompt": "Requirement: {{inputs.req}}\nProduce a plan.",   // REQUIRED: template

  "deps":            ["..."],             // optional
  "guard":           "...",               // optional
  "workspace":       "ws_id",             // optional: mount shared workspace
  "output_schema":   { ... },             // OPTIONAL — see §6
  "max_summary_tokens": 2000,             // optional, defaults to agent.md value
  "engine_override": "...",               // optional: override agent.md engine
  "model_override":  "...",               // optional: override agent.md model
  "retry":           { "max": 2, "on": [...] },  // optional
  "timeout_seconds": 600                  // optional
}
```

**Required fields are exactly 4:** `id`, `type`, `agent`, `prompt`. Everything else has defaults (from `agent.md` or from `runs.dag` defaults).

**Output:**
- Without `output_schema`: returns a **string** (the final assistant text).
- With `output_schema`: returns a **validated object** per the schema.

### 4.2 `parallel_over` — dynamic fanout

```json
{
  "id": "impl",
  "type": "parallel_over",
  "deps": ["design"],
  "items_from": "deps.design.output.files",   // expression yielding array
  "max_concurrency": 4,
  "body": { "type": "agent", "agent": "impl", "prompt": "Impl {{item}}" }
}
```

- Evaluates `items_from` → array of items.
- For each item, spawns one `body` instance with `{{item}}` available in template interpolation.
- Body is just an `agent` node (no further nesting).
- **Output**: array of body outputs in item order. Type:
  - If body has no `output_schema`: `string[]`
  - If body has `output_schema`: `T[]`
- **Patchability (mid-run):** `items_from` is evaluated once when deps complete and
  the item set is then frozen. A `modify_node` on `body` reaches item instances not
  yet dispatched; already-dispatched instances and the item set itself are behind
  the frontier — to change the set, `run.fork`. See §9 (Patch application & the
  moving frontier).

### 4.3 `loop` — iteration

```json
{
  "id": "fix_loop",
  "type": "loop",
  "deps": ["review"],
  "body": ["fix", "retest", "rereview"],     // node ids run sequentially per iter
  "until": "deps.rereview.output.verdict == 'pass'",
  "max_iterations": 3
}
```

- Each iteration runs `body` node ids in order.
- After iteration completes, evaluate `until`. True → exit. False → next iteration.
- `iteration` (current iter number, 0-indexed) available in template interpolation.
- Previous iteration's body node outputs available as `deps.NODE.previous_iteration.output`.
- **Output**: same type as the **last body node's output** at the iteration that satisfied `until` (or last attempted if max_iterations hit).
- Additional accessible from outside: `deps.LOOP.iterations` (count), `deps.LOOP.history[i].NODE.output` (per-iter per-node).
- **Patchability (mid-run):** the iteration currently executing is behind the
  frontier (immutable); body-node edits and `modify_loop` (`until`,
  `max_iterations`) take effect at the next iteration boundary. See §9 (Patch
  application & the moving frontier).

### 4.4 `human_gate` — pause for approval (optional)

```json
{
  "id": "approve",
  "type": "human_gate",
  "deps": ["review"],
  "prompt": "Review verdict: {{deps.review.output.verdict}}. Approve?",
  "options": ["approve", "reject", "modify"],
  "timeout_seconds": 86400
}
```

- Reconciler sets status `awaiting-approval`, emits event.
- CC (or human) resolves via `node.resolve_gate(runId, nodeId, choice, note?)`.
- Timeout = `reject`.
- **Output**: fixed shape `{ choice: <one of options>, note: string | null }`.

### Implicit parallelism — no `parallel` node needed

Several nodes with the same `deps` set are naturally concurrent. No primitive needed.

### Removed from earlier drafts

- `start` / `end` — scheduler handles. Reconciler dispatches all `pending` nodes with satisfied deps; run terminates when all nodes terminal.
- `parallel` — implicit via deps.
- `branch` — replaced by `guard` field on each node.
- `subworkflow` — CC composes by calling `workflow.run` from one node's prompt-driven action OR via ad-hoc spawn. Not a node type.

---

## 5. Prompt Templates and Expressions

Two distinct surfaces, sharing path syntax:

### 5.1 Prompt Templates — `{{ ... }}` interpolation

Used in: `prompt` field of `agent` / `human_gate` nodes; `body.prompt` of `parallel_over`.

Renderer substitutes `{{ ... }}` at render time (right before spawn dispatch). Only this rendered string crosses into the spawn (channel contract §0).

**Supported expressions inside `{{ }}`:**

- **Path lookup:** `inputs.X`, `deps.NODE.output[.path]`, `item`, `iteration`, `deps.NODE.previous_iteration.output[.path]`, `deps.NODE.iterations`, `deps.NODE.history[i].NODE2.output[.path]`
- **Functions** (optional, for convenience): `len(x)`, `coalesce(a, b)`
- **Plain literal** in expressions: numbers, booleans, single/double-quoted strings

**Interpolation rules:**

| Resolved type | Rendered as |
|---|---|
| `string` | inserted verbatim |
| `number` / `boolean` / `null` | inserted as literal |
| `object` / `array` | inserted as compact `JSON.stringify(...)` |
| `undefined` (path doesn't resolve) | **render fails** → node `schema-violation` → retry per policy |

Example:
```
"Requirement: {{inputs.requirement}}\nPrior plan: {{deps.design.output.plan}}\nFiles to touch ({{len(deps.design.output.files)}}): {{deps.design.output.files}}"
```

### 5.2 Condition Expressions

Used in: `guard`, `until`, `items_from`, and the future top-level `condition` fields.

**Supported (small + safe, NOT JavaScript):**

- All template path lookups (above)
- **Operators:** `==`, `!=`, `>`, `>=`, `<`, `<=`, `&&`, `||`, `!`
- **Functions:** `len(x)`, `contains(arr, x)`, `startsWith(s, p)`, `endsWith(s, p)`, `exists(path)`, `coalesce(a, b, ...)`
- Literals: string (`"..."` or `'...'`), number, boolean, null

**Forbidden:** function definitions, IO, object method calls, member assignment, control flow keywords. Anything outside grammar rejected at template save AND at run start.

Examples:
```
deps.review.output.verdict == "pass"
len(deps.design.output.files) > 0 && inputs.dryRun != true
iteration < 3 && contains(deps.test.output.failed_tests, "auth")
coalesce(deps.rereview.previous_iteration.output.feedback, deps.review.output.feedback)
```

Implementation: ~50 LOC tokenizer + recursive-descent evaluator. No `eval`. Shared between template renderer (5.1) and condition evaluator (5.2).

### 5.3 Optional: static reference lint at template save

When `workflow.save` is called, the parser may walk every `{{ ... }}` and condition expression and report references that don't resolve given upstream schemas. **This is a warning, not a blocker** — many references resolve only at runtime (e.g. `deps.X.previous_iteration` exists only inside loops). Saves help authors but template still saves with warnings.

---

## 6. Inter-Node Data Flow (CC-Aligned)

**This is the most important section. Read carefully.**

Modeled on Claude Code's Dynamic Workflow runtime. Same contract.

### 6.1 Spawn input = ONE channel = prompt string

A spawn (= one worker invocation) sees:

1. **Agent's `system_prompt`** (static, from agent.md)
2. **Rendered `prompt` string** (from the node's `prompt` field after `{{ }}` resolution)
3. **Tools allowlist** (the 6 standard)
4. **Workspace** (`/work` mount when `isolation: workspace`)

It does NOT see:
- The DAG. Other nodes. Other nodes' outputs (unless explicitly interpolated into prompt). Run-level state. Backend state. Peer spawns. Parent CC session. Prior turns. Anything else.

This means: **author controls what each spawn sees by writing `{{ }}` references in its prompt**. No auto-injection. Exactly like CC subagents.

### 6.2 Spawn output = string OR validated object

**Default = string.** The agent's final assistant message text, captured and stored verbatim. No parsing.

```json
{ "type": "agent", "agent": "summarizer", "prompt": "Summarize: {{inputs.text}}" }
// output: "The text discusses..."   ← raw string
```

**Opt-in structured = JSON object.** Set `output_schema` (JSON Schema subset). The worker:
1. Renders agent system_prompt + appends a structural directive: "Respond with ONLY JSON matching the following schema: <schema>. Field meanings from `description`: <list>."
2. Runs the agent loop.
3. Parses the final assistant text as JSON.
4. Validates against schema with `ajv`.
5. On mismatch: ONE internal self-correction attempt (re-prompt the model with the violation), then return `schema-violation` to dispatcher (retryable per node policy).
6. On success: returns the parsed object as the spawn output.

```json
{
  "type": "agent", "agent": "reviewer",
  "prompt": "Review diff: {{deps.impl.output}}",
  "output_schema": {
    "type": "object",
    "properties": {
      "verdict":  { "type": "string", "enum": ["pass", "fail"],
                    "description": "Final verdict" },
      "feedback": { "type": "string", "maxLength": 500,
                    "description": "If fail, what to fix next round" }
    },
    "required": ["verdict"]
  }
}
// output: { "verdict": "pass", "feedback": "" }   ← validated object
```

### 6.3 Schema language (JSON Schema subset)

| Keyword | Supported |
|---|---|
| `type` | string, number, integer, boolean, array, object, null |
| `properties` + `required` | yes (object) |
| `items` | yes (array, homogeneous element schema) |
| `enum` | yes |
| `minLength` / `maxLength` | yes (string) |
| `minimum` / `maximum` | yes (number) |
| `description` | yes — **doubles as instruction for the model** (fed into the structural directive prompt) |
| `oneOf` / `anyOf` / `allOf` / `$ref` / regex `pattern` / conditionals | **No** |

Keep schemas small enough to fit in a prompt suffix and for the model to reliably follow. Schema validation is the **runtime** layer — not the LLM tool layer (mirrors CC: the `Agent` tool itself has no `output_schema`; the workflow runtime layer adds it).

### 6.4 How downstream reads upstream — only via prompt interpolation

Author writes explicit references in the downstream prompt:

```json
{
  "id": "impl",
  "type": "agent",
  "agent": "implementer",
  "deps": ["design"],
  "prompt": "Implement per plan: {{deps.design.output.plan}}\nFiles to touch: {{deps.design.output.files}}"
}
```

This is the ENTIRE data-passing mechanism. The reconciler renders the prompt by:
1. Resolving each `{{ ... }}` against `{ inputs, deps, item, iteration }`.
2. Substituting per §5.1 rules.
3. Storing the final rendered string in `spawns.rendered_prompt`.
4. Handing that string + the agent's system_prompt + tools to the worker.

The worker NEVER sees the raw `deps` map or any other state. Only the rendered prompt.

### 6.5 No auto-dump

The backend does NOT automatically append a "Dependency outputs: ...JSON dump..." block to any prompt. (Earlier prototypes did. They violated the channel contract. Removed.) If you want a spawn to see something, write it into its prompt explicitly.

### 6.6 How large outputs work without polluting context

A spawn may produce up to `max_summary_tokens` worth of "summary" (the validated object or the captured text). That's what gets stored as the artifact's `text_content` / `object_content` AND what `{{deps.X.output}}` interpolates into downstream prompts.

**Full content separation:** if the agent wrote large secondary outputs (full git diff, raw log), the agent itself should put them on the filesystem (workspace) and reference paths in its summary. CC can pull workspace contents separately via `workspace.diff` / `workspace.files` / `workspace.read`. Those don't auto-cross into spawn contexts.

Concrete example: a `code-search` agent grepping 50 files might find 200 results. Its prompt instructs it to summarize: "Output `{matches: Array<{path,line,context}>}` with at most 20 entries; if more found, set `truncated: true` and put the full list in `/work/_orchestrator/full_matches.json`." The 20-entry summary goes downstream via `{{deps.code-search.output.matches}}`; downstream prompts also tell THEIR agent to read the full file if needed.

CC's mental mapping:
- CC's workflow `await agent("...")` → our `agent` node, default string output
- CC's `await agent("...", { schema })` → our `agent` node with `output_schema`
- CC's `\`Use A: ${JSON.stringify(a)}\`` → our `{{deps.A.output}}` interpolation
- CC's `\`Field X: ${a.field}\`` → our `{{deps.A.output.field}}`
- CC's variable scope = our DAG-as-data state (reconciler holds it)
- CC's subagent isolation = our spawn channel contract

---

## 7. Agent & Model Resolution (Reuses Framework)

### 7.1 Agents = framework `.claude/agents/*.md`

```markdown
---
name: implementer
description: |
  Implements one file per the design plan. Returns a brief change summary.
runtime: microvm                  # microvm | acp:<runtime>
engine: ai-sdk:openai             # framework engine id (microvm only)
model: qwen3.6                    # upstream model id (microvm only)
tools: [Read, Edit, Write, Bash, Glob, Grep]
isolation: workspace              # workspace | none
max_summary_tokens: 2000
---

You are a backend implementation agent operating inside an isolated workspace.

Inputs you'll receive in the user-turn prompt:
- A design plan.
- A target file path.

Task: implement the target file strictly per the plan. Use Read/Edit/Write/Bash
tools. After your change, run `git --no-pager diff <file>` to self-verify.

Constraints:
- Only modify the target file.
- Do not modify other files.

When done, reply with a concise summary (<200 words).
```

Orchestrator additions to framework subagent format:

| Field | Required | Meaning |
|-------|----------|---------|
| `runtime` | yes | `microvm` (default) OR `acp:<runtime>` (drives local CLI agent) |
| `engine` | yes (microvm) | Framework engine id (`ai-sdk:openai`, `anthropic`, etc.) |
| `model` | yes (microvm) | Upstream model id |
| `isolation` | yes | `workspace` or `none` |
| `max_summary_tokens` | no | Default 2000 |

Tools: same six as CC native — `Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep`.

Agent precedence: project `.claude/agents/` > orchestrator app `agents/` > framework default.

### 7.2 Models = framework engine registry

No orchestrator-local models table. The orchestrator calls framework `resolveEngine(engine_id, ...)` and gets back a callable.

Common engine ids:
- `anthropic`, `ai-sdk:anthropic` — Anthropic API
- `ai-sdk:openai` — OpenAI API OR any OpenAI-compatible (e.g. vLLM via `OPENAI_BASE_URL` env)
- `ai-sdk:google`, `ai-sdk:groq`, ... — others as framework supports

API keys: framework `app_secrets` vault + `resolveSecret`.

### 7.3 ACP runtime

When `runtime: acp:claude-code` (or `acp:gemini-cli` / etc.), the spawn dispatches via framework's `acp-adapter`. Local agent runs on the user's machine using its own auth (subscription, API key, etc.).

- One spawn = one ACP session.
- Session state via framework `agent_harness_sessions` table.
- Workspace maps to ACP's `isolation: worktree` when `agent.isolation: workspace`.
- Channel contract still holds: only the rendered prompt crosses in.

---

## 8. MCP Surface — CC's Toolbox

### 8.1 Ad-hoc Spawn (the lightweight delegation primitive)

```
spawn.once({
  agent: "name",
  engine_override?: "...",
  model_override?: "...",
  runtime_override?: "microvm" | "acp:claude-code",
  prompt: "...",                   -- post-render-ready, no interpolation here (no DAG context)
  workspace?: <workspaceId>,
  output_schema?: { ... },
  max_summary_tokens?: 500,
  timeout_seconds?: 60,
  retry?: { max: 2, on: ["transient"] },
  tags?: { source: "...", ... },
  async?: false
})
  → if async=false: { spawnId, output, output_kind, tokens_*, latency_ms }
    if async=true:  { spawnId } (poll spawn.get)

spawn.get(spawnId)
spawn.cancel(spawnId)
spawn.log(spawnId)

spawns.list({ status?, agent?, runtime?, tag_match?, since?, limit?, offset? })
  → [ { spawnId, agent_name, runtime, status, tags, started_at, completed_at,
        tokens_*, latency_ms, error? } ]
  -- IMPORTANT: tag_match filters by partial-match on tags JSONB.
  -- e.g. tag_match: { source: "tracker", item_id: "PAY-14" } returns ALL spawns
  -- (ad-hoc OR run-node) whose tags include those keys with matching values.
  -- This is how dispatching apps surface "all spawns for this item".
```

For ad-hoc spawns, the caller (CC) provides the full prompt — no `{{ }}` interpolation (no DAG state to resolve from). CC just hand-builds the string.

### 8.2 Workspace

```
workspace.create({ repo, branch?, owner_kind: "cc"|"run", owner_id?, tags? })
  → { workspaceId, vm_name }
workspace.list({ owner_kind?, owner_id?, state?, tag_match? })
  → [ { workspaceId, owner_kind, owner_id, repo, branch, state, tags, created_at } ]
workspace.diff(workspaceId, { against? })
workspace.files(workspaceId, { path? })
workspace.read(workspaceId, path)
workspace.commit_push(workspaceId, { message, push_branch? })  → { sha, branch, pushed, pr_url? }
workspace.destroy(workspaceId)
```

Lifecycle: `run`-owned destroyed on run terminal (unless `keep_after_run: true`); `cc`-owned destroyed only by explicit call.

### 8.3 Workflow Templates

```
workflow.list()
workflow.get(name | id, version?)
workflow.save({ name, dag, input_schema, description? })  → { id, version }
workflow.delete(name | id)
```

`save` validates DAG schema + expression syntax + (optional) reference lint warnings.

### 8.4 Run lifecycle

```
workflow.run({
  template?: { name, version? } | id,
  dag?: <DAG JSON>,
  inputs: { ... },
  tags?: { ... },
  priority?: 0
})  → { runId, dag_version: 1 }

runs.list({ status?, owner?, template?, tag_match?, since?, limit?, offset? })
run.state(runId)
run.summary(runId)                       -- on-demand only; not auto-computed
run.events(runId, since?)                -- SSE stream
run.cancel(runId) / run.pause(runId) / run.resume(runId) / run.priority(runId, value)
run.fork(runId, { modifications?, new_inputs? })  → { newRunId }
```

`run.fork`: creates new run starting from current `runId`'s state. Already-completed nodes contribute their artifacts as cache: a fork node with same node_id + type + iteration + fanout_index reuses the original's artifact instead of re-spawning.

### 8.5 Node operations within a run

```
node.summary(runId, nodeId, { include?: ["full_diff", "full_log", "schema"] })
node.spawn_log(runId, nodeId, attempt?)
node.retry(runId, nodeId)
node.skip(runId, nodeId)
node.resolve_gate(runId, nodeId, choice, note?)
```

### 8.6 Patch (mutation) — live re-planning of the unexecuted future

**The headline capability.** While a run is in flight, CC rewrites the part of the
DAG **ahead of the execution frontier** (§0) — a future node's prompt, model,
guard, or deps; add or remove future nodes; adjust loop bounds; or replace the
whole forward plan — and it takes effect on the reconciler's next pass (see §9,
Patch application & the moving frontier), **without cancelling or re-running** what
already completed. Nodes at or behind the frontier are immutable (I5/I9); to change
those, `run.fork` (§8.4).

```
workflow.patch(runId, expected_dag_version, ops[])
  → { new_dag_version }
  | { error: "version_conflict", current_dag_version: N }
  | { error: "node_not_patchable", node_id: "...", status: "running" | "done" }
```

```json
[
  { "op": "modify_node", "node_id": "review", "set": { "prompt": "...", "guard": "...", "deps": ["..."], "model_override": "..." } },
  { "op": "add_node", "node": { ...node json... } },
  { "op": "remove_node", "node_id": "extra_lint" },
  { "op": "modify_loop", "node_id": "fix_loop", "set": { "max_iterations": 5, "until": "..." } },
  { "op": "replace_dag", "new_dag": <complete DAG JSON> }
]
```

**Patchability is decided by the frontier — whether a node has been dispatched to a
worker:**

| Node status | Patchable? | Behavior on patch |
|---|---|---|
| `pending` (deps not all done) | YES | edited in place |
| `ready` (deps done, queued, **not yet dispatched**) | YES | atomically demoted to `pending`, edited, re-evaluated next pass |
| `running` (worker dispatched) | NO | rejected `node_not_patchable`; use `run.fork` |
| `done` / `failed` / `skipped` | NO | rejected; immutable journal (I5) |

Rules:
1. **CAS** via `expected_dag_version`. On mismatch → `version_conflict` with the
   current version; CC re-reads (`run.state`) and rebuilds the patch — patches are
   optimistic (retry contract in §9).
2. `modify_node` / `remove_node` apply only to nodes not yet dispatched (`pending`,
   or `ready` which is demoted first). `running` / `done` → `node_not_patchable`.
3. `add_node`: `deps` must reference existing nodes; no cycle. A new node whose deps
   are already `done` becomes `ready` on the next pass.
4. `replace_dag`: every `running` / `done` node MUST appear in `new_dag` with the
   SAME `node_id_in_dag` + `type` (their artifacts are referenced by id, I5); the
   forward portion may be restructured freely.
5. Loop / `parallel_over` mid-run scoping is defined in §9 (Patch application & the
   moving frontier).
6. Success: validate (DAG schema + expression syntax, §5) in one transaction;
   `dag_version += 1`; insert `patches` row; emit `patch_applied`; enqueue a
   reconcile event.

### 8.7 Pool / Dispatch Inspection

```
pool.status()
  → { vms: { warm_idle, busy, capacity, queue_waiting }, ... }
dispatch.queue({ runId? })
  → [ { runId, nodeId, queued_at, waiting_for: "vm"|"acp"|"deps"|"approval" } ]
```

### 8.8 Not exposed

- No `agents.*` actions — use framework subagent management.
- No `models.*` actions — use framework engine config.
- No `task.*` actions — task concept lives outside.

---

## 9. Reconciler Behavior

Scope = exactly one run. Never thinks about tasks. Never auto-summarizes.

### Event triggers (per run)

`run_started`, `node_completed`, `patch_applied`, `node_resolved`, `timer`, `cancellation_requested`, `pause_requested`, `resume_requested`.

### Decision loop

```
on event(run_id):
  load run + dag + nodes_state in one transaction
  if run.status in {paused, cancelled, done, failed}: return

  # 1. Apply newly accepted patches.

  # 2. Compute ready set.
  for node in dag.nodes:
    if node.status != "pending": continue
    if not deps_all_done(node): continue
    if node.guard and not eval_condition(node.guard, ctx):
      node.status = "skipped"; emit node_skipped; cascade
      continue
    node.status = "ready"; emit node_ready

  # 3. Dispatch ready, respecting per-container max_concurrency, pool capacity, priority.
  for node in ready_queue ordered by (run.priority desc, node.queued_at asc):
    if global_busy >= pool_capacity: break
    render_prompt(node)              # §5.1 + §6.4: interpolate {{ }}
    dispatch(node)                   # → Worker Dispatcher

  # 4. spawn_done handler:
  on spawn_done(node, output, output_kind):
    if node.output_schema:
      validate output against schema (ajv)
      if violation:
        if retry remaining: re-spawn with corrective prompt
        else: node.status = failed
        return
    truncate to max_summary_tokens
    persist artifact { text_content | object_content, full_content_ref? }
    node.status = done; emit node_done
    enqueue reconcile event

  on spawn_failed(node, err):
    err_class = classify(err)
    if err_class in node.retry.on and attempt < node.retry.max:
      re-spawn with backoff
    else:
      node.status = failed; emit node_failed
      enqueue reconcile event

  # 5. Special node-type handling.
  # parallel_over: eval items_from when deps done, fanout body per item
  # loop: spawn body[0] on iteration entry; after body[last] done, eval until
  # human_gate: status = awaiting-approval, emit event
  # (no parallel / branch / start / end / subworkflow types per §4)

  # 6. Termination.
  if all nodes terminal:
    if any node failed AND no on_failure: continue:
      run.status = failed
    else:
      run.status = done
    emit run_done / run_failed
    # NO auto-summary. CC pulls run.summary on demand.
```

### Restart safety

On startup: scan `runs.status in (pending, running, paused)`.
- Load full state.
- For each in-flight spawn: check VM/ACP session liveness. If dead, mark spawn `cancelled`, re-evaluate node retry.
- Resume.

### Patch application & the moving frontier

`patch_applied` is a reconcile trigger. On that pass the reconciler re-reads the DAG
at its new `dag_version`, recomputes the ready set against the **edited** node
definitions, and renders prompts from the new `prompt`/`deps`. Nodes already
dispatched are untouched. So **"real-time" means effective on the next reconcile
tick** — bounded by the per-run single-writer loop, typically milliseconds. Only
nodes ahead of the frontier are affected; the executed journal is never replayed or
recomputed.

**The frontier is a set, not a point.** With `parallel_over` fan-out and implicit
parallelism, many nodes run at once and the frontier advances as each finishes. A
patch is applied atomically against `expected_dag_version`, and each target node's
*current* status is re-checked inside that transaction (§8.6 rule 2): a node that
slipped `pending`→`running` between CC's read and the patch is rejected
(`node_not_patchable`), never silently raced.

**Loop mid-run.** A `loop` re-instantiates its body ids each iteration (distinct
`iteration` index). The iteration currently executing is behind the frontier —
immutable. Edits take effect at the **next iteration boundary**:

- `modify_node` on a body node → applies when that node is next instantiated; the
  in-flight iteration finishes on the old definition.
- `modify_loop` (`until`, `max_iterations`) → evaluated at the next `until` check.
  Lowering `max_iterations` below the current `iteration` ends the loop after the
  current iteration completes; it never aborts the running iteration.

**`parallel_over` mid-run.** `items_from` is evaluated once when deps complete; the
item set is then **frozen** (part of the journal).

- Item instances already dispatched (`running`/`done`) are behind the frontier —
  immutable.
- Item instances not yet dispatched follow the node's `body` template; a
  `modify_node` on the body applies to them, in item order.
- To change the item **set** after expansion has begun you cannot patch it — use
  `run.fork` with a modified `items_from`, or model the item list as its own
  upstream node you patch *before* it expands.

**`guard` mid-run.** A guard is evaluated when its node becomes ready. Editing a
pending node's `guard` takes effect at that node's ready-time; if its deps are
already `done`, on the next pass.

**CC's optimistic-concurrency contract.** Patching is read-modify-write under CAS,
against a live, advancing run:

1. `run.state(runId)` → note `dag_version` + node statuses.
2. Build ops targeting only nodes still ahead of the frontier.
3. `workflow.patch(runId, dag_version, ops)`.
4. On `version_conflict` (run advanced) or `node_not_patchable` (a target was
   dispatched meanwhile) → return to step 1 and rebuild. CC must not hold a patch
   open as if it were a long transaction.

### Worked example — re-planning a run that is already an hour in

A `code-change-with-review` run at `dag_version: 3`, started 1h ago: `design` ✅,
`impl` ✅, `test` ✅ done; `review` 🟢 running; ahead and `pending`: `commit`
(guard `verdict == 'pass'`), `fix` (guard `verdict != 'pass'`), `deploy`. CC learns
the release target changed and a security scan must precede commit — and patches
**only the future**:

```
run.state("run_abc")
// → dag_version 3 · review: running · commit/fix/deploy: pending

workflow.patch("run_abc", 3, [
  { "op": "modify_node", "node_id": "commit",
    "set": { "prompt": "Commit to release/v2 (NOT main):\n{{deps.impl.output}}" } },

  { "op": "add_node", "node": {
      "id": "sec_scan", "type": "agent", "agent": "security-reviewer",
      "deps": ["impl"], "guard": "deps.review.output.verdict == 'pass'",
      "prompt": "Scan this diff for secrets/SQLi:\n{{deps.impl.output}}",
      "output_schema": { "type": "object",
        "properties": { "safe": { "type": "boolean" } }, "required": ["safe"] } } },

  { "op": "modify_node", "node_id": "commit",
    "set": { "deps": ["review", "sec_scan"],
             "guard": "deps.review.output.verdict == 'pass' && deps.sec_scan.output.safe == true" } }
])
// → { new_dag_version: 4 }
```

`review` was running, so it is untouched and runs to completion on the old plan.
When it finishes, the reconciler reads `dag_version 4`: `sec_scan` (its dep `impl`
already done) becomes ready and runs; `commit` now waits on both `review` and
`sec_scan` and fires only if review passed AND the scan is safe. The hour of
completed work was never re-run. Had CC instead needed to change `impl` (already
`done`, behind the frontier), the patch is rejected — that is `run.fork` territory:
branch a new run with a modified `impl`, reusing `design`'s artifact as cache.

---

## 10. Worker Lifecycle (microVM + ACP)

### 10.1 Runtime selection (per agent.md)

| Runtime | Backend |
|---------|---------|
| `microvm` | msb microVM pool |
| `acp:<runtime>` | Framework ACP adapter, drives local install |

### 10.2 microVM pool

- Pre-warm N microVMs (default 4).
- Prebaked image: alpine + git + nodejs + ca-certificates + worker-shim.js.
- Built once via `msb snapshot`. Avoids per-spawn 30-60s install.
- Acquire: mark busy. Release: **always destroy** (VMs single-use).
- Pool replenishes async.
- Exhausted: spawn waits `pool_acquire_timeout_seconds` (default 120), then `transient` error.

### 10.3 microVM single-spawn lifecycle

```
1. Dispatcher receives spawn (ad-hoc or run-node, post-prompt-render).
2. Resolve:
   - agent (.md) via framework loader → tools, system_prompt, isolation, engine, model
   - engine via resolveEngine → callable info (base_url, model_id, api_key_env)
   - workspace VM if isolation=workspace
3. Acquire warm VM from pool.
4. Prepare spawn-spec.json:
   {
     "agent": { system_prompt, tools },
     "engine": { type, base_url, model_id },
     "prompt": "<the RENDERED prompt string, ready to send>",
     "tools": ["Read","Edit","Write",...],
     "workspace": { "mountedAt": "/work" } | null,
     "output_schema": {...} | null,
     "max_summary_tokens": 2000,
     "secrets_env": ["OPENAI_API_KEY", "GITHUB_TOKEN"]
   }
5. msb exec <vm> -- node /opt/worker-shim/index.js < spawn-spec.json
6. Worker shim runs the agent loop, writes /tmp/output.json:
   { "kind": "string"|"object", "value": <string or object> }
7. Dispatcher reads, validates against schema (if set), truncates, persists artifact.
8. Dispatcher destroys VM.
9. Reconciler / caller notified.
```

### 10.4 Worker shim

Node.js bundled with prebaked image.

#### Engine: `anthropic`
- `@anthropic-ai/sdk`.
- Agent loop: send messages with tool definitions; tool_use → execute → tool_result; repeat to end_turn.

#### Engine: `ai-sdk:openai` (and other ai-sdk providers)
- `openai` SDK pointed at base_url.
- Same loop with OpenAI tools/tool_calls schema.
- Shim translates Anthropic-style tool defs to OpenAI function format.

#### Tools
`Read`, `Edit`, `Write`, `Bash`, `Glob`, `Grep` — same as CC native. Paths resolved within /work, no symlink escape.

#### Output extraction

**Default (no schema):** captured assistant final text → spawn output kind = "string".

**With schema:**
- Worker appends a structural directive to system prompt: `"Respond with ONLY JSON matching this schema: <serialized schema>. Field meanings: <each field's description>."`
- After agent loop ends, parse the final assistant text as JSON.
- Validate with `ajv`.
- On violation: ONE self-correction attempt with violation feedback in a new user turn. If still failing, return `{ kind: "schema-violation", attempted: <raw> }`.
- Dispatcher classifies as `schema-violation`.

### 10.5 ACP path

For `runtime: acp:<runtime>`:

1. Dispatcher invokes `startAgentHarnessRun` with adapter from `resolveAgentHarness("acp:<runtime>")`.
2. Adapter drives local agent via ACP.
3. Final result collected as spawn output (same string-or-object contract).
4. Session state persisted (framework `agent_harness_sessions`).

Workspace handled via ACP's `isolation: worktree` when agent.isolation = workspace.

### 10.6 Workspace VMs (long-lived)

- `workspace.create` → acquire VM, git clone, leave running.
- Spawns with `workspace: <id>` mount `/work`.
- Destroyed by owner lifecycle.
- Multi-spawn writes serialized per-workspace (dispatcher queues).

---

## 11. Output Discipline

Three layers — ALL operate per-spawn, NEVER auto-synthesize across spawns.

### Layer 1: Agent system prompt
The agent.md system_prompt instructs the agent to be concise. Soft layer.

### Layer 2: Output schema (optional)
When set, the worker validates output structure and field constraints. Violations retryable.

### Layer 3: Token cap (always)
`max_summary_tokens` is a hard ceiling. Over → truncate + `truncated: true` flag + `summary_truncated` event. Both string outputs and object outputs are size-capped (the JSON-serialized form for objects).

### Full content separation

If the agent needs to leave large secondary outputs (full diff, raw log, generated source), it writes them to the workspace filesystem AND mentions paths in its summary. The summary stays small; the workspace holds the full content. CC pulls via `workspace.diff` / `workspace.files` / `workspace.read` when needed.

### What downstream sees

ONLY what the author explicitly wrote into the downstream prompt via `{{ }}` interpolation. Backend never auto-dumps deps. (I7)

### Cross-run / cross-spawn synthesis

`run.summary(runId)` synthesizes a roll-up only when called — never auto. Saves tokens for runs CC never reads. Task-level synthesis across runs is CC's job in its own context.

---

## 12. Error / Retry / Timeout

### Error classes

| Class | Examples | Default policy |
|-------|----------|---------------|
| `transient` | API 5xx, network timeout, rate-limit (429), VM pool exhaustion, ACP connect timeout | Retry with backoff |
| `schema-violation` | Output didn't match schema after self-correction | Retry with corrective prompt |
| `permanent` | Agent not found, engine not configured, prompt template render failure (e.g. dep path doesn't resolve), ACP adapter not installed | Fail immediately |
| `cancelled` | Run cancelled, VM killed, parent cancelled | Fail immediately |

### Node-level config

```json
"retry": {
  "max": 2,
  "on": ["transient", "schema-violation"],
  "backoff": "exponential",
  "initial_ms": 1000,
  "max_ms": 30000
}
"timeout_seconds": 600
```

### Run outcome

After all nodes terminal: any failed node without `on_failure: continue` → run.status = failed. Else → done. No auto-summary.

---

## 13. Auth / Secrets

- Model API keys: framework `app_secrets` vault + `resolveSecret`. Worker injects only the env vars the spawn needs.
- Worker shim sanitizes stderr against known key prefixes.
- Workspace `GITHUB_TOKEN`: ephemeral `https://x-access-token:$TOKEN@github.com/...` URL form; never written to `.git/config`.
- MCP connection auth: bearer token issued at install, in user's CC `.claude/mcp.json`.
- A2A inbound: framework signature verification.
- **NO `~/.claude` copying.** Subscription OAuth doesn't survive multi-VM. For Claude Code as worker, use `runtime: acp:claude-code`.

---

## 14. Observability

### For CC (via MCP)

Pull-based. Backend doesn't push unrequested.

- `run.state` / `run.events` (SSE) / `run.summary` (on-demand)
- `node.summary` / `node.spawn_log`
- `spawn.get` / `spawn.log`
- `pool.status` / `dispatch.queue`

### For humans (web UI)

- Runs list with tag filtering (e.g. `tag.source = "tracker"`)
- Single-run view: DAG visualization, per-node inspector, patch history, event feed, workspace diff viewer
- Spawn list (run-bound + ad-hoc)
- Workspaces list
- Templates editor
- Agents directory (read-only catalog of .claude/agents/*.md)
- Pool dashboard

### Persisted

- All `spawns.rendered_prompt` (exact string sent — reproducibility).
- All spawn stdout/stderr → `spawn_logs` or FS pointer.
- All events → `events` table.
- All patches → `patches` table.

---

## 15. Template Reuse + Input Interpolation

Templates use `{{inputs.X}}` placeholders. `input_schema` (JSON Schema) validated at `workflow.run`.

Flow:
1. Validate inputs against `template.input_schema`.
2. Deep-clone `template.dag`.
3. (Do NOT substitute `{{inputs.X}}` here — substitution happens per-node at spawn-dispatch time, same as deps. This keeps templating uniform.)
4. Insert `runs` row with dag = clone, inputs = the inputs map.
5. Start reconciliation. Each spawn's prompt is rendered with full context `{ inputs, deps, item?, iteration? }`.

Templates immutable. Editing creates new version. Existing runs continue against their version.

---

## 16. A2A Inbound (Other Apps Calling Orchestrator)

Orchestrator exposes its MCP surface ALSO via A2A. Any agent-native app in the same workspace can call orchestrator actions.

### Tag convention — the cross-app traceability mechanism

Every dispatching action accepts an opaque `tags` field. **CC and dispatching apps SHOULD pass tags on EVERY operation related to a logical unit of work** (a tracker item, an external ticket, a chat-session task), so that downstream queries can reassemble the full activity stream.

The 3 resources that accept `tags`:
- `workflow.run({..., tags})` — run-level
- `spawn.once({..., tags})` — ad-hoc spawn
- `workspace.create({..., tags})` — workspace

Typical convention (when dispatched from tracker):
```json
{ "tags": { "source": "tracker", "item_id": "PAY-14", "actor_email": "alice@..." } }
```

Orchestrator stores tags opaquely:
- **Never interpreted** by orchestrator logic
- **Queryable** by partial match: `runs.list({tag_match})`, `spawns.list({tag_match})`, `workspaces.list({tag_match})`
- **Displayable** in orchestrator UI ("dispatched from tracker for PAY-14")

### How dispatching apps reassemble activity for a logical task

A dispatching app (e.g. tracker) wanting "all orchestrator activity for item PAY-14" issues 3 parallel queries:
```
runs.list({       tag_match: { source: "tracker", item_id: "PAY-14" } })
spawns.list({     tag_match: { source: "tracker", item_id: "PAY-14" } })
workspaces.list({ tag_match: { source: "tracker", item_id: "PAY-14" } })
```
Merges results, sorts by timestamp, displays as a single activity stream. This is how the tracker `/items/:id` "Activity" tab is populated (see `tracker/docs/v1-DESIGN.md` §7).

### Outbound

Orchestrator never calls other apps. Dispatching apps poll / subscribe.

---

## 17. Mechanics Demonstration (not a prescription)

**THIS DOCUMENT DOES NOT DEFINE HOW CC WORKS ON A TASK.** CC's per-task behavior is shaped by three layers of user-controlled configuration (outside this orchestrator backend):

1. **CC's local skills** — `~/.claude/skills/*.md` on the user's machine; affect all CC tasks.
2. **Project agents + project CLAUDE.md** — `.claude/agents/*.md` and `CLAUDE.md` checked into a code repo; affect tasks operating in that repo.
3. **Per-task playbook** — a markdown attachment on a tracker work item (`kind: playbook`) that CC reads first thing when picking up that item. Lives in `tracker/docs/v1-DESIGN.md` §5.

If a user wants CC to follow a 7-step QA process for a class of task, they write that 7-step process as a playbook (or as a project skill). **This backend does not prescribe steps.** It only provides the toolkit (spawn / workspace / workflow / patch) CC composes per task.

### What this section IS

A compact illustration of the toolkit's mechanics. Shows the call shapes, not a recipe.

### Toolkit mechanics — how the pieces compose

Given a task (from CC's user, or via `tracker.dispatch-to-orchestrator`), CC has the full toolkit at its disposal. Typical compositions CC may reach for:

- **Quick check / lookup** → `spawn.once({agent, prompt, tags})` — single shot, sync or async
- **Scratch sandbox for inspection** → `workspace.create({owner_kind:"cc", tags})` + `workspace.diff/files/read`
- **Multi-step structured execution** → `workflow.run({dag, inputs, tags})` — author writes a DAG of agents with deps/loops/parallel_over; reconciler drives it; CC observes via `run.state/events` and patches via `workflow.patch`
- **Mid-run intervention** → `workflow.patch(runId, expected_version, ops)` to modify pending nodes / adjust loop bounds / replace whole DAG
- **Approval gate** → DAG node `human_gate`; CC or human resolves via `node.resolve_gate`
- **Cleanup** → `workspace.destroy`, then CC reports to user / writes back to tracker

CC mixes these freely based on the task and per-task playbook. There is no "the CC flow" — there is "CC's choice of tools for this task."

### Playbook-driven flow (the configurable surface)

When a task arrives from tracker (`tracker.dispatch-to-orchestrator(item_id, ...)`), the dispatching action also passes the per-item playbook content (if any) into the run's first context. CC reads the playbook AT THE START and follows its guidance.

End-to-end shape, abbreviated:

```
[CC receives a task — either via user chat or via tracker dispatch event]

[If from tracker]
  CC: tracker.get-work-item("PAY-14")
       → returns item + comments + attachments + linked_runs
  CC reads the item's `kind: playbook` attachment, if any.
  Playbook = natural-language steps + project rules + which agents/models to prefer.

[CC plans based on playbook + task + its own judgement]
  CC may use any combination of:
    workspace.create({owner_kind:"cc", tags:{source:"tracker",item_id:"PAY-14"}})
    spawn.once({..., tags:{source:"tracker",item_id:"PAY-14"}})
    workflow.run({..., tags:{source:"tracker",item_id:"PAY-14"}})
    workflow.patch(...) when mid-flight changes needed
    node.resolve_gate(...) for approval nodes
  Every operation carries the same tags so tracker can reassemble the activity stream.

[CC judges results between steps]
  After each spawn/run terminal, CC reads output via spawn.get / run.summary /
  node.summary, decides next action. Backend does not decide "task done."

[CC reports back]
  Human channel: messages in CC's chat session with the user.
  Tracker channel (if dispatched): tracker.add-comment, tracker.transition-status.
```

### What the user sees while CC works

Two complementary surfaces:

1. **CC's chat session** — primary live view. User sees CC's reasoning and tool calls.
2. **Tracker `/items/:id` Activity tab** — the orchestrator-side surface, populated by tag-match queries (§16). Shows every workflow run, ad-hoc spawn, and workspace tagged with this item, time-ordered. Visible even when the user is not in CC chat (e.g. background dispatch).

### Key contracts in this demonstration

- CC carries `tags: { source, item_id }` on every dispatched op → trackable activity stream.
- Inter-spawn data passing is via prompt interpolation only (§6); CC explicitly puts upstream values into downstream prompts.
- Backend never decides task is done; CC + user decide.
- Tracker status moves only when CC explicitly calls `transition-status`; orchestrator never reaches into tracker.

---

## 18. Consistency & Concurrency Invariants

| Invariant | Enforcement |
|-----------|-------------|
| Patches cannot modify `running` / `done` nodes | Reconciler checks `node.status` |
| DAG mutations atomic | All ops in one PG transaction; `dag_version` increment in same transaction |
| Done nodes' artifacts immutable | `artifacts` append-only |
| Spawn failure doesn't corrupt workspace | `git reset --hard origin/<branch> && git clean -fdx` in workspace VM before next spawn |
| microVM never reused across spawns | Dispatcher always destroys post-spawn |
| API keys never in artifacts/logs | Worker shim sanitizes stderr |
| Run state survives backend restart | All state in Postgres; reconciler loads pending/running/paused on startup |
| Concurrent patches don't race | `workflow.patch` requires `expected_dag_version`; mismatch → 409 |
| Reconciler doesn't double-dispatch | `nodes.status` transition `ready → running` via atomic UPDATE (single-process assumption) |
| Spawn context isolation | Worker dispatcher provides ONLY system_prompt + rendered_prompt + tools + workspace to worker shim; nothing else (I2, I7) |
| Rendered prompts reproducible | `spawns.rendered_prompt` stores exact string sent |
| Patch the future, fork the past | Patch targets only nodes not yet dispatched (`pending`/`ready`); `running`/`done` rejected `node_not_patchable`; behind-frontier change → `run.fork` (I9) |
| Patch race is closed | Each target node's status re-checked inside the patch transaction at `expected_dag_version`; a node dispatched between CC's read and the patch is rejected, not raced |
| Loop/parallel patches are next-boundary | Loop body/`until` edits apply at the next iteration; `parallel_over` body edits apply to not-yet-dispatched items; a frozen item set needs `run.fork` |

---

## 19. Explicit Non-Goals

| Non-goal | Why |
|----------|-----|
| Backend infers task done | Tasks live outside orchestrator |
| Backend pushes notifications to CC | CC pulls. No server-initiated MCP push |
| Backend auto-summarizes runs at completion | On-demand only via `run.summary` |
| Backend decides what to do next after a run | Always CC's job |
| In-place edit of a node at/behind the execution frontier | `running`/`done` nodes are immutable (I5/I9). Change the executed past via `run.fork`, not patch |
| **Auto-injection of deps into prompts** | I7. Author writes every `{{deps.X.output.Y}}`. Backend never auto-dumps |
| **Mandatory output_schema on every agent node** | CC default is text-only. Schema is opt-in for structured |
| **Schema enforcement at LLM-tool layer** | CC's Agent tool has no schema parameter. Schema lives in workflow runtime layer. We match: schema enforced by worker shim |
| Multiple sandbox backends | microVM only. (ACP is not a sandbox — it's a remote-driving protocol) |
| Multiple agent engine types beyond framework's set | Whatever `resolveEngine` supports |
| Workflow code as JavaScript | DAG-as-data only. No eval, no JS sandbox |
| Claude subscription OAuth via cloned `~/.claude` | Multi-machine broken. Use `runtime: acp:claude-code` |
| Multi-tenant RBAC | Single-user single-tenant |
| Custom user-defined tools beyond the 6 fixed | `Read/Edit/Write/Bash/Glob/Grep` same as CC native |
| Graphical DAG editor | CC writes JSON, humans edit JSON |
| Cost accounting / billing dashboards | Tokens tracked per spawn for observability only |

---

## Cross-reference

- Tracker design (work-item management app): `templates/tracker/docs/v1-DESIGN.md`
- A2A inbound from tracker: §16 above + tracker v1 §6
- Framework subagent format: `packages/core/src/templates/workspace-core/.agents/skills/external-agents/SKILL.md`
- Framework engine registry: `packages/core/src/agent/engine/registry.ts`
- Framework ACP adapter: `packages/core/src/agent/harness/acp-adapter.ts`
- CC Dynamic Workflows reference: code.claude.com/docs/en/workflows
- CC Subagents reference: code.claude.com/docs/en/agent-sdk/subagents

End of design.
