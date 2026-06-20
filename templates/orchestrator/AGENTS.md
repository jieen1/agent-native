# {{APP_NAME}} — Agent Guide

Orchestrator is an agent-native app for **project + work-item management +
workflow graphs + multi-model sub-agent delegation**. Users define projects, drop
**work items** (requirement / bug / prod-issue / task) into a queue, and the
orchestrator agent **decomposes** each item into a workflow graph, runs it on the
engine across multiple models, and moves its business status through
`transition-work-item`. (The v1 task + `step_runs` surface is retained but
superseded by the work-item surface below.)

## Core Rules

- Never hardcode secrets or credential-looking literals.
- Data in SQL, actions first, application state for navigation, all AI work
  through the agent chat. Keep DB changes additive and provider-agnostic.
- Action surface: `create-task`, `list-tasks`, `get-task`, `update-task`,
  `delete-task`, `save-workflow`, `list-workflows`, `get-workflow`,
  `delete-workflow`, `run-orchestrator`, `upsert-step-run`, `list-step-runs`,
  `stop-task`, `save-runtime-config`, `list-runtime-configs`,
  `delete-runtime-config`, `activate-runtime`, `get-runtime-status`,
  `start-claude-code`, `navigate`, `view-screen`.
- v2 graph engine surface (templates + runs): `save-template`, `list-templates`,
  `get-template`, `delete-template`, `promote-run-to-template`, `run-start`,
  `run-pause`, `run-resume`, `run-cancel`, `run-retry-node`, `node-override`,
  `resolve-human-gate`, `node-report`, and the observers `run-get`, `run-graph`,
  `node-get`, `run-events`, `list-runs`, plus `seed-fixtures`. Engine internals
  (item-correlation, pipeline-vs-barrier, two-pass resume, await:false, promote
  distill) are documented in `DEVELOPING.md` → "Workflow Engine Internals".
- v2 project-management surface (P3a — projects + work items + the six-dimension
  business-status model): `create-project`, `list-projects`, `get-project`,
  `update-project`; `create-work-item`, `list-work-items`, `get-work-item`,
  `update-work-item`, `delete-work-item`; `link-work-items`, `unlink-work-items`;
  `backfill-work-items`, `reconcile-on-terminal`; and the SOLE writer of business
  status/environment/blocked/resolution/severity, **`transition-work-item`**.
  Hard rules: business `status`/`environment`/`blocked`/`resolution`/`severity`
  move ONLY through `transition-work-item` (validated against the project's
  per-type scheme; `update-work-item` REJECTS those fields); every transition
  appends one `work_item_status_log` row; entering a completed/cancelled stage
  requires a resolution; reopen clears it; the engine watchdog
  (`reconcile-on-terminal`) flags `status_stale` when a work-item-bound run
  finishes with no logged status change. Status schemes + the transition
  validator live in `shared/status-schemes.ts`.
- v2 node library + decomposition + dynamic authoring (P3c — DESIGN §3.7 / §6.3 /
  §6.5): `save-node-def`, `list-node-defs`, `delete-node-def` (BLOCKED when a
  template graph references the entry's `key`, listing the referencing templates),
  and `seed-library` (the starter set + bundled `code-change-with-review`
  template). Library entries are referenced from a graph by `nodeDefKey`. Hard
  rules: `save-template` AUTO-INJECTS the required `finalize-status` library node
  before `end` for delivery graphs (DESIGN §6.2b L1 — the brain cannot omit it);
  the engine's gate FAILS a work-item-bound run whose item never reached a
  near-terminal status. Decomposition resolves a work item's workflow in three
  order (DESIGN §6.3): explicit `item.workflowId` → project `defaultWorkflowId` →
  DYNAMIC (the brain authors the DAG; the run is marked `dynamic_authored` and
  handed to the orchestrating agent — no LLM call is hardcoded in the engine). A
  successful dynamic run is distilled via `promote-run-to-template`.
- Use `view-screen` first when the active item/selection is unclear.

## Executing Work Items

Follow the **`orchestrating`** skill: **decompose** the item (explicit
`workflowId` → project `defaultWorkflowId` → dynamically author a graph wiring
vetted library gates from `list-node-defs`), **run** it via
`run-start({ workItemId })`, and **move business status** with
`transition-work-item` at the §6.2a judgement points — start real work →
开发中/修复中; external blocker → `blocked: true`; tests+review pass → 待验收/待发布;
deliver → the near-terminal stage (always pass `runId`). A run that logs no status
change is failed by the finalize-status gate and flagged by the watchdog. Never
mark a terminal stage (已上线/已关闭) — shipping happens after the run. Non-code
projects use the `docs` scheme (待写作 · 撰写中 · 评审中 · 定稿). Never fabricate
node output. The v1 task flow (`get-task` → walk `stepRuns` → `update-task`) is
retained for legacy tasks only.

## Application State

`navigation` views: `home` (task board), `task` (`id`), `workflows`,
`workflow` (`id`), `runs` (run list), `run` (`id`, the read-only run console).
`navigate` moves the UI; `view-screen` reports the current view and live task
progress. The run console (`/runs/:id`) renders the live NodeRun list + node
detail off `run-graph`/`node-get` and exposes Run-again/Pause/Resume/Cancel.
