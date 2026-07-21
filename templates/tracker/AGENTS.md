# Tracker — Agent Guide

Tracker is an agent-native project management app for tracking requirements,
defects, tasks, and incidents through a 7-stage pipeline:
**待办 → 分析 → 设计 → 实施 → 测试 → 验收 → 交付**

Status moves only by explicit human or agent action. No automatic inference.

## Action Surface

**Projects & Work Items:**

- `create-project`, `list-projects` — project management
- `create-work-item`, `get-work-item`, `list-work-items`, `update-work-item`, `delete-work-item` — CRUD
- `view-screen`, `navigate`, `refresh-list` — understand what the user is looking at

**7-Stage Pipeline:**

- `trigger-stage` — advance to the next stage (creates a stage run)
- `complete-stage` — mark current stage complete and advance status
- `rollback-stage` — revert to prior stage
- `list-stages` — read stage history for a work item

**Comments & Links:**

- `add-comment`, `list-comments` — discussion threads per work item
- `add-link`, `list-links` — typed relationships (blocks/blocked-by/duplicate-of/relates-to/bug-of/test-of)

**Artifacts:**

- `create-artifact`, `list-artifacts` — attach files/designs/playbooks to items

**Sprints:**

- `create-sprint`, `update-sprint`, `get-sprint`, `list-sprints` — sprint management

**Orchestrator Dispatch:**

- `dispatch-to-orchestrator` — send a work item to orchestrator brain for AI execution.
  Rejects with a `scheduler-paused` error when the queue scheduler is paused
  (`pause-scheduler`) — checked BEFORE any orchestrator call.
- `bulk-dispatch-to-orchestrator` — dispatch multiple items
- `list-tracker-activities` — poll orchestrator activity tagged to an item
- `enqueue-work-item`, `dequeue-work-item`, `list-queue` — manage execution queue
- `pause-scheduler`, `resume-scheduler` — real, persisted (settings-store) queue
  scheduler pause/resume — a paused scheduler rejects new dispatch attempts
- `reorder-queue` — persist manual drag/pin-to-top order for the queue's
  dispatchable rows (`exec_queue.position`)
- `get-queue-health` — real health-gate status: scheduler pause state + the
  orchestrator's Claude Code login / dev-engine config / brain driver &
  concurrency (read over the same signed MCP channel `dispatch-to-orchestrator`
  uses) + the last dispatch rejection

## Application State

- `navigation` describes current view: `board`, `item` (with `id`), `new-item`,
  `projects`, `sprints`, `sprint` (with `id`), `queue`, `team`
- `navigate` moves the UI. `view-screen` reports what the user sees.

## Stage Pipeline Rules

When working on a task, move it through the 7 stages:

1. `trigger-stage` to start each stage (creates a stage run record)
2. `complete-stage` to finish a stage and advance `currentStageName`
3. Dispatch to orchestrator for AI execution after 分析/设计
4. Use `rollback-stage` if a stage needs to be redone

## Key Conventions

- Work items are created with `priority` (1=P0 to 4=P3) and `risk` (low/medium/high)
- `itemKey` is auto-assigned (e.g. `PRJ-001`) — never set manually
- Sprint status: 规划 → 进行中 → 已完成 → 已发布
- Tags are free-form strings on work items
- Work item `type`: `需求` (requirement), `缺陷` (bug), `任务` (task), `事故` (incident)
- For AI execution: dispatch to orchestrator; orchestrator brain handles the run
- The board groups by `currentStageName` — this is the primary visual

## Response Language

- Always respond in the user's language. If context has zh-CN → reply in 简体中文.
- Keep code, identifiers, and file paths in their original language.

## Skills

Read the relevant skill before deeper work:

- `actions` for defining and calling actions
- `storing-data`, `real-time-sync`, `security` for data work
- `frontend-design`, `shadcn-ui` for UI changes
- `self-modifying-code` for source edits
- `delegate-to-agent` for AI delegation patterns
