# {{APP_NAME}} — Agent Guide

Orchestrator is an agent-native app for **task management + workflow DAGs +
multi-model sub-agent delegation**. Users create tasks, attach a workflow (a DAG
of steps), and the orchestrator agent executes the workflow by delegating each
step to a sub-agent or sibling app, tracking progress, and delivering a result.

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
- Use `view-screen` first when the active task/selection is unclear.

## Executing Tasks

Follow the **`orchestrating`** skill: read seeded `stepRuns` via `get-task`,
walk them in dependency order, delegate each to a `local` sub-agent (with its
`engine`/`model`) or an `@app` over A2A, report progress with `upsert-step-run`,
deliver via `update-task`, and stop if the task becomes `cancelled`. Never
fabricate step output.

## Application State

`navigation` views: `home` (task board), `task` (`id`), `workflows`,
`workflow` (`id`). `navigate` moves the UI; `view-screen` reports the current
view and live task progress.
