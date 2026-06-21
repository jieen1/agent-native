---
name: routines
description: >-
  How to create, edit, enable/disable, delete, and run routines in the Routines
  app — scheduled (cron), event-triggered, and deterministic kinds. Covers the
  routine actions, cron schedule semantics, event subscriptions and
  natural-language conditions, the cross-app event bridge, calling another app
  from a scheduled routine over A2A, deterministic single-step routines, the
  template library, run history, the "try it once" dry-run, ad-hoc keys, the
  name/slug rule, and how the engine runs a routine. Use whenever the user asks
  to set up, change, pause, resume, run, inspect, or remove a routine ("every
  morning", "each weekday at 8:30", "when a plan is created", "did my routine
  run", "stop running X").
metadata:
  internal: true
---

# Routines — Scheduled & Event Automations

## What a routine is

A **routine** is an instruction the agent runs automatically — either on a cron
**schedule** or when a framework **event** fires. It is stored as a single
resource file, `jobs/{name}.md`, owned by the requesting user. The file's
frontmatter holds the trigger and flags; the file body is the natural-language
instruction the agent executes each time the routine runs.

A routine has a **kind**:

- **schedule** — runs on a cron expression (covered first, below).
- **event** — runs when a chosen bus event fires, optionally gated by a
  natural-language condition (see "Event routines").

A routine also has a **mode**:

- **agentic** (default) — a fresh agent loop runs the natural-language
  instructions each time the routine fires.
- **deterministic** — a single fixed step (a `web-request` or an `action` call,
  declared as a fenced ```json block in the body) runs with **no agent loop and
  no LLM**. Editable in the UI via the mode switch; the step is Zod-validated on
  save. See "Deterministic routines" below.

## The action surface (single source of truth)

Drive everything through these actions. The agent calls them as tools; the UI
calls the same actions through `useActionQuery` / `useActionMutation`. Never
hand-write `jobs/*.md` frontmatter or touch the resource store directly.

| Action                   | Read/Write | Purpose                                                                                                                                                                                    |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list-routines`          | R          | List the current user's routines, both kinds (name, kind, cron/event, human-readable schedule, enabled, last/next run).                                                                    |
| `get-routine`            | R          | Get one routine: summary + its instructions body.                                                                                                                                          |
| `save-routine`           | W          | Create or update a routine. `mode` is `create` or `update`; `kind` is `schedule` or `event`.                                                                                               |
| `set-routine-enabled`    | W          | Pause (`enabled:false`) or resume (`enabled:true`) a routine.                                                                                                                              |
| `delete-routine`         | W          | Delete a routine by name.                                                                                                                                                                  |
| `list-routine-templates` | R          | List the built-in routine templates the user can fork (id, name, description, category, trigger details). Static catalog; same for everyone.                                               |
| `fork-routine`           | W          | Fork a template (by `presetId`) into a new routine the user owns. Optional `name`; a `-2`/`-3` suffix is appended on collision. The fork is then a normal, independently editable routine. |
| `list-trigger-events`    | R          | List the bus events an event routine can subscribe to (name, description, example payload). Call before creating an event routine.                                                         |
| `list-routine-runs`      | R          | List run history (status, duration, error, trigger, the chat `threadId`). Optionally filter by routine `name`.                                                                             |
| `run-routine`            | W          | Run a routine once now ("try it"). Schedule routines run immediately (without advancing `nextRun`); event routines evaluate the condition against a sample payload and dispatch.           |
| `view-screen`            | R          | See the current screen, the user's routines, and which routine is being edited. Call this first when the user's visible context matters ("change _this_ one").                             |
| `navigate`               | W          | Move the UI to `routines`, `routine-edit` (+`routineName`), `runs` (+`routineName`), `keys`, or `chat`.                                                                                    |

In dev, call an action with `pnpm action <name> --flag=value`. In production use
the native tool of the same name. The action schema is authoritative.

## Creating a routine

Call `save-routine` with `mode: "create"`:

```
pnpm action save-routine --mode=create \
  --displayName="Morning Briefing" \
  --schedule="30 8 * * *" \
  --instructions="Compile my morning briefing and email it to me." \
  --enabled=true
```

- **`displayName`** is the human label; it may contain spaces / non-ASCII.
- **`name`** is the slug file name (`jobs/{name}.md`). If you omit `name`, it is
  derived by slugging `displayName` (see the name rule below). Pass `name`
  explicitly when you want a stable file name independent of the label.
- **`schedule`** is a 5-field cron expression (see cron semantics). It is
  validated before anything is written — an invalid cron is rejected and **no
  file is created**.
- **`instructions`** is the NL body the agent runs each tick. Keep it a concrete,
  self-contained task ("Summarize unread mail from today and post it to me"),
  because it runs with no chat history.
- **`enabled`** defaults to `true`. Pass `false` to create a routine paused.
- **`domain`** (optional) is a free-form grouping tag.

`mode: "create"` **refuses to overwrite** an existing routine of the same name —
if the user wants to change one, use `update`.

## Starting from a template (the template library)

The app ships a small **template library** — ready-made routines covering all
three trigger classes: a scheduled morning briefing (`daily-briefing`), a
scheduled evening recap (`evening-recap`), a scheduled mail triage
(`unread-mail-triage`), a cross-app event recap (`pr-recap-on-plan`), and a
deterministic webhook ping (`daily-webhook-ping`). Forking one is the fastest way
to get a working routine; it is then a normal routine the user owns.

The `daily-briefing` and `evening-recap` presets are the **automatic briefing**
routines: each is a weekday cron (`30 8 * * 1-5` morning, `30 18 * * 1-5`
evening) whose body calls the chief-of-staff app over A2A (see "Calling another
app from a scheduled routine" below). The evening preset passes `kind=evening` so
Chief-of-Staff compiles an end-of-day recap rather than a morning briefing.

- **`list-routine-templates`** returns the catalog: each template's `id`,
  `displayName`, `description`, `category` (`schedule` / `event-cross-app` /
  `deterministic`), `triggerType`, `mode`, and trigger details. The catalog is a
  bundled constant — it is the same for every user and never reflects the user's
  own routines.
- **`fork-routine`** copies one template into the current user's routines:

  ```
  pnpm action fork-routine --presetId=daily-briefing
  pnpm action fork-routine --presetId=pr-recap-on-plan --name="My PR recap"
  ```

  - The new routine is owned by the current user, enabled by default, and fully
    independent — edit / pause / delete it like any other routine.
  - The slug defaults to the preset id (or your `--name`, slugged). On a
    same-name collision a numeric suffix is appended (`daily-briefing-2`), so
    forking the same template twice never overwrites the first.
  - Forking is **copy-then-own**: the template is not linked. Later edits to the
    user's routine do not touch the template, and vice versa.

In the UI, the Routines list has a **Templates** button (and the empty state
offers "Browse templates"); the `/routines/templates` page lists the catalog and
"Use this template" forks it, landing on the new routine's edit page.

## Editing a routine

Call `save-routine` with `mode: "update"` and the existing `name`:

```
pnpm action save-routine --mode=update \
  --name=morning-briefing \
  --schedule="0 9 * * 1-5" \
  --instructions="New instructions."
```

`mode: "update"` **refuses to create** a routine that does not exist. Update
replaces the schedule/instructions you pass and **preserves the engine-written
run history** (`lastRun`, `lastStatus`, `createdBy`); it drops the stale
`nextRun` so the scheduler recomputes the next fire time from the new cron.

To change only the instructions, pass the unchanged `schedule` along with the
new `instructions` (schedule is required by the schema). To inspect the current
values first, call `get-routine --name=...`.

## Pausing and resuming (the `enabled` flag)

Do **not** delete a routine to stop it temporarily — toggle `enabled`:

```
pnpm action set-routine-enabled --name=morning-briefing --enabled=false   # pause
pnpm action set-routine-enabled --name=morning-briefing --enabled=true    # resume
```

When `enabled` is `false`, the engine **skips the routine on every tick** (it is
never executed), but the file and its instructions are preserved. Resuming sets
`enabled:true` and lets the scheduler recompute the next run from the cron.

## Deleting a routine

```
pnpm action delete-routine --name=morning-briefing
```

Deletion is permanent. Prefer pausing with `set-routine-enabled --enabled=false`
unless the user clearly wants it gone. `delete-routine` returns
`{ deleted: false }` when no matching routine exists for the user (e.g. wrong
name) — confirm the name with `list-routines` first if unsure.

## Event routines

An **event routine** runs when a framework bus event fires for the user, instead
of on a clock. Create one with `save-routine --kind=event`:

```
pnpm action list-trigger-events          # discover valid event names first
pnpm action save-routine --mode=create --kind=event \
  --displayName="On new plan" \
  --event="plan.created" \
  --condition="the plan is a recap" \
  --instructions="Summarize the new plan and notify me." \
  --enabled=true
```

- **`event`** is required and must be a real event name — call
  `list-trigger-events` first; do not guess. The list covers two kinds of
  events: **same-process** events registered in this process (built-ins like
  `agent.turn.completed` and anything this app registers) and **cross-app**
  events from sibling apps (e.g. `plan.created`, `mail.message.received`),
  annotated with their source app (see "Cross-app event routines" below).
- **`condition`** is an optional natural-language gate. When set, the event
  payload is evaluated against it (by a small classifier) before the routine
  runs — e.g. only react to `plan.created` when "the plan is a recap". Leave it
  empty to run on every occurrence of the event. The condition is evaluated
  against the **real event payload** the same way for same-process and cross-app
  events.
- **`sourceApp`** identifies which app emits the event. It is set automatically
  when you pick a cross-app event from `list-trigger-events`; leave it empty for
  same-process events (`sourceApp` empty = self). The two paths are mutually
  exclusive at dispatch: a same-process event only fires triggers with no
  `sourceApp`, and a cross-app event only fires triggers whose `sourceApp`
  matches the emitting app.
- **`schedule` is not used** for event routines; the app writes it empty so the
  cron scheduler never picks the routine up. Each routine runs through exactly
  one engine path.
- Saving an event routine immediately (un)subscribes it (same-process) or makes
  it visible to the event-bridge poller (cross-app) — no restart needed.

Switching a routine's kind is clean: changing schedule → event blanks the cron;
event → schedule clears the event, condition, and `sourceApp`.

### Cross-app event routines (the event bridge)

A cross-app event routine reacts to an event emitted by a **different app's
process** — there is no shared event bus across processes, so the framework
delivers these over a durable pull-based **event bridge**:

- Every `emit()` in any app appends a row to that app's durable `event_log`
  (`{ seq, owner_email, name, payload, emitted_at }`) **after** its in-process
  dispatch — the same-process path is never blocked or changed by this.
- The Routines process runs a **bridge poller** on a `setInterval` (default
  ~15s, alongside the cron scheduler). Each tick it groups enabled cross-app
  event routines by `sourceApp`, resolves each source app's URL via
  `discoverAgents`, signs an A2A caller JWT (`resolveA2ACallerAuth`, scoped to
  the routine owner), and pulls
  `GET <sourceAppUrl>/_agent-native/event-log?since=<cursor>&names=<csv>`. That
  endpoint is **owner-scoped**: a JWT for user A only returns A's events.
- Each new event runs the **same** matching → `condition-evaluator` → dispatch
  path as a same-process event (only the entry point and the `sourceApp` filter
  differ), creating a routine run and chat thread on a match.
- A persisted **cursor** per `(sourceApp, owner)` advances to the max `seq`
  delivered, so each event is processed **exactly once** and a Routines restart
  resumes from the cursor without re-firing or dropping events emitted while it
  was down.

Practical guidance:

- Always call `list-trigger-events` first and pick the event from the list; that
  writes `sourceApp` for you. Do not hand-type a cross-app event name without
  its source app — a `plan.created` with no `sourceApp` is treated as a
  same-process event and the bridge will never deliver it.
- The source app must be discoverable in the workspace (registered in the
  workspace manifest) for the poller to resolve its URL. An undiscoverable or
  unreachable source app is skipped for that tick without stalling the others;
  delivery resumes once it is reachable (the cursor guarantees no gap).
- Same-process vs cross-app is invisible to the routine body — the agent
  receives the event name, id, and payload identically either way.

## Run history

Every run — scheduled, event, or manual — is recorded. Use `list-routine-runs`
to answer "did it run" and "why did it fail":

```
pnpm action list-routine-runs                      # all of the user's runs
pnpm action list-routine-runs --name=morning-briefing --limit=20
```

Each row has the routine name, kind, `trigger` (cron / event name / `manual`),
`status` (`running` → `success` | `error` | `skipped`), `startedAt`,
`finishedAt`, `durationMs`, any `error`, and the `threadId` the run created. The
UI links each row to that chat thread so the user can see exactly what the agent
did. In the UI, run history lives at `/routines/{name}/runs` (or via
`navigate --view=runs --routineName=...`).

## Dry-run ("try it once")

`run-routine` runs a routine once, on demand, so the user can test it without
waiting for the next trigger:

```
pnpm action run-routine --name=morning-briefing
pnpm action run-routine --name=on-new-plan \
  --samplePayload='{"plan":{"kind":"recap"}}'
```

- **Schedule routines** execute their instructions immediately through the agent
  and record a `trigger:"manual"` run. This does **not** advance the cron
  `nextRun` — the regular schedule is untouched.
- **Event routines** evaluate the `condition` against the `samplePayload` you
  pass, and if it matches, dispatch through the real event path (creating a run
  and thread). The result reports whether the condition matched, so the user
  learns why a routine would or would not fire for a given event.

## Keys (ad-hoc secrets)

Routines that call external services must never embed secrets in their
instructions. Instead, the user stores a key once and the routine references it
as `${keys.NAME}`:

- Manage keys in the UI at `/routines/keys` (or `navigate --view=keys`): create,
  rotate, delete, and set a per-key **URL allowlist**. Values are write-only —
  the UI shows only the last 4 characters.
- In a routine body, use `${keys.SLACK_WEBHOOK}` in a web request. The engine
  substitutes the value at run time, enforces the key's URL allowlist (a request
  to an origin outside the list is blocked), and the plaintext never enters the
  routine body, the agent context, or logs.
- You generally do not call a keys action directly; tell the user to add the key
  on the Keys page, then reference it by name in the instructions.

## The `name` / slug rule

- The routine `name` is the file name `jobs/{name}.md` and must be a slug:
  lowercase, `[a-z0-9-]` only, dashes collapsed and trimmed (max 64 chars).
- The **display name and the file name are decoupled**: a `displayName` of
  `"Morning Briefing!"` slugs to `morning-briefing`.
- `save-routine` slugs `name` (or `displayName`) for you — pass natural text and
  let it normalize. If nothing usable remains after slugging (e.g. all
  punctuation), the action errors; give it at least one `[a-z0-9]` character.
- All `name`-taking actions (`get-routine`, `set-routine-enabled`,
  `delete-routine`, `save-routine --mode=update`) slug the `name` the same way,
  so `"Morning Briefing"` and `morning-briefing` resolve to the same routine.

## Cron schedule semantics

`schedule` is a standard **5-field** cron expression:
`minute hour day-of-month month day-of-week`.

Common patterns (offer these as presets when the user is vague):

| Cron           | Meaning                              |
| -------------- | ------------------------------------ |
| `*/15 * * * *` | Every 15 minutes                     |
| `0 * * * *`    | Every hour, on the hour              |
| `30 8 * * *`   | Every day at 8:30 AM                 |
| `0 9 * * 1-5`  | Every weekday (Mon–Fri) at 9:00 AM   |
| `0 8 * * 1`    | Every Monday at 8:00 AM              |
| `0 0 1 * *`    | First day of every month at midnight |

Rules and tips:

- Day-of-week: `0`/`7` = Sunday, `1` = Monday … `6` = Saturday. `1-5` =
  weekdays. `MON-FRI` is also accepted.
- The schedule is validated on save; if the user gives an invalid expression,
  the action returns a clear error and writes nothing — fix the cron and retry.
- `list-routines` / `get-routine` return a human-readable `describeCron`
  (e.g. "Every weekday at 8:30 AM"). Echo that back to confirm intent rather
  than reading the raw cron to the user.
- Schedules run in the server's clock. There is no per-routine timezone field in
  this phase — if the user names a timezone, set the cron to the equivalent
  server-time hour and say so.

## How the engine runs a routine

The framework runs an in-process scheduler automatically — you do **not** wire
up any cron yourself. On each tick the scheduler:

1. Loads every `jobs/*.md` resource.
2. Skips any routine that is **disabled** or **not yet due** (next run in the
   future).
3. For a **due, enabled** routine, opens a fresh chat thread and runs the
   routine's instructions as the owning user, then records the next run time.

So creating an enabled routine with a valid cron is all that's needed for it to
start firing — there is no separate "activate" step beyond `enabled:true`.

## Calling another app from a scheduled routine (A2A)

A scheduled **agentic** routine runs in the Routines process's own agent loop,
which holds **only this process's tools** — it cannot directly call another app's
action (e.g. chief-of-staff's `compile-briefing` lives in a different process).
To reach another app, the routine body instructs the agent to use the **A2A
`call-agent` tool** in its loop: it invokes the target app's agent with a
natural-language prompt, the caller's identity is forwarded, and the target app's
agent does the work with its own full tool surface and replies.

This is exactly how the `daily-briefing` / `evening-recap` presets work: their
body says to call the `"chief-of-staff"` agent over A2A with a prompt like
"Compile today's briefing and notify me" (the evening one adds `kind=evening`),
then summarize what it returned. Chief-of-Staff then runs its own
`compile-briefing` → `update-briefing` two-step and replies. Write cross-app
scheduled routines the same way: tell the agent which app to call and what to ask
for — do **not** try to name a tool from another app's process directly.

> Note: this A2A reach-out from the scheduled-routine agent loop depends on the
> `call-agent` tool being present in the scheduler's tool set. The cross-app
> **event** poller (above) already signs its own A2A JWT to pull event logs; the
> scheduled-routine path reaches other apps through the in-loop `call-agent`
> tool.

## Deterministic routines (no LLM)

A **deterministic** routine runs a single fixed step with **no agent loop and no
LLM** — use it for a mechanical action that never needs reasoning (a fixed
webhook POST, a fixed action call). Both schedule and event routines can be
deterministic. The step is declared as a fenced ```json block in the routine
body, in one of two shapes (§1.5.10):

````
```json
{ "kind": "web-request", "method": "POST", "url": "https://hooks.example.com/${keys.STATUS_WEBHOOK}", "headers": { "Content-Type": "application/json" }, "body": "{\"text\":\"daily status ping\"}" }
```
````

```json
{ "kind": "action", "action": "<a registered action name>", "params": { } }
```

- **`web-request`** runs through the framework fetch tool: `${keys.X}`
  placeholders are substituted, the key's URL allowlist and SSRF guard are
  enforced, and the plaintext secret never enters the body or logs.
- **`action`** calls a registered action directly with the given `params`, under
  the routine owner's request context.
- `save-routine` **Zod-validates** the declaration: a missing field, unknown
  `kind`, or a multi-step array is rejected with a field-level reason and **no
  file is written**. Fix the declaration and retry.
- In the UI, switch a routine's mode to **deterministic** to edit the step
  fields; the `daily-webhook-ping` template is a ready-made example to fork.

Every deterministic run is recorded in run history like an agentic one (status,
duration, error), just without a chat thread of agent reasoning.

## Showing the user where things are

- Call `view-screen` first when the user refers to "this routine" or "the one
  I'm editing" — it returns the current screen, the user's routines, and the
  routine being edited, so you act on the right one.
- Use `navigate` to take the user somewhere after a change:
  `navigate --view=routine-edit --routineName=morning-briefing` opens the
  editor; `navigate --view=routines` opens the list.

## Hard rules

- Every routine is **owner-scoped**: you can only read, change, or delete the
  current user's routines. Another user's routine simply is not found. Do not
  attempt to reach across owners.
- Always go through the actions above. Never hand-assemble `jobs/*.md`
  frontmatter, and never write to the resource store directly — the actions own
  serialization (explicit `triggerType: "schedule"`, `mode: "agentic"`) so the
  scheduler reads the file correctly.
- Never put secrets (API keys, tokens, webhook URLs) in `instructions`. Reference
  stored credentials by name (e.g. `${keys.SLACK_WEBHOOK}`); the value is
  substituted server-side and never enters the routine body or logs.
