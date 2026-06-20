# Orchestrator — Frontend & Interaction Design

Complete page/interaction spec for the v2 orchestrator. Companion to
[DESIGN.md](./DESIGN.md) (§5 there points here). **Every element names the action
that feeds it; every button names the action it fires and what happens after.**
Action names are the §10 surface; data shapes are the §9 model. UI ⟂ data parity
is mandatory (everything here is an action the agent can also call).

Hard UX rules (from the repo CLAUDE.md, non-negotiable):
- shadcn/ui primitives only (no hand-rolled dropdown/popover/modal).
- Tabler icons; no emoji as first-party icons.
- **No browser `alert`/`confirm`/`prompt`** — shadcn `Dialog`/`AlertDialog`.
- **Optimistic by default**: mutate cache + navigate immediately, roll back on
  error, toast the error. Click-blocking spinner ONLY for destructive/irreversible
  ops.
- Logged-in pages are CSR; real-time via `useDbSync()` + the run-event stream.
- Light/dark theme; i18n zh/en (all strings via `t()`); shared agent composer
  stack for the chat sidebar.

---

## Conventions (unified standards — build once, use everywhere)

Everything below is **shared infrastructure**: build it once, every page composes
it. All of it is already scaffolded in the template (`app/lib/i18n.ts`,
`app/components/ui/*` shadcn set, `app/global.css` theme, `@agent-native/core/client`
hooks) — extend, don't reinvent.

### C1. i18n (grounded in `app/lib/i18n.ts`)
- Stack: `i18next` + `react-i18next`. `Lang = "en" | "zh"`; persisted to localStorage
  `orchestrator.lang` (`readStoredLang`/`persistLang`); topbar toggle flips + persists,
  **no reload**.
- **Every** user-facing string via `t("ns.key")` — nested resource trees, `en` and
  `zh` kept in parallel. Adding a page = add its keys to **both** trees (a missing
  key must fall back, never render the raw key in prod).
- **Status/exec/env/severity labels are i18n keys too.** The status scheme stores a
  stable stage `key` (e.g. `in_dev`); the display label comes from
  `t("status.${key}")` per language — so 开发中 / "In dev" is one stage, two labels.
  Never store a localized string as the canonical status.
- Numbers/dates/relative-times via `Intl` (`Intl.RelativeTimeFormat` for "2m ago"),
  not hand-formatted.

### C2. Theme (light/dark — grounded in `app/global.css`)
- Semantic HSL tokens in `:root` + `.dark` (`--background`, `--foreground`,
  `--primary`, `--muted`, `--muted-foreground`, `--border`, `--destructive`,
  `--accent`, …). Components use Tailwind token classes (`bg-background`,
  `text-muted-foreground`, `border-border`) — **never hardcode a hex/hsl**.
- Toggle adds/removes `.dark` on the root; persisted to localStorage `theme`; no reload.
- **One shared semantic color map** (`app/lib/status-colors.ts`) maps
  `statusCategory` / `execState` / `severity` / node-status → token classes. The
  **board columns, badges, and the run-canvas node tints all read this one map**, so
  a "running" blue is the same blue everywhere. Define it once; never inline a color
  per surface.

### C3. Component standards (which shadcn primitive for what — all already in `components/ui/`)
| UI need | Primitive(s) | Notes |
|---|---|---|
| Data list / table | `table` + `pagination` + `scroll-area` | wrap in one `<DataTable>` (sort/filter/empty); virtualize long lists |
| Kanban board | `card` + `scroll-area` + a dnd lib | column = scroll-area; card = shared `<WorkItemCard>` |
| Form dialog | `dialog` + `form` + `input/textarea/select/checkbox/switch` | zod-validated; inline errors |
| Destructive confirm | `alert-dialog` | the ONLY click-blocking spinner; never native `confirm` |
| Row/card actions menu | `dropdown-menu` (`⋯`) · `context-menu` (right-click) | |
| Pick one value | `select` · searchable → `command` | model picker + ⌘K palette = `command` |
| Side detail panel | `sheet` (right) · `drawer` (bottom, mobile) | node inspector diff, item drawer |
| Inline overlay | `popover` | capacity popover, filter menus |
| Tabbed content | `tabs` | item console bottom tabs, settings tabs |
| Toast | `sonner` (project standard) | success/error; `toaster`/`use-toast` are legacy |
| Loading | `skeleton` (lists/cards/canvas) · `spinner` (destructive only) | never a full-page spinner |
| Status/meta chips | `badge` | via shared `<StatusBadge>`/`<ExecBadge>`/`<SeverityChip>` |
| Tooltip | `tooltip` | blocked reason, badge meaning |
| Progress | `progress` | token budget, node done/total |
| App nav | `sidebar` | the 6-entry rail |

**Build these shared composites ONCE** (every page composes them, never re-rolls):
`<WorkItemCard>`, `<StatusBadge>`, `<ExecBadge>`, `<SeverityChip>`, `<EnvTag>`,
`<NodeCard>` (used by BOTH editor and run overlay), `<DataTable>`, `<EmptyState>`,
`<ConfirmDialog>`, `<ModelPicker>` (the §8.5 custom dropdown). A change to a badge
is then one file, not N pages.

### C4. Data & state (no hand-rolled fetch — repo rule)
- Reads: `useActionQuery(name, args)`; writes: `useActionMutation(name)` — both from
  `@agent-native/core/client` (already used in `app/hooks/use-orchestrator.ts`). A
  button with no action → **add the action first** (§11).
- Real-time: `useDbSync()` invalidates affected queries on DB change (board, lists,
  canvas). Per-run `run-events` SSE is the **item page only** (one stream, not N).
- Optimistic by default: mutate cache + reconcile on settle, rollback + toast on
  error. Click-blocking spinner only for destructive/irreversible ops.
- App state: every route writes `navigation` (+ selection) via the `navigate` action
  so the agent's `view-screen` knows the screen (DESIGN §2a/context-awareness).

### C5. Icons / composer / a11y
- **Icons:** Tabler (`@tabler/icons-react`) only; a shared icon map (type/status/exec)
  so a `bug` icon is the same everywhere. No emoji as first-party icons.
- **Agent composer:** the chat sidebar is `AgentComposerFrame` + `PromptComposer`
  (+ `TiptapComposer`) from `@agent-native/core/client` — never hand-roll a composer.
- **a11y/keyboard:** focus-visible rings, dialogs trap focus, `⌘K` palette, board
  arrow-key nav, `r`/`p` run/pause on the item page (shadcn defaults + §12).

---

## 0. Global shell (present on every page)

```
┌──────────────────────────────────────────────────────────┬──────────────┐
│ TOPBAR                                                     │              │
│  [Project ▾]  [⌘K search]   ·   capacity: 3/5 tasks · 7/12 │ AGENT CHAT   │
│                                  VM ▾   ·  [☾ theme] [文/EN]│ (orchestrator)│
│                                          [account ▾]       │              │
├────────┬─────────────────────────────────────────────────┤  message     │
│ SIDE   │                                                   │  stream      │
│  Board │              PAGE BODY                            │  ----------- │
│  Proj  │                                                   │ AgentComposer│
│  Flows │                                                   │ Frame +      │
│  Lib   │                                                   │ PromptCompo  │
│  Runs  │                                                   │ ser          │
│  Setts │                                                   │ [▸ collapse] │
└────────┴─────────────────────────────────────────────────┴──────────────┘
```

**Topbar elements**
| Element | Source | Click logic |
|---|---|---|
| Project ▾ | `list-projects` | switch active project scope (persists to `application_state.activeProjectId`, also written by `navigate`); "All projects" = global |
| ⌘K search | client index over `list-work-items`+`list-templates`+`list-projects` | command palette → jump to item/template/project |
| capacity `3/5 tasks · 7/12 VM` | `queue-status` (extend it to return live VM usage too — `get-runtime-status` does NOT expose VM counts) | click → popover listing running tasks + live VMs; numbers are `concurrencyDegree`/running and `maxConcurrentVMs`/used |
| theme toggle | localStorage `theme` | flip light/dark (no reload) |
| lang toggle | `i18n` (`orchestrator.lang`) | flip zh/en (no reload) |
| account ▾ | session | profile, sign-out |

**Sidebar nav** (6 entries, active-route highlight): Board `/`, Projects
`/projects`, Workflows `/workflows`, Library `/library`, Runs `/runs`, Settings
`/settings`.

**Agent Chat sidebar** — the orchestrator brain conversation (the standard
`AgentComposerFrame`/`PromptComposer`/`TiptapComposer` stack). You type intents
("enqueue these 3 bugs, concurrency 2", "why did PAY-14 node 'fix' fail?"); the
brain calls actions via MCP and replies. Collapsible. Every action it takes is the
same action the UI buttons fire, so the chat and the pages never diverge.

**Application-state writes** (so the agent always knows what you're looking at):
each route sets `navigation` via `navigate` (`board | project:{id} | item:{id} |
workflows | workflow:{id} | library | runs | settings`); the item page also writes
the selected `nodeRunId`. `view-screen` reports this back to the agent.

---

## 1. Page inventory + route map

| # | Page | Route | Replaces (v1.5) | Primary job |
|---|------|-------|-----------------|-------------|
| 1 | Board (PM kanban) | `/` | `_index.tsx` (task board) | manage items by status + watch the queue |
| 2 | Projects | `/projects` | — (new) | list/create projects |
| 3 | Project detail | `/projects/:id` | — (new) | one project's board + config |
| 4 | Work-item / Run console | `/items/:id` | `tasks.$id.tsx` | run + watch + steer one item |
| 5 | Workflows (templates) | `/workflows` | `workflows._index.tsx` | template catalog |
| 6 | Workflow editor | `/workflows/:id` | `workflows.$id.tsx` (JSON box) | build/edit a DAG |
| 7 | Node library | `/library` | — (new) | reusable gate/analysis nodes |
| 8 | Runs (global activity) | `/runs` | — (new) | cross-item run history/log |
| 9 | Settings / Runtime | `/settings` | `settings.tsx` | engines, vLLM, claude, concurrency |

---

## 2. Board — PM kanban (`/`)

**Purpose.** The home and the project-management surface. **Columns are the
business `status` pipeline (DESIGN §6.2a), not the automation state.** You manage
requirements/bugs/incidents/tasks through their real stages (待开发 · 测试中 ·
验收中 …); the AI execution is an **overlay** (a badge), and a separate **Queue
view** watches the AI fleet.

**Two views (toggle, top-left):**
- **Board (by status)** — default. PM kanban.
- **Queue (by execState)** — `idle · queued · running · paused · failed` lanes for
  watching what the orchestrator is running now (the §6.4 fleet).

**Board layout.** A kanban whose columns come from the **status scheme** of the
current filter (DESIGN §6.2a, `project.status_schemes`):
- **All types** → 4 columns by `statusCategory`: `待处理 · 进行中 · 已完成 · 已取消`
  (`已取消` collapsed), with the specific stage as a sub-label on each card.
  (`completed` ≠ `cancelled` so shipped vs killed never share a bucket.)
- **One type filtered** (e.g. bug) → full pipeline columns for that type
  (`待确认 · 待修复 · 修复中 · 待评审 · … · 待发布 · 已关闭`), grouped under category
  headers.
A filter bar above (project, type, priority, assignee, `blocked` toggle, `severity`,
`environment`, search).

**What each card shows** (one `work_items` row, `list-work-items`):
- `key` (`PAY-14`) + title + type badge + priority pill + project color stripe
- assignee avatar; current stage sub-label (when grouped by category)
- **`blocked` flag** — red "阻塞" chip + reason tooltip when `blocked=true`
- **environment tag** from the `environment` field (`SIT`/`UAT`/`prod`); **severity
  chip** (`SEV1…4`) on incidents; **link icons** (duplicate-of / blocked-by)
- **execState badge** when an AI run is active: `queued` ⏳ · `running` (pulsing
  "AI") · `paused` · `failed` ✗ — sourced from `exec_state` (NOT a column)
- **`statusStale` badge** (amber "AI finished — confirm status") when the watchdog
  flagged a finished run that never moved status (DESIGN §6.2b L2) → click to
  confirm the suggested status or re-prompt the orchestrator
- on Running cards a **mini node strip** (dots by node status, live)
- deliverable chip when delivered (`PR ↗` / `📄 3 files`); error one-liner on a
  failed run

**Display logic.** Real-time via `useDbSync()` (poll) — including the Running-card
dot strip (poll over `run-graph` node counts, **not** N per-card `run-events` SSE;
that's the item page §4 only). Sort within a column by priority then `created_at`.
Empty column → muted placeholder; empty board → "Create your first work item" CTA.

**Buttons → click logic** (note: **drag = business status** human move;
**⋯ menu run controls = execState** AI control — kept distinct):
| Button / control | Action fired | Result |
|---|---|---|
| `+ New work item` (primary) | opens **D1** | `create-work-item` → card at the type's first `待…` stage, `exec_state=idle` |
| **drag card between status columns** | `transition-work-item({toStatus})` | business status transition; the action validates `from→to` against the scheme (incl. rework back-edges, §6.2b); illegal drop snaps back |
| `Assign to orchestrator` / `Enqueue…` (bulk) | opens **D2** | `enqueue-work-item` ×N + `set-concurrency` → `exec_state idle→queued`; **business status unchanged** |
| concurrency inline `5 ▾` | `set-concurrency` | optimistic; worker pool widens/narrows |
| card click | `navigate(item:{id})` | → page 4 |
| card `⋯` → **Run now** | `run-start(itemId)` | `exec_state→running` |
| card `⋯` → **Pause / Cancel run** | `run-pause` / `run-cancel` (**D4**) | execState only; business status untouched |
| card `⋯` → **Block / Unblock** | `transition-work-item({blocked, reason})` | red 阻塞 chip toggles |
| card `⋯` → **Cancel item** | AlertDialog confirm | `transition-work-item({toStatus:'已取消', resolution:'cancelled'})` — business cancel, ≠ run cancel |
| `statusStale` badge → **Confirm status** | `transition-work-item({toStatus})` | clears the watchdog flag (§6.2b L2) |
| card `⋯` → **Priority ▾** | `update-work-item({priority})` | re-sorts |
| card `⋯` → **Delete** | **D8** (destructive) | `delete-work-item` |
| filter chips | client-side | filter (no server call) |

**States.** Loading = skeleton cards. Mutation failure = card rolls back + toast.

---

## 3. Projects (`/projects`) + project detail (`/projects/:id`)

**List `/projects`.** Grid of project cards: name, `key`, repo-linked icon
(present iff `repo` set), open-work-items count, default-workflow name. Source
`list-projects`.
- `+ New project` → **D3** → `create-project`.
- card click → `/projects/:id`.

**Detail `/projects/:id`.** Header strip (name · key · repo remote link · default
workflow) + a project-scoped copy of the Board (page 2, filtered to this project).
Source `get-project` + `list-work-items({projectId})`.
- `Project settings` gear → **D3 (edit mode)** → `update-project` (repo remote /
  default branch / workingDir / default workflow / environments / status-scheme).
  (Sharing/members deferred — owner-scoped for now, DESIGN §12.)
- `+ New work item` (pre-fills this project) → **D1**.

---

## 4. Work-item / Run console (`/items/:id`) ⭐ the core screen

**Purpose.** Run, watch, and steer one work item's execution — the live DAG, the
selected node's detail, the terminal, and the deliverable.

**Header bar.** `PAY-14 · title · status badge` on the left; on the right the
**run controls** (enabled per status):
| Button | Enabled when | Action | After |
|---|---|---|---|
| `Run` / `Re-run` | not running | `run-start(itemId, {tokenBudget?})` | `exec_state→running`; canvas starts animating |
| `Pause` | running | `run-pause(runId)` | stop scheduling new nodes; running ones finish |
| `Resume` | paused | `run-resume(runId)` | replays journaled NodeRuns, schedules the rest (§1.7) |
| `Cancel` | running/paused | **D4** | `run-cancel(runId)` (cooperative abort) |
| `Token budget` chip | always | inline edit → carried into `run-start` | shows remaining (from `run-get`) |
| deliverable chip | when done | — | opens PR ↗ or the file list |

**Body — 3 regions.**

**(a) Left: live DAG canvas (read-only run overlay).** Source `run-graph(runId)`,
animated by `run-events`/`useDbSync`. Same React-Flow renderer as the editor but
non-editable: nodes tinted by status (`pending` grey · `running` blue pulse ·
`done` green · `failed` red · `skipped` dashed), iteration counters on loop nodes,
dynamically-added fanout children appear live with a `dynamic` glyph. Click a node
→ selects it (writes `application_state.nodeRunId`) → fills region (b).

**(b) Right: node inspector.** Source `node-get(runId, nodeRunId)`:
- title, type, `engine`/`model`, executor (vllm/remote/claude), `effort`
- timings (started/ended/duration), `tokens_spent`, `attempts`
- input artifact (id + summary, expandable) and output artifact (typed JSON if
  `outputSchema`, else text/diff)
- `runtime` info: microVM id, branch `an/run-<runId>`, onFailure policy
- live **terminal** — in-VM claude/git output streamed via microsandbox
  `execStream` into an `xterm` panel (not host `node-pty`; the VM owns the process)
- node buttons:
  | Button | Action | After |
  |---|---|---|
  | `Re-run node` | `run-retry-node(runId, nodeRunId)` | that one VM destroyed+rebooted; siblings untouched |
  | `Edit & re-run` | **D5** → `node-override(runId,nodeRunId,patch)` | edit prompt/model/effort, re-run just this node |
  | `View diff` | opens **Sheet** with the node's commit diff (`node-get` output_ref) | read-only diff view |
  | `Open sub-run` | `navigate` to the sub-agent run | for `@app`/nested |

**(c) Bottom tabs.**
- **Overview** — run summary: counts by status, started/elapsed, budget remaining,
  deliverable. Source `run-get`.
- **Steps timeline** — every NodeRun as a row (status, model, duration, tokens),
  ordered by start; click row = select node in (a)/(b). Source `run-graph`.
- **Terminal** — full-height PTY of the focused node (or run-level multiplexed).
- **Deliverable** — PR card (title/url/branch) or file list with download.
  Source `run-get.deliverable`.
- **Events** — raw `run-events` stream (debug), filterable by node.

**States.** No workflow attached yet → center prompt "Attach a workflow to run"
with a workflow picker (`get-work-item` shows `workflowRunId == null`). Run not
started → canvas shows the static template greyed with a big `Run`. Cancelled mid
-edit → banner "abort is cooperative; node X finished its current step" (§4.3).

---

## 5. Workflows / templates (`/workflows`)

**List.** Template cards: name, node count, `version`, last-used, "used by N
items". Source `list-templates`.
- `+ New workflow` → blank editor (page 6).
- `Promote from run…` → **D9**: pick a successful `workflow_run` →
  `promote-run-to-template(runId)` → new template card.
- card click → editor; card `⋯` → duplicate / delete (**D8**) / set as a project
  default.

---

## 6. Workflow editor (`/workflows/:id`) ⭐ React Flow canvas

**Library:** `@xyflow/react` (add to deps). Replaces the v1.5 raw-JSON textarea.

**3-pane layout.**

**Left — Palette.** Two tabs:
- **Nodes**: drag a primitive type onto canvas (`agent · tool · parallel · fanout ·
  join · branch · loop · subworkflow · human · end`; `start` auto-present).
- **Library**: drag a pre-built node_def (`code-review`, `run-tests`, `git-commit`,
  `git-push`, `open-pr`). Source `list-node-defs`. Dropped library nodes show a
  lock glyph (config inherited, overridable per-use).

**Center — Canvas.** Node cards (type icon · title · engine/model badge · runtime
badge `microvm`/`none`); drag from a node's port to another to make an edge;
edges show `when` labels; container nodes (`parallel`/`loop`/`fanout`) render as
group frames you drop children into.

**Right — Inspector** (selected node). Fields write into the in-memory graph
(saved on `Save`):
- title; `assignee` (`local` | `@app` picker)
- **engine/model picker** — a CUSTOM dropdown fed by `list-runtime-configs` +
  built-in engines (NOT the framework composer picker; §8.5 white-list). Shows
  vLLM endpoints + claude + hosted.
- `effort` (low/medium/high); `prompt` editor with `{{deps.<id>.output}}`
  autocomplete (suggests upstream node ids); `outputSchema` (JSON schema editor)
- condition builder (for `branch`: jsonpath/status/agent — §3.5)
- `await`, `retry {max,backoffMs}`, `timeoutMs`
- **runtime** sub-panel: `kind` (microvm/none), image, baseRef, branch, mounts,
  creds (multi-select of registered secret keys), `resources {cpus,memMB}`,
  `onFailure` (rollback/recreate/keep)
- fanout: `itemsFrom` (upstream node picker) + `maxConcurrency`
- loop: `condition` + `maxIterations` + `dedupeKey` + `dryRounds`

**Live validation banner** (top): acyclic base graph, `fanout.itemsFrom` resolves,
`loop` has condition+maxIterations, `branch` edges have `when`, single start/end,
and the **implicit-barrier lint** flagging a possibly-unintended `join` (§1.3).
Errors block `Save`; warnings don't.

**Buttons → logic**
| Button | Action | After |
|---|---|---|
| `Save` | `save-template(graph)` | optimistic; toast; bumps `version` |
| `Validate` | client lint | shows banner detail |
| `Run once…` | **D1** (pick/create a work item, prefilled with this template) → `run-start` | jumps to page 4 |
| `JSON view` | toggles the raw-JSON `<Textarea>` (power-user fallback, both edit the same model) | — |
| `Save as new` | `save-template` (new id) | duplicate |

### 6.3 Implementation approach (React Flow)

The editor and the run overlay (§4a) are **the same canvas component** in two
modes — build it once.

- **Library:** `@xyflow/react` (add to deps; `pnpm view @xyflow/react version` at
  build). One `<WorkflowCanvas mode="edit"|"run">`.
- **Custom node types** registered per graph node-type (`agent · tool · parallel ·
  fanout · join · branch · loop · subworkflow · human · end` + dropped library
  nodes), all rendered by the **shared `<NodeCard>`** (C3) — in `run` mode the same
  card is tinted by NodeRun status via the C2 color map. One renderer, two modes.
- **Container nodes** (`parallel`/`loop`/`fanout`) = React Flow **group/parent
  nodes**; children dropped inside set their `parentNode`. Edges carry a `when`
  label via a **custom edge** component.
- **Controlled state ↔ JSON.** Canvas state (nodes+edges) is the in-memory model;
  it serializes 1:1 to `workflow_templates.graph` JSON. The **JSON-view `textarea`
  edits the exact same model** (parse on toggle) — so the canvas and the
  agent-editable JSON (`save-template`) never diverge.
- **Validation = one shared validator.** Extend the v1 `validateWorkflowDag`
  (`shared/types.ts`) for the v2 node types; the **client lint banner AND the
  `save-template` action call the same function** (no double truth). Errors block
  Save; warnings (the implicit-barrier lint, §1.3) don't.
- **Run overlay** = `mode="run"`: read-only, nodes tinted by `run-graph` status,
  iteration counters, live `dynamic` children; driven by `run-events` + `useDbSync`.
  Click a node → writes `application_state.nodeRunId` → fills the §4(b) inspector.
- **Persistence:** `save-template` (optimistic, bumps `version`). Inspector edits
  write the in-memory model; nothing hits the server until Save.

---

## 7. Node library (`/library`)

**Purpose.** Manage reusable, vetted gate/analysis nodes (`node_defs`, §3.7) — the
fixed `run-tests`/`git-push`/`open-pr` gates and locked-down `code-review` agents.

**Layout.** Card list: `key`, kind (`tool`/`agent`), `version`, "used by N
templates", a short config preview. Source `list-node-defs`.

**Buttons → logic**
| Button | Action | After |
|---|---|---|
| `+ New library node` | **D7** | `save-node-def` |
| card `Edit` | **D7 (edit)** | `save-node-def` (new version) |
| card `Version ▾` | — | view/pin versions |
| card `Delete` | **D8** | `delete-node-def` (blocked if referenced; shows where) |

---

## 8. Runs (global activity) (`/runs`)

**Purpose.** Cross-item run history + a place to find a run not on the board.

**Layout.** Table: run id, work item, template, status, started, duration,
tokens_spent, deliverable. Source a `list-runs` (add to §10) or `run-get` per row.
Filters: status, project, date. Row click → page 4 for that run.

---

## 9. Settings / Runtime (`/settings`) — extends the shipped v1.5 page

Tabbed (the Runtime tab already ships):
- **Runtime** (built v1.5, extend): vLLM/OpenAI-compatible endpoint table
  (`list-runtime-configs`; `+ Add endpoint` → form → `save-runtime-config`;
  `Activate` → `activate-runtime`; `Test` → `test-runtime-config` (the missing
  vLLM test, parity with claude). The **Claude Code card** (built this session):
  shows login status from `get-runtime-status` (logged-in/expired/not-logged-in
  badge + `claude login` guidance + real `Test run` result via `start-claude-code`).
  Concurrency controls: `concurrencyDegree` + `maxConcurrentVMs` sliders →
  `set-concurrency` / a runtime config.
- **Images** — base microVM image registry (image ref per project or per language
  runtime, build status; DESIGN §7.4.8). No "project kind" — a project has none.
  New for phase 4.
- **Credentials** — which secret keys are registered + which a runtime mounts
  (reuse the framework secrets/Vault surface; never shows values).
- **Account** — profile. (Members/sharing deferred — owner-scoped for now, DESIGN §12.)
- **Appearance** — theme, language.

---

## 10. Dialog catalog (shadcn `Dialog`/`AlertDialog` — never native)

| ID | Title | Trigger | Fields | Submit action | Notes |
|----|-------|---------|--------|---------------|-------|
| **D1** | New work item | Board / project / editor | project ▾, type, title, description, priority, **workflow ▾ (optional — blank = orchestrator auto-builds the DAG, DESIGN §6.3)** | `create-work-item` | card at the type's first todo stage, `exec_state=idle` |
| **D2** | Enqueue to orchestrator | Board "Enqueue…/Assign" | multiselect idle items, workflow ▾, concurrencyDegree | `enqueue-work-item` ×N + `set-concurrency` | bulk; sets `exec_state→queued`, business status unchanged |
| **D3** | New / edit project | Projects | name, key, repo {remote, defaultBranch, workingDir}, default workflow, `environments` list, status-scheme (JSON/advanced) | `create-project` / `update-project` | repo optional; sharing UI deferred (owner-scoped for now, §12) |
| **D4** | Cancel run | run controls (AlertDialog) | confirm text | `run-cancel` | ⚠ destructive: explains cooperative abort + VM teardown |
| **D5** | Edit & re-run node | node inspector | prompt, model ▾, effort | `node-override` | re-runs that node only |
| **D7** | New / edit library node | Library | key, kind, (tool→action) / (agent→prompt+model+outputSchema), version | `save-node-def` | versioned |
| **D8** | Delete confirm | any delete (AlertDialog) | confirm | `delete-*` | ⚠ destructive; lists references if blocked |
| **D9** | Promote run → template | Workflows | pick successful run | `promote-run-to-template` | distills executed graph |

(D6 intentionally removed — model-compare was cut.)

All dialogs: `Esc`/overlay-click cancels; primary button shows a spinner only while
the mutation is in flight; validation inline; on error keep open + show the error.

---

## 11. Per-page hook/action map (parity check)

| Page | Reads | Writes |
|------|-------|--------|
| Board | `list-work-items`, `queue-status` | `create-work-item`, `transition-work-item` (status/blocked/cancel), `enqueue-work-item`, `set-concurrency`, `run-start/pause/cancel`, `update-work-item` (non-status), `delete-work-item` |
| Projects | `list-projects`, `get-project`, `list-work-items` | `create-project`, `update-project` |
| Item/Run | `get-work-item`, `run-get`, `run-graph`, `node-get`, `run-events` | `run-start/pause/resume/cancel`, `run-retry-node`, `node-override` |
| Workflows | `list-templates` | `save-template`, `promote-run-to-template`, `delete-template` |
| Editor | `get-template`, `list-runtime-configs`, `list-node-defs` | `save-template` |
| Library | `list-node-defs` | `save-node-def`, `delete-node-def` |
| Runs | `list-runs`, `run-get` | (control via item page) |
| Settings | `list-runtime-configs`, `get-runtime-status` | `save-runtime-config`, `activate-runtime`, `delete-runtime-config`, `test-runtime-config`, `set-concurrency`, `start-claude-code` |

Every write above is an existing/§10 action → the agent does the same through MCP.
If a button needs something with no action, **add the action first** (UI never
hand-rolls a REST call — repo rule).

---

## 12. Cross-cutting interaction patterns

- **Optimistic mutations**: create/priority/enqueue/concurrency update cache +
  reconcile on settle; rollback + toast on error. Run-control buttons flip status
  immediately.
- **Destructive ops** (cancel, delete) → `AlertDialog` + the only allowed
  click-blocking spinner.
- **Real-time**: board dot-strips, run canvas tints, node terminal all driven by
  `useDbSync()` + `run-events`; no manual refresh button.
- **Loading**: skeletons (cards/rows/canvas), never a full-page spinner.
- **Empty states**: every list has a purposeful empty CTA (create item / add
  endpoint / new template).
- **Errors**: inline on forms; toast on background mutations; a failed node shows
  its error in the inspector with `Re-run`/`Edit & re-run`.
- **Keyboard**: ⌘K palette; `r` run, `p` pause on the item page; arrow-keys move
  node selection on the canvas.
- **i18n/theme/a11y**: all copy via `t()` (en+zh); semantic color tokens for
  light/dark; focus-visible rings; dialogs trap focus.

---

## 13. Build order (mirrors DESIGN.md §12 phases — UI ships with each)

1. **Phase 1 (engine)** → Item/Run console read-only (canvas + inspector +
   timeline from `run-graph`/`node-get`), run controls. Board minimal.
2. **Phase 3 (PM + queue)** → full Board (kanban + D1/D2 + concurrency), Projects,
   Library, the promote flow. This is the bulk of the usable product.
3. **Phase 2 (editor)** → React-Flow editor (defer until JSON authoring hurts; for
   a solo user the run console + library + JSON is enough first).
4. **Phase 4 (microVM)** → node terminal (PTY), Settings → Images/Credentials,
   diff viewer.
5. **Phase 5** → per-node model picker polish, vLLM Test button.

UI value lands with phases 1+3 (watch + queue + steer) before the editor and the
microVM-only surfaces.
