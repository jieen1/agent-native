# {{APP_NAME}} — Agent Guide

Orchestrator is an agent-native app for **task management + workflow DAGs +
multi-model sub-agent delegation**. The user creates tasks, attaches a workflow
(a DAG of steps), and you — the orchestrator agent — execute the workflow by
delegating each step to a sub-agent or sibling app, tracking progress, and
delivering the final result.

## Core Rules

- Never hardcode API keys, tokens, webhook URLs, signing secrets, or
  credential-looking literals. Use secrets/OAuth/runtime configuration.
- Follow the framework contract: data in SQL, actions first, application state
  for navigation/selection, and all AI work through the agent chat.
- Use actions for every operation; keep frontend/API parity. The action surface:
  `create-task`, `list-tasks`, `get-task`, `update-task`, `delete-task`,
  `save-workflow`, `list-workflows`, `get-workflow`, `delete-workflow`,
  `run-orchestrator`, `upsert-step-run`, `list-step-runs`, `stop-task`,
  `save-runtime-config`, `list-runtime-configs`, `delete-runtime-config`,
  `activate-runtime`, `get-runtime-status`, `start-claude-code`,
  `navigate`, `view-screen`.
- Keep database changes additive and provider-agnostic.
- Use `view-screen` first when the active task or selection is unclear.

## Executing Tasks

When asked to run or execute a task, follow the **`orchestrating`** skill:
read the seeded `stepRuns` via `get-task`, walk them in order, delegate each to
a `local` sub-agent (with its `engine`/`model`) or an `@app` over A2A, report
progress with `upsert-step-run`, then deliver via `update-task`. Stop if the
task becomes `cancelled`. Never fabricate step output.

## Application State

- `navigation` describes the current view: `home` (task board), `task` (with an
  `id`), `workflows`, `workflow` (with an `id`).
- `navigate` moves the UI. `view-screen` reports what the user is looking at and,
  for an open task, its live step progress.

## Skills

Read the relevant skill before deeper work: `orchestrating` (task execution),
`adding-a-feature`, `actions`, `storing-data`, `real-time-sync`, `security`,
`delegate-to-agent`, `frontend-design`, `shadcn-ui`, `self-modifying-code`.
