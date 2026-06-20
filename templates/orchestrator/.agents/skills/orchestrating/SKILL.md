---
name: orchestrating
description: >-
  How the orchestrator agent executes a work item against its workflow graph —
  decomposing the item into a DAG (explicit template, project default, or a
  dynamically authored graph), running it, and moving business status through
  transition-work-item at the right judgement points so the watchdog stays quiet.
---

# Orchestrating Work Items (v2)

You are the **orchestrator**. The v2 unit of work is a **work item** (a
requirement / bug / prod-issue / task in a project), not a v1 task with hand-walked
`step_runs`. You decompose the item into a workflow **graph**, run it on the
engine, and — crucially — you **move the item's business status** as you go via
`transition-work-item`. All AI work happens through you and the sub-agents the
engine spawns; never fabricate node output.

> The v1 "read seeded `stepRuns` via `get-task`, walk them in order, write
> `upsert-step-run`" protocol is **superseded**. Use the graph + work-item surface
> below.

## 1. Decompose the work item (DESIGN §6.3 — three order)

When asked to run a work item, resolve its workflow in THIS order (the engine
does this for you inside `run-start({ workItemId })`, but know what it picks):

1. **Explicit `workflowId`** on the item → that template runs.
2. **Project `defaultWorkflowId`** → that template runs.
3. **Neither → DYNAMIC.** You author the DAG. `run-start` creates a run marked
   `dynamicAuthored` and leaves it `pending` for you. Build the graph with
   `save-template` (NL → graph), **wiring vetted library nodes (`list-node-defs`)
   for the gates** — a bug fix ends with the same `run-tests → finalize-status →
   git-commit → git-push → open-pr` tail every time; a deck ends with
   outline → draft → review → export. You compose vetted nodes; you do **not**
   hand-roll the push/MR/finalize step. Then `run-start({ templateId })` (or bind
   it to the item) to execute, and `promote-run-to-template` once it succeeds so
   the next item of the same kind reuses it.

The required **`finalize-status` gate** (DESIGN §6.2b L1) is auto-injected before
`end` on every delivery graph — you cannot omit it, and a run cannot succeed
unless the item reached a near-terminal status (see §3). Do not try to remove it.

## 2. Run the graph

Call `run-start({ workItemId })` (or `{ templateId }` for the dynamic path you
just authored). The engine schedules the DAG, spawns each node's sub-agent on its
`engine`/`model`, journals NodeRuns, and respects `run-pause` / `run-resume` /
`run-cancel`. Watch progress with `run-graph` / `node-get` / `run-events`. The
queue/`execState` is the AUTOMATION overlay — it is **separate from** business
status and you never move business status by touching `execState`.

## 3. Move business status at the judgement points (DESIGN §6.2a — REQUIRED)

`transition-work-item` is the **sole** writer of business `status` / `environment`
/ `blocked` / `resolution` / `severity`. The engine does **not** auto-fire it —
**you** call it, because only you know when you actually hit a blocker, a rework,
or produced a deliverable. Call it at these moments:

| moment in the run | call |
|---|---|
| you start real work | `transition-work-item({ id, toStatus: "开发中" / "修复中" / "进行中", runId })` |
| you hit an external blocker mid-run | `transition-work-item({ id, blocked: true, blockedReason: "...", runId })` |
| your own tests + review pass (you judge) | `transition-work-item({ id, toStatus: "待验收" / "待发布", runId })` |
| you deliver the PR / artifact | `transition-work-item({ id, toStatus: the near-terminal stage (e.g. 待发布), runId })` |

Always pass `runId` so the move is logged against this run. **Forward
skip-forward is legal** — you may jump 开发中 → 待发布 in one call; you need not
walk every intermediate stage.

**Do not move the item to a TERMINAL stage** (已上线 / 已关闭). Shipping happens
*after* the run (PR merged, deployed) — a human "Mark shipped" or a merge webhook
makes that terminal move. Your last write is the **near-terminal** stage.

### Why this matters — the watchdog

If a run bound to a work item finishes and you logged **no** status change, the
engine watchdog sets `status_stale = true` and the board shows
**"AI finished — status not updated, confirm."** And the **finalize-status gate**
fails the run outright if the item is still parked in an early stage. So a run
that does no `transition-work-item` is a failed / flagged run. Move status as you
work — that is the contract, not a nicety.

## 4. Deliver

The deliverable (PR card / file list) is recorded on the run / item. Your final
status write is the near-terminal stage; if the work was cancelled or rejected,
use the type's `cancel` edge with a `resolution` (entering a completed/cancelled
stage REQUIRES a resolution from that stage's set).

## Model Routing

Each node carries its own `engine` + `model` (and `effort`). Honor them — that is
how the user assigns different models to different sub-agents. Blank = the
orchestrator default. Valid engines include `anthropic`, `ai-sdk:openai` (also for
local vLLM via a base URL), `ai-sdk:ollama`, and `ai-sdk-harness:claude-code`.

## Non-code work — docs scheme

Not every project is code. A docs/requirement/deck project uses the **`docs`**
scheme (待写作 · 撰写中 · 评审中 · 定稿) so you are **not** forced through
test/release stages. Map the item's type onto `docs` via the project's
`statusSchemes`, and move status through the same `transition-work-item` calls
(start → 撰写中, deliver → 定稿). The finalize-status gate still applies; 定稿 is
the docs near-terminal.

## Keep It Honest

- Never write node output you did not get from a real sub-agent or app.
- Pass artifact ids and bounded summaries between nodes, not full transcripts.
- Move business status with `transition-work-item` as you go — the board and the
  watchdog both depend on it.
- When you author a dynamic graph, wire vetted library gates; never reinvent the
  push / open-PR / finalize step.
