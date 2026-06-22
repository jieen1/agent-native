# Tracker — Work Item Management

A standalone agent-native app for tracking requirements, defects, tasks, and incidents. Human-driven status workflow. Comments. Attachments (files, design docs, **playbooks**). Two outbound integrations: dispatch a work item to the `orchestrator` app for AI-driven execution; pull activity tags back from orchestrator to surface live work.

**Independent of AI.** Status moves only by explicit human or CC action. No automatic inference, no state-machine pseudo-AI, no auto-summarization. Where CC needs guidance on HOW to handle a task, the user attaches a **playbook** to that work item; CC reads it as instruction.

This document is the complete design.

---

## Table of Contents

0. [Goal & Non-goals](#0-goal--non-goals)
1. [Architecture](#1-architecture)
2. [Core Concepts (incl. Playbook)](#2-core-concepts-incl-playbook)
3. [Data Model](#3-data-model)
4. [Status Schemes](#4-status-schemes)
5. [MCP / Action Surface](#5-mcp--action-surface)
6. [A2A Integration with Orchestrator (Dispatch + Activity Stream)](#6-a2a-integration-with-orchestrator-dispatch--activity-stream)
7. [UI](#7-ui)
8. [Auth / Sharing](#8-auth--sharing)
9. [Explicit Non-goals](#9-explicit-non-goals)

---

## 0. Goal & Non-goals

### Goal

A clean, no-magic project tracking app:
- Track requirements/defects/tasks/incidents through configurable status workflows that humans (or CC via MCP) drive **explicitly**
- Attach context (comments, file attachments, **design docs as markdown attachments**, **playbooks as instructional markdown attachments**)
- Dispatch an item to the orchestrator app for AI execution and surface a live activity stream of all orchestrator work tagged for that item
- Let users define HOW CC should approach a class of work via per-item playbooks (NOT hardcoded in code)

### Non-goals

- Status moves automatically. **No.** Status moves only when `transition-status` is called (by human via UI, or by CC via MCP).
- Auto-summarize work item content. **No.**
- Workflow execution. **No.** That's orchestrator.
- Watchdog that auto-moves status based on run results. **No.**
- Backend decides task is "done." **No** — humans (or CC reporting back per user direction) decide.

---

## 1. Architecture

Standalone agent-native template at `templates/tracker`. Own DB. Own MCP server. Own UI. Connects to orchestrator via A2A.

```
┌──────────────────────────────────────────────────────────┐
│  User's Claude Code (local) — drives tracker via MCP      │
└──────────────────────┬───────────────────────────────────┘
                       │ MCP
                       ▼
┌──────────────────────────────────────────────────────────┐
│  App: tracker                                              │
│   - work_items, comments, attachments(files/design/play)   │
│   - status_log, status_schemes                             │
│   - All status changes explicit (human or CC action)       │
│   - Outbound to orchestrator: dispatch + activity-poll     │
│   - UI: /board, /items/:id (incl. Activity stream tab)     │
└────────────────────┬─────────────────────────────────────┘
                     │ A2A
                     │ - dispatch-to-orchestrator (with playbook content + tags)
                     │ - tag-match queries to assemble activity stream
                     ▼
┌──────────────────────────────────────────────────────────┐
│  App: orchestrator                                         │
│   - Executes workflows; runs / spawns / workspaces         │
│   - Stores tags opaquely; queryable via tag_match          │
│   - Returns runId on dispatch; never calls back            │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Core Concepts (incl. Playbook)

| Concept | Definition |
|---------|-----------|
| **Project** | Container of work items. Has key (id prefix, e.g. `PAY` → `PAY-14`). Status scheme overrides, environments, optional default playbook attachment id. |
| **Work Item** | A unit of work. One of: `requirement`, `defect`, `task`, `incident`. Has business status (per-type scheme) + free-form description + assignee + priority + severity + environment + progress note. |
| **Status Scheme** | Per type, ordered set of named statuses + allowed transitions + category mapping. Per-project override possible. |
| **Status Log** | Append-only history of status changes per item. |
| **Comment** | Free-form markdown comment on an item. Authored by human or CC. Flat list. |
| **Attachment** | File or markdown content attached to an item. Three `kind`s: `file`, `design-doc`, **`playbook`**. |
| **Playbook** | A markdown attachment with `kind: playbook`. **Instructional content telling CC how to approach this item / this class of item.** Read by CC at the start of work. Plain natural language; no DSL. May reference which agents/models to prefer, project-specific rules, validation criteria, etc. May exist per-item or per-project (project default). |
| **Progress Note** | A short free-form string on the work item updated by CC (or human) describing current activity. Distinct from status (status is scheme-bound). |
| **Link** | Typed relationship between two items: `duplicate-of` / `blocks` / `blocked-by` / `relates-to`. |
| **Activity Tag** | Convention: when this app dispatches to orchestrator, it tags every orchestrator resource (run/spawn/workspace) with `{source: "tracker", item_id: "<id>"}`. Used to query orchestrator and reassemble the activity stream. |

---

## 3. Data Model

Postgres. Key fields. Ownership scoping via framework `ownableColumns()` on rows noted.

```sql
projects (
  id              TEXT PRIMARY KEY,
  key             TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  status_schemes  JSONB,                  -- per-type override; null = defaults (§4)
  environments    JSONB,                  -- e.g. ["dev","staging","prod"]
  default_orchestrator_template TEXT,     -- optional: suggested template name in dispatch UI
  default_playbook_attachment_id TEXT,    -- optional: project-wide CC guidance fallback
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  ...ownableColumns()
)

work_items (
  id              TEXT PRIMARY KEY,       -- e.g. "PAY-14"
  project_id      TEXT NOT NULL REFERENCES projects(id),
  type            TEXT NOT NULL,          -- requirement | defect | task | incident
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  priority        INT NOT NULL DEFAULT 0,
  severity        TEXT,                   -- defect/incident: critical|major|minor|trivial
  environment     TEXT,
  assignee        TEXT,
  status          TEXT NOT NULL DEFAULT '',
  status_category TEXT NOT NULL DEFAULT 'todo',
  blocked         BOOLEAN NOT NULL DEFAULT false,
  blocked_reason  TEXT,
  resolution      TEXT,
  progress_note   TEXT,                   -- free-form current-activity text (CC or human updates)
  progress_updated_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  ...ownableColumns()
)

work_item_status_log (
  id              TEXT PRIMARY KEY,
  work_item_id    TEXT NOT NULL REFERENCES work_items(id),
  actor           TEXT NOT NULL,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  blocked         BOOLEAN NOT NULL DEFAULT false,
  resolution      TEXT,
  note            TEXT,
  run_ref         TEXT,                   -- optional: orchestrator runId
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
)

comments (
  id              TEXT PRIMARY KEY,
  work_item_id    TEXT NOT NULL REFERENCES work_items(id),
  author          TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ,
  edited          BOOLEAN NOT NULL DEFAULT false
)

attachments (
  id              TEXT PRIMARY KEY,
  work_item_id    TEXT NOT NULL REFERENCES work_items(id),
  kind            TEXT NOT NULL,          -- file | design-doc | playbook
  name            TEXT NOT NULL,
  mime_type       TEXT,                   -- file kind only
  content_md      TEXT,                   -- design-doc or playbook (inline markdown)
  blob_ref        TEXT,                   -- file kind (FS/S3 pointer)
  byte_size       INT,
  uploaded_by     TEXT NOT NULL,
  created_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ
)

work_item_links (
  id              TEXT PRIMARY KEY,
  from_item       TEXT NOT NULL REFERENCES work_items(id),
  to_item         TEXT NOT NULL REFERENCES work_items(id),
  kind            TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ
)
```

**Notable: `work_items.workflow_run_ids` removed.** Linked orchestrator activity is NOT stored in tracker. Instead, tracker queries orchestrator on demand via tag-match (§6). Removes a sync-headache; single source of truth (orchestrator).

---

## 4. Status Schemes

Per work-item type. Each scheme is `{ stages: [[status...], ...], transitions: [...], categoryMap: {...}, reworkTarget: ... }`. Defaults:

```yaml
requirement:  待分析 → 待开发 → 开发中 → 测试中 → 待验收 → 已上线
defect:       待确认 → 待修复 → 修复中 → 待验证 → 已关闭
task:         待办 → 进行中 → 已完成
incident:     新建 → 排查中 → 临时缓解 → 已修复 → 已关闭
docs:         待写作 → 撰写中 → 评审中 → 定稿
```

Each scheme has cancel/reject/reopen back-edges. `transition-status` validates against scheme.

A project may override `status_schemes` per type.

---

## 5. MCP / Action Surface

`tracker.*` namespace. Auto-exposed via framework MCP.

### 5.1 Projects

```
tracker.create-project({ name, key, description?, status_schemes?, environments?,
                          default_orchestrator_template?,
                          default_playbook_attachment_id? })  → { id, key }
tracker.list-projects()                  → [ {id, key, name, description} ]
tracker.get-project(id | key)            → { ...full, schemes (resolved) }
tracker.update-project(id, patch)        → { ok }
tracker.delete-project(id)               → { ok }
```

### 5.2 Work Items

```
tracker.create-work-item({ project_id, type, title, description?, priority?,
                            severity?, environment?, assignee?, initial_status? })
  → { id }  -- e.g. "PAY-14"

tracker.list-work-items({ project_id?, type?, status?, status_category?,
                            assignee?, blocked?, search?, since?, limit?, offset? })
  → [ {id, title, status, statusCategory, type, assignee, priority, severity,
        environment, blocked, progress_note, has_active_dispatch, updated_at} ]
  -- has_active_dispatch derived from orchestrator runs.list({tag_match:{item_id:id}})
     filtered to status=running; CACHED (5-30s) per item.

tracker.get-work-item(id)
  → { ...full row, statusLog, comments, attachments, links,
      project_default_playbook_id }
  -- Does NOT inline orchestrator activity. Caller fetches via get-activity-stream (5.7).

tracker.update-work-item(id, patch)  → { ok }
  -- REJECTS status/statusCategory/blocked/progress_note.
  -- Status moves via transition-status. Progress moves via set-progress.

tracker.delete-work-item(id)         → { ok }  -- soft delete

tracker.transition-status({ id, to, from?, note?, blocked?, resolution?, run_ref?, actor? })
  → { id, from, to, category, at }
  -- SOLE writer of status / statusCategory / blocked / resolution.
  -- Appends status_log row.

tracker.set-progress({ id, progress_note, actor? })
  → { id, progress_note, progress_updated_at }
  -- Updates the free-form progress note (e.g. CC writes "exploring repo structure",
     "running test suite", "blocked on user clarification").
  -- Does NOT change business status.
  -- CC SHOULD call this periodically during long-running work for human visibility.
```

### 5.3 Comments

```
tracker.add-comment({ work_item_id, body, author? })  → { id }
tracker.list-comments(work_item_id)                    → [ {id, author, body, created_at, edited} ]
tracker.update-comment(id, body)                       → { ok, edited: true }
tracker.delete-comment(id)                             → { ok }
```

### 5.4 Attachments (file, design-doc, playbook)

```
tracker.attach-file({ work_item_id, name, mime_type, blob_ref, byte_size, uploaded_by? })
  → { id }

tracker.attach-design-doc({ work_item_id, name, content_md })
  → { id }
  -- kind: design-doc; inline markdown.

tracker.attach-playbook({ work_item_id, name, content_md, uploaded_by? })
  → { id }
  -- kind: playbook; inline markdown.
  -- Instructional content telling CC HOW to handle this item.
  -- CC reads this at start of work (see §6).
  -- May exist as project-level fallback via projects.default_playbook_attachment_id
    (attached to a "playbook template" work item or directly to the project).

tracker.list-attachments(work_item_id, { kind? })
  → [ {id, kind, name, mime_type?, byte_size?, uploaded_by, created_at} ]

tracker.list-playbooks(work_item_id)
  → [ {id, name, content_md, created_at} ]
  -- Convenience: filtered to kind=playbook for the item, INCLUDING project default if any.

tracker.get-attachment(id)
  → { ...full row, content_md? }  -- inline content for design-doc / playbook kinds

tracker.update-attachment(id, patch)  → { ok }   -- name, content_md
tracker.delete-attachment(id)         → { ok }
```

### 5.5 Links

```
tracker.link-items({ from, to, kind })  → { id }
tracker.unlink-items(id)                 → { ok }
tracker.list-links(work_item_id)         → [ {id, direction, kind, otherItem} ]
```

### 5.6 Dispatch (the orchestrator-bound integration)

```
tracker.dispatch-to-orchestrator({
  work_item_id,
  template?: { name, version? },         -- saved orchestrator template
  dag?: <DAG JSON>,                       -- OR ad-hoc DAG
  inputs: { ... },                        -- inputs to orchestrator workflow
  also_transition?: { to, note? }         -- optional: atomic status transition with dispatch
})
  → { runId, dispatched_at, playbook_attached: bool }
  Behavior:
   1. Validate item exists + caller access.
   2. Resolve playbooks: tracker.list-playbooks(work_item_id) — collects per-item +
      project-default playbooks.
   3. Inject playbooks into `inputs` as `inputs._playbooks: [{name, content_md}, ...]`
      (orchestrator stores as plain inputs; DAG author / CC's authored DAG can reference
      via {{inputs._playbooks}}). Templates designed to receive playbooks reference them
      in the first node's prompt to bootstrap CC's plan.
   4. Construct A2A call to orchestrator:
        orchestrator.workflow.run({
          template, dag, inputs (with _playbooks),
          tags: { source: "tracker", item_id: <work_item_id>, actor_email: ... }
        })
   5. Optionally atomically call transition-status with run_ref=runId.
   6. Return { runId, dispatched_at, playbook_attached }.
```

### 5.7 Activity Stream (the visibility surface — populates "Activity" tab)

```
tracker.get-activity-stream(work_item_id, { since?, limit? })
  → {
      stream: [
        { kind: "status_change",   ts, actor, from, to, note?, run_ref? },
        { kind: "comment",         ts, author, body },
        { kind: "attachment_added",ts, uploader, attachment_kind, name },
        { kind: "progress_note",   ts, actor, progress_note },
        { kind: "orchestrator_run",ts, runId, run_status, template, progress?, deliverable? },
        { kind: "orchestrator_spawn", ts, spawnId, agent, status, summary_short? },
        { kind: "orchestrator_workspace", ts, workspaceId, state, repo, branch }
      ]
    }
  Implementation:
   - tracker-local events: status_log + comments + attachments + progress_note updates
   - orchestrator-side events: 3 parallel calls to orchestrator MCP/A2A:
       runs.list({       tag_match: { source: "tracker", item_id: <id> } })
       spawns.list({     tag_match: { source: "tracker", item_id: <id> } })
       workspaces.list({ tag_match: { source: "tracker", item_id: <id> } })
     normalize results, merge, sort by ts.
   - Cached (default 5s); SSE via run.events for live update of in-flight runs.
```

---

## 6. A2A Integration with Orchestrator (Dispatch + Activity Stream)

### 6.1 Outbound (tracker → orchestrator)

Framework A2A client. Discovery via tracker's `agent-native.json` `a2a.connections.orchestrator`. Same workspace = automatic.

Outbound calls:
- `orchestrator.workflow.run({..., tags, inputs:{_playbooks:[...]} })` — dispatch
- `orchestrator.runs.list({tag_match})` — activity assembly
- `orchestrator.spawns.list({tag_match})` — activity assembly
- `orchestrator.workspaces.list({tag_match})` — activity assembly
- `orchestrator.run.state(runId)` — single-run status
- `orchestrator.run.events(runId)` — SSE (optional, for live tab update)

### 6.2 Playbook injection on dispatch

When `tracker.dispatch-to-orchestrator` is called, tracker:
1. Reads per-item playbooks + project default playbook
2. Bundles them into `inputs._playbooks: [{name, content_md}, ...]`
3. Passes to orchestrator with `workflow.run`

Authored DAGs (or ad-hoc DAGs from CC) reference `{{inputs._playbooks}}` in their first agent node's prompt to inject the guidance:

```json
{
  "id": "plan_and_execute",
  "type": "agent",
  "agent": "orchestrator-planner",
  "prompt": "You are handling work item {{inputs.item_id}}.\nFollow these playbooks (highest priority first):\n\n{{inputs._playbooks}}\n\nTask: {{inputs.task}}",
  "output_schema": { ... }
}
```

Orchestrator doesn't interpret `_playbooks` — it's just data. CC (via the agent) reads it as instruction.

If no playbooks attached, `_playbooks: []`. The agent prompt may have a fallback ("Use default judgment").

### 6.3 Tag convention (matches orchestrator §16)

All outbound dispatches AND when CC operates on an item, tags carry:
```json
{ "source": "tracker", "item_id": "PAY-14", "actor_email": "alice@..." }
```

CC running on an item should ALSO tag its ad-hoc `spawn.once` / `workspace.create` calls with the same tags so the Activity tab catches them.

### 6.4 Inbound (orchestrator → tracker)

**None.** Orchestrator never calls back. All visibility is tracker-pulled.

CC may, AFTER reading a run result, choose to call `tracker.transition-status` / `tracker.add-comment` / `tracker.set-progress` to update the item. **This is CC's decision, not orchestrator's.**

---

## 7. UI

### `/board` — Kanban board (default home)

- Columns derived from project's status scheme stages.
- Cards = work items.
- Filters: project, type, assignee, priority, blocked, search.
- Card visuals: status badge, severity chip, environment tag, priority, blocked indicator, "live" badge if `has_active_dispatch` (cached query).
- Card progress_note shown small under the title.

### `/items/:id` — Work item detail

Layout:

- **Header**: id (PAY-14) + title (editable) + type badge + status badge (clickable → transition dialog) + exec-state chip ("running" / "queued" if `has_active_dispatch`).
- **Action bar**:
  - Edit (description, priority, severity, environment, assignee)
  - Transition status (dialog with legal next-status)
  - **Dispatch to orchestrator** (panel below)
- **Metadata strip**: type, priority, severity, environment, project key, created/updated, assignee, current progress note.
- **Description** block (always rendered; placeholder when empty).
- **Tabs**:
  - **Activity** (NEW, default tab) — see §7.1
  - **Comments** — flat list + add-comment box
  - **Attachments** — files / design-docs / playbooks (separate sections)
  - **Status history** — from→to / actor / at / note / run_ref (linked)
  - **Links** — linked items

### 7.1 Activity tab (new — the visibility surface)

Reverse-chronological merged stream from `tracker.get-activity-stream(work_item_id)`. Each entry one row:

- **status_change**: "Alice transitioned 待开发 → 开发中 (run_xyz)"
- **progress_note**: "CC: exploring repo structure"
- **comment**: author + body preview, click to expand
- **attachment_added**: "Alice added playbook 'QA process v2'"
- **orchestrator_run**: card with runId / template name / status (live, SSE) / DAG node progress / "open in orchestrator" link
- **orchestrator_spawn**: row with agent name / status / tokens / short summary on hover
- **orchestrator_workspace**: row with repo / branch / state / "view diff" link → opens orchestrator UI

Filters: by source (status_change / orchestrator / CC's progress / etc.), by date range. Search.

SSE: when item has any `has_active_dispatch=true`, tab live-updates via orchestrator's `run.events` for each active run.

### 7.2 Dispatch panel

Inside Action bar's "Dispatch to orchestrator":
- Pick template (dropdown from `orchestrator.workflow.list`) OR paste ad-hoc DAG (textarea, advanced)
- Fill inputs per template's input_schema (auto-generated form)
- Preview attached playbooks ("3 playbooks will be passed to CC: 'QA process v2' (item), 'Backend conventions' (project default), ...")
- Optional: atomic status transition checkbox (e.g. → "开发中")
- Submit → `dispatch-to-orchestrator` → success toast → new activity entry appears in Activity tab

### 7.3 Attachments tab — playbook editor

For `kind: playbook`:
- Markdown editor (monaco/codemirror) with live preview
- Save → `attach-playbook` or `update-attachment`
- "Make this project default" button → updates `projects.default_playbook_attachment_id`

### `/projects` + `/projects/:id`

- Project list + create dialog
- Project settings page: status schemes, environments, default template, default playbook

---

## 8. Auth / Sharing

- Tracker uses framework auth (workspace `an_session_workspace` cookie).
- Work items via `ownableColumns()`: owner_email + org_id + visibility.
- Per-item shares via framework `sharing` skill.
- A2A to orchestrator inherits caller identity (framework-handled).

---

## 9. Explicit Non-goals

| Item | Why |
|------|-----|
| Backend infers task done | Status moves only by explicit transition action |
| Watchdog auto-status from orchestrator run completion | Tracker observes runs but never changes status from them; CC may do so explicitly |
| Auto-comment / auto-progress on dispatch / run events | If CC wants to comment / update progress, CC calls add-comment / set-progress |
| Tracker dictates CC's workflow steps | **NO.** CC's workflow shape is whatever CC decides per playbook + skills + project agents. Tracker only provides item, playbook, and Activity visibility |
| Tracker stores orchestrator run/spawn records locally | Orchestrator is source of truth; tracker queries by tag_match on demand |
| Workflow DAG execution | That's orchestrator's job |
| Model registry / agent registry | Use framework's |
| Time tracking / SLA / sprint planning | Future work item type; not v1 |
| Custom field schema per project | v1: fixed fields; v2 candidate |
| Bulk import from Jira/GitHub Issues | v1.x candidate; not core |

---

## Cross-reference

- Orchestrator design: `templates/orchestrator/docs/v3-DESIGN.md`
- A2A from tracker: §6 above + orchestrator v3 §16
- Activity stream surface uses orchestrator's `runs.list`/`spawns.list`/`workspaces.list` with `tag_match` (orchestrator v3 §8)

End of design.
