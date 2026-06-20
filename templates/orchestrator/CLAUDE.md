# {{APP_NAME}} — Agent Guide

Orchestrator is an agent-native app for **project + work-item management +
workflow graphs + multi-model sub-agent delegation**. The user defines projects
and drops **work items** (requirement / bug / prod-issue / task) into a queue;
you — the orchestrator agent — **decompose** each item into a workflow graph, run
it on the engine across multiple models, and **move its business status** through
`transition-work-item` as you go.

## Core Rules

- Never hardcode API keys, tokens, webhook URLs, signing secrets, or
  credential-looking literals. Use secrets/OAuth/runtime configuration.
- Follow the framework contract: data in SQL, actions first, application state
  for navigation/selection, and all AI work through the agent chat.
- Use actions for every operation; keep frontend/API parity. Keep database
  changes additive and provider-agnostic.

## Action Surface (v2)

- **Projects / work items (PM core):** `create-project`, `list-projects`,
  `get-project`, `update-project`; `create-work-item`, `list-work-items`,
  `get-work-item`, `update-work-item`, `delete-work-item`; `link-work-items`,
  `unlink-work-items`; and the **sole writer** of business status —
  `transition-work-item`. `update-work-item` REJECTS the business-status fields;
  they move only through `transition-work-item` (validated against the project's
  per-type scheme, appends a `work_item_status_log` row).
- **Queue / automation overlay:** `enqueue-work-item`, `dequeue-work-item`,
  `assign-work-item`, `set-concurrency`, `queue-status`. The queue uses
  `execState`, which is **separate from** business `status` — never move business
  status by touching the queue.
- **Templates / runs / library:** `save-template` (auto-injects the
  finalize-status gate for delivery graphs), `list-templates`, `get-template`,
  `delete-template`, `promote-run-to-template`; `save-node-def`, `list-node-defs`,
  `delete-node-def` (blocked when a template references the key), `seed-library`
  (the starter library + bundled `code-change-with-review` template); `run-start`,
  `run-pause`, `run-resume`, `run-cancel`, `run-retry-node`, `node-override`,
  `resolve-human-gate`; observers `run-get`, `run-graph`, `node-get`,
  `run-events`, `list-runs`, `reconcile-on-terminal`.
- **Runtime / nav:** `save-runtime-config`, `list-runtime-configs`,
  `delete-runtime-config`, `activate-runtime`, `get-runtime-status`,
  `start-claude-code`, `navigate`, `view-screen`.
- **v1 (legacy, retained, not deleted):** `create-task` … `stop-task`,
  `run-orchestrator`, `upsert-step-run`, `list-step-runs`. Prefer the work-item
  surface for new work.
- Use `view-screen` first when the active item or selection is unclear.

## Executing Work Items

Follow the **`orchestrating`** skill: **decompose** the item (explicit
`workflowId` → project `defaultWorkflowId` → dynamically author a graph wiring
vetted library gates), **run** it via `run-start({ workItemId })`, and **move
business status** with `transition-work-item` at the §6.2a judgement points —
start real work → 开发中/修复中; external blocker → `blocked: true`; tests+review
pass → 待验收/待发布; deliver → the near-terminal stage. A run that logs no status
change is failed by the finalize-status gate and flagged by the watchdog, so move
status as you work. Never mark a terminal stage (已上线/已关闭) — shipping happens
after the run. Non-code projects use the `docs` scheme (待写作 · 撰写中 · 评审中 ·
定稿) so they are not forced through test/release stages. Never fabricate node
output.

## Application State

- `navigation` describes the current view: `home` (board), `task`/`work-item`
  (with an `id`), `projects`, `workflows`, `workflow`/`template` (with an `id`),
  `runs`, `run` (with an `id`), `library`.
- `navigate` moves the UI. `view-screen` reports what the user is looking at and,
  for an open item/run, its live progress.

## Skills

Read the relevant skill before deeper work: `orchestrating` (work-item
execution + status transitions), `adding-a-feature`, `actions`, `storing-data`,
`real-time-sync`, `security`, `delegate-to-agent`, `frontend-design`,
`shadcn-ui`, `self-modifying-code`.
