---
name: chief-of-staff
description: >-
  How the Chief-of-Staff agent compiles and polishes a daily cross-app briefing.
  Use whenever the user asks to compile, refresh, or polish today's briefing, or
  to pull together what needs their attention across mail, calendar, brain, and
  analytics. Covers the two-step compile -> update-briefing sequence, the
  AI-writes-prose rule, brain routing, the analytics caliber, the morning/evening
  auto-briefings driven by Routines over A2A, public-share SSR, plus the briefing
  data model, access-scoped actions, fan-out internals, and the today panel.
metadata:
  internal: true
---

# Chief-of-Staff

Chief-of-Staff turns "what needs my attention today" into a single durable
**briefing**: one persisted row per compile run, surfaced as a today panel and a
per-briefing detail page. The agent reads, opens, and **polishes** briefings
through the same action surface the UI uses.

## The two-step sequence (do both, in order)

A briefing the user sees as "done" is produced by **two** tool calls. Never stop
after the first — `compile-briefing` gathers the raw cross-app material, then
**you** write the polished narrative with `update-briefing`.

1. **`compile-briefing`** — fans out to the sibling app agents in parallel,
   gathers each one's reply, and writes the raw `sourcesJson` plus a plain,
   section-stitched **no-LLM** fallback summary. Returns
   `{ briefingId, url, itemCount, status }`. Optional args: `kind`
   (`morning` | `evening` | `adhoc`), `apps` (override the user's enabled app
   set), `focus` (a free-form bias woven into every app's question), `date`
   (defaults to today, server-local). It does **not** write the polished prose.
2. **`update-briefing`** — read the compiled sources, then write the narrative:
   - Call `get-briefing { id: briefingId }` to read each source's
     `responseText` and `deepLinks`.
   - Synthesize a short, **prioritized** narrative — lead with what the user
     personally must handle today, group the rest, keep the deep links so they
     can open the underlying object. Do **not** just concatenate the raw replies.
   - Call `update-briefing { id: briefingId, summaryMd }` with your narrative.

When the user clicks **"Compile now"** in the panel it sends you the message
"Compile and polish today's briefing." — that is your cue to run **both** steps.

### The AI-writes-prose rule (hard constraint, §1.5.3)

The polished `summaryMd` is **always** written by you (the agent) through
`update-briefing`. `compile-briefing` never calls an LLM — its
`deterministicDigest` is only a fallback so the panel shows something before you
polish. Do not ask for a server-side summary and do not add a compile-time LLM
call; write the narrative yourself, then persist it via `update-briefing`.

## The four sources

`compile-briefing` fans out to `DEFAULT_APPS` (`shared/app-prompts.ts`) =
**`["mail", "calendar", "brain", "analytics"]`** — the four selected data
sources (§1.5.16) — unless the caller passes `apps` or the user narrowed the set
in settings. What each contributes:

- **mail** — unread/important threads that need a reply or decision, most urgent
  first, with a deep link per thread.
- **calendar** — today's meetings/events in time order, flagged for prep,
  decisions, or conflicts, with a deep link per event.
- **brain** — relevant indexed knowledge **and routing**: the brain leg runs
  `search-everything` and reports `federatedCoverage.delegationHints`, a
  relevance-ranked list of which downstream apps own related data.
  `compile-briefing` parses those hints (`shared/brain-routing.ts`) and runs an
  automatic **second-level fan-out** to the discovered apps they point at that
  are not already first-level targets, merging their sources in. Brain only ever
  delegates to `analytics` / `mail` / `dispatch` — **never to `calendar` or to
  itself** — so calendar always stays a first-level source. Brain routing is
  additive: a failed/timed-out routing leg adds no sources and never aborts the
  main fan-out.
- **analytics** (§1.5.13 caliber) — recent dashboards and saved analyses as
  links, and **only if** the user maintains a conventionally-named
  daily-metrics / daily-briefing analysis, its existing result numbers via
  `get-analysis`. Analytics actions are metadata-only except `get-analysis`, so
  the briefing surfaces **what already exists** — it never runs new ad-hoc
  queries or invents metrics.

## Customization (settings)

The user chooses which apps feed a briefing and overrides each app's question on
the Settings page (`/settings`). `compile-briefing` consults those settings
through `get-briefing-settings` / `update-briefing-settings` (key
`chief-of-staff-briefing-settings`, stored per-user via `@agent-native/core/settings`):

- An explicit `apps` argument **wins** over settings (you can always override).
- With no `apps`, the wanted set is the user's `enabledApps` (falling back to the
  four-source default).
- A per-app `promptOverrides[appId]` **replaces** the default question for that
  app's fan-out leg; otherwise `buildAppPrompt(appId, kind, focus)` is used.

## Data model

One row per compiled briefing — history is preserved, rows are never
overwritten. Defined in `server/db/schema.ts` (`briefings` table) using the
framework's `ownableColumns()` so every row is owner-scoped.

| Column          | Type         | Meaning                                                       |
| --------------- | ------------ | ------------------------------------------------------------- |
| `id`            | text PK      | `brief_<nanoid>`                                              |
| `briefingDate`  | text         | `YYYY-MM-DD`, the user-local day this briefing is for         |
| `kind`          | enum         | `morning` \| `evening` \| `adhoc` (default `adhoc`)           |
| `title`         | text         | Human-facing title                                            |
| `summaryMd`     | text         | Agent-polished narrative; no-LLM digest until you polish it   |
| `sourcesJson`   | text (JSON)  | `BriefingSource[]` — one entry per app the fan-out asked      |
| `status`        | enum         | `compiling` \| `complete` \| `partial` \| `failed`            |
| `focus`         | text \| null | Optional focus passed to the compile run                      |
| `createdAt`     | text (ISO)   | `new Date().toISOString()` — **ISO text, not integer**        |
| `updatedAt`     | text (ISO)   | Bumped on every `update-briefing`                             |
| ownable columns | —            | `owner_email`, `org_id`, `visibility` from `ownableColumns()` |

Timestamps are **ISO text strings**, matching the other ownable templates
(plan/forms). Do not switch to integer-timestamps.

`sourcesJson` holds an array of `BriefingSource` (see `shared/types.ts`), shared
by actions and the frontend so they agree on shape:

```ts
interface BriefingSource {
  app: string; // target app id, e.g. "mail", "calendar"
  prompt: string; // the NL question sent to that app's agent
  responseText: string; // its agent's raw reply (may contain deep-link markdown)
  deepLinks: string[]; // fully-qualified URLs pulled from responseText
  status: "ok" | "error" | "skipped" | "timeout";
  error?: string;
  latencyMs: number;
}
```

`compile-briefing` (B2) is the writer that fills `sourcesJson` — one entry per
fan-out target. `deepLinks` is populated by the source-origin-scoped extractor
(`shared/deep-links.ts`, §1.5.12); when a reply has no app-scoped link the array
is empty and the panel renders plain text with no dead button.

`briefingShares` (`createSharesTable("briefing_shares")`) backs optional sharing
and is what `accessFilter` / `resolveAccess` consult for share grants.

## Access model

`briefings` is an ownable resource, registered once in `server/db/index.ts` via
`registerShareableResource({ type: "briefing", ... })`. The `type` string
`"briefing"` is the first argument to every access call — never pass the table
object. Reads and writes are always scoped:

- **list** uses `accessFilter(schema.briefings, schema.briefingShares)` so a
  caller only ever sees briefings they own or have been shared. Public rows are
  not listed by default.
- **read-by-id** uses `resolveAccess("briefing", id)`; no access → throw a
  `ForbiddenError` (never return another user's data).
- **write** calls `assertAccess("briefing", id, "editor")` as the first line,
  before any mutation. Viewers cannot write.

Owner/org context comes from the request context (`currentAccess()` /
`runWithRequestContext`), not from action args.

## Actions

All live in `actions/` and are agent-callable tools and frontend data sources at
once.

| Action                     | Method          | readOnly | Purpose                                                                                                                            |
| -------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `list-briefings`           | GET             | yes      | List the caller's briefings (newest first); optional `{ date }` filter. Projects list columns only — never the `sourcesJson` blob. |
| `get-briefing`             | GET             | yes      | One briefing by `{ id }`, with `sourcesJson` parsed into `sources` and the caller's `role`.                                        |
| `update-briefing`          | POST (mutating) | no       | Patch `summaryMd` and/or `title` (at least one required); requires editor access; bumps `updatedAt`. **The polish write path.**    |
| `compile-briefing`         | POST (mutating) | no       | Fan-out: insert a `compiling` row, ask the wanted sibling agents in parallel, run brain second-level routing, write sources + no-LLM digest + status. |
| `get-briefing-settings`    | GET             | yes      | The caller's enabled apps + per-app prompt overrides (defaults to the four-source set).                                            |
| `update-briefing-settings` | POST (mutating) | no       | Patch `enabledApps` and/or `promptOverrides` (merged; empty string clears an app's override).                                      |

`update-briefing` is the **only** write path for the polished narrative. The
"AI writes prose" rule lives here: the agent compiles a briefing, then calls
`update-briefing` with a rewritten `summaryMd`. Do not add a per-field write
action or a compile-time LLM call; keep the surface small.

## compile-briefing fan-out

`compile-briefing` is the cross-app fan-out orchestrator. It does **not** RPC a
sibling app's action — it sends each sibling **agent** a natural-language
question and keeps the text reply, so the sibling runs its own full tool surface
under the caller's restored `{userEmail, orgId}` context (design §3 / §4 D1).

What one call does, in order:

1. **Insert a `compiling` placeholder row** (owner-scoped: `ownerEmail`,
   `orgId`, `visibility` set explicitly) so the panel can show a skeleton.
2. **Resolve targets** = wanted ∩ `discoverAgents("chief-of-staff")`. Wanted but
   undiscovered apps become `status:"skipped"` sources — never an error. The
   wanted set is the explicit `apps` arg, else the user's `enabledApps`, else
   `DEFAULT_APPS` (`shared/app-prompts.ts`) =
   **`["mail", "calendar", "brain", "analytics"]`**. The per-app question is
   `promptOverrides[appId]` if set, else `buildAppPrompt(appId, kind, focus)`.
3. **`runFanout`** (`shared/fanout.ts`) asks every target in parallel:
   - Identity is signed **inside** `runFanout` via `resolveA2ACallerAuth()` (a
     30m JWT) and forwarded to every leg — callers never pass auth (§1.5.6).
   - Every leg passes `selfAppId: "chief-of-staff"`, so the A2A self-call guard
     fires if the app is ever in its own target list: that leg short-circuits to
     `status:"skipped"` **before any network call** and never recurses
     (§1.5.5 / §1.5.18).
   - `Promise.allSettled` means one bad app never aborts the rest. Per-leg
     outcome → `BriefingSource.status`: replied → `ok`, past `perAppTimeoutMs`
     (default 35s) → `timeout`, self → `skipped`, any other throw → `error`.
   - `responseText` is capped at `MAX_PER_SOURCE_CHARS` (`shared/limits.ts`) and
     marked when cut; `deepLinks` are extracted source-origin-scoped (§1.5.12).
3b. **Brain second-level fan-out** (`shared/brain-routing.ts`, design §6): if
   `brain` was a first-level target, `routeViaBrain` asks the brain agent for its
   `search-everything` `federatedCoverage.delegationHints`, parses the suggested
   app ids, intersects them with discovered agents, drops anything already
   wanted (and `brain`/self), and the action runs a second `runFanout` for the
   remainder — merging those sources in. Never throws; a failed routing leg just
   adds nothing. The second-level `runFanout` reuses the same primitive and
   `selfAppId` (the routing orchestration lives in the action, not in
   `runFanout`, §1.5.6).
4. **Write the final row**: `sourcesJson` (whole-payload capped at
   `MAX_BRIEFING_BYTES`), `summaryMd = deterministicDigest(sources)`, and
   `status = deriveStatus(sources)` (all `ok` → `complete`, some ok → `partial`,
   none ok → `failed`).

`deterministicDigest` (`shared/digest.ts`) is a **no-LLM** section-stitch of the
raw replies — it keeps the panel useful and fully auditable until the agent
writes prose. It is a fallback, not the deliverable: after `compile-briefing`
returns, you call `update-briefing` with a rewritten `summaryMd` (the two-step
sequence above); do not put an LLM call inside `compile-briefing`.

Because `compile-briefing` is mutating (non-readOnly), the framework auto-emits
an `action` change event on success, so the panel refetches within one poll
interval — there is no `refresh-screen` call in the action.

## Today panel & detail

- The **today panel** reads `list-briefings` (filtered to today) and renders the
  latest briefing: title, status badge, and one collapsible section per
  `BriefingSource` (app name, status, response text, deep-link button slots).
- The **detail page** (`/briefings/:id`) reads `get-briefing` for one briefing,
  including the full per-source detail.
- Use shadcn `Card` / `Collapsible` / `Badge` / `Button` and Tabler icons. No
  hand-rolled popovers or modals.
- The panel's **"Compile now"** button calls
  `sendToAgentChat({ message: "Compile and polish today's briefing." })` — it
  routes through **this app's agent chat**, **never** a direct frontend call to
  `compile-briefing`. That is a hard rule (§1.5.3): only the agent runs the
  compile → `update-briefing` two-step, so only the agent produces the polished
  `summaryMd`. The button also drops an optimistic `compiling` placeholder card
  and rolls it back on timeout; the real row arrives via `useDbSync`.

## Auto-refresh

`useDbSync()` is mounted once in `app/root.tsx`; **do not** mount it again on a
page. Read panels just use `useActionQuery("list-briefings" | "get-briefing")`
and refresh automatically:

- `update-briefing` **and** `compile-briefing` are mutating (non-readOnly)
  actions, so the dispatcher emits a `source:"action"` change event when each
  completes — whether the agent or the UI triggered it.
- `useDbSync` polls `/_agent-native/poll` and, on that event, invalidates the
  active `useActionQuery` queries, which refetch within one poll interval.
- The read actions (`list-briefings`, `get-briefing`) are GET / readOnly, so
  they do **not** emit a refresh event — exactly as intended.

Neither `update-briefing` nor `compile-briefing` calls `refresh-screen`; the
mutating-action change event already refreshes the panel. `refresh-screen` is
only for writes the framework cannot see, which fan-out is not.

## Application state

`navigation` describes the current view and the focused briefing so the agent
knows what the user is looking at. `view-screen` returns the structured current
state (current briefing summary + visible list) so the agent can answer "about
this briefing" questions; `navigate` can move the UI to a specific briefing.
Assert against the **structured** `view-screen` return and `application_state`,
not against agent wording.

## Automatic briefings (driven by Routines over A2A)

The morning and evening briefings are **not** scheduled inside this app —
Chief-of-Staff has no scheduler. They are driven by a schedule **routine running
in the Routines app's process** (§1.5.2 / design §9). The mechanism:

- The Routines process owns a `30 8 * * 1-5` (morning) and a `30 18 * * 1-5`
  (evening) schedule routine. Its scheduler agent loop only has the Routines
  process's own tools, so it **cannot** call `compile-briefing` directly.
- Each routine's body uses the A2A path
  `invokeAgent("chief-of-staff", "<prompt>", { selfAppId: "routines" })` to reach
  **this** app's agent. The morning prompt asks for "today's briefing"; the
  evening prompt asks for "today's evening recap (kind=evening)".
- When you (the Chief-of-Staff agent) receive that A2A prompt, run the **normal
  two-step sequence** in your own loop: `compile-briefing` (pass
  `kind: "evening"` for the evening recap) → `update-briefing` with the polished
  narrative, then summarize what you wrote. The A2A caller's identity is restored
  into your request context, so the briefing is owner-scoped to that user.
- Users fork these from the Routines template library (`daily-briefing` and
  `evening-recap` presets); they are ordinary, independently-editable routines.

So an automatic briefing is exactly the same compile → update work you do for a
manual "Compile now" — the only difference is the trigger (a Routines A2A call
instead of the panel button). There is no special server-side path and no
compile-time LLM call.

## Public sharing (server-rendered briefing pages)

A briefing is private by default. To make one publicly readable, set its
visibility to `public` with the **framework** action
`set-resource-visibility { resourceType: "briefing", resourceId: "<id>", visibility: "public" }`
(owner/admin only; auto-mounted because `briefings` is registered as a shareable
resource in `server/db/index.ts`). To unshare, set it back to `private`.

Once public, `GET /briefings/:id` is **server-rendered** (Phase C / §455, §462):

- The route loader (`app/routes/briefings.$id.tsx`) calls the shallow reader
  `fetchPublicBriefing` (`server/lib/briefing-meta.server.ts`), which returns the
  title + polished `summaryMd` **only** when `visibility === "public"`.
- For a public briefing it server-renders `PublicBriefingView` (title + summary
  in the HTML source) plus `og:` / description meta for link unfurls — so an
  unauthenticated viewer or unfurl bot gets real content, not an empty shell.
- For a private/org/missing briefing the reader returns `null`, the page falls
  back to the CSR detail shell, and `get-briefing` enforces access — a private
  briefing's title or body **never** appears in SSR HTML for an anonymous fetch.

The public page shows the curated narrative only (no per-source raw replies, no
deep-link buttons) — sharing exposes the summary, not the internal fan-out
detail. Logged-in pages (today panel, history) stay CSR and access-scoped.

## Deep links

Each source's `deepLinks` are URLs scoped to that source app's own origin,
extracted from its reply (`shared/deep-links.ts`, §1.5.12): markdown links ∪ bare
`http(s)` URLs, de-duped, relative paths completed against the app's base URL,
and anything off the source app's origin dropped. When a reply yields no
app-scoped link the array is empty and the panel renders plain text with no dead
button. Keep the links you reference accurate — never invent ids or URLs.

## Do not

- Do not write the polished `summaryMd` inside `compile-briefing` or via any
  server-side LLM call — only through `update-briefing` (§1.5.3).
- Do not fetch sibling app data with raw `fetch`; cross-app calls go through the
  A2A `invokeAgent` path inside `compile-briefing` / `runFanout` /
  `routeViaBrain` (§10 hard constraint 1).
- Do not run new analytics queries for the briefing — surface existing
  dashboards, analyses, and results (§1.5.13).
- Do not add `brain` → `calendar` routing; brain only delegates to
  `analytics` / `mail` / `dispatch`, and calendar is always a first-level source.
- Do not schedule briefings inside this app — automatic briefings are Routines
  schedule routines that call this agent over A2A (§1.5.2). Your job on an A2A
  briefing prompt is the same compile → `update-briefing` two-step.
- Do not server-render a private briefing's content. The SSR loader exposes a
  body only for `visibility === "public"`; never weaken that gate.

## Tests

- `server/db/briefings-access.spec.ts` — raw-engine access isolation
  (`accessFilter` / `resolveAccess` / `assertAccess`) on in-memory libsql.
- `actions/briefings-actions.spec.ts` — the real `list` / `get` / `update`
  actions end-to-end against in-memory libsql with the real sharing helpers:
  cross-user isolation through the action surface, the list/get/update
  round-trip, and the empty state.
- `actions/briefings-refresh-contract.spec.ts` — the resolved read-only /
  mutating flags that drive the auto-refresh chain.
- `actions/update-briefing.spec.ts` — mocked unit coverage of the write path
  (editor-access-first, ForbiddenError propagation, patch shape).
- `shared/fanout.spec.ts` — B2 fan-out semantics with an **injected** invoke
  (no OAuth, §1.5.24): parallel wall-clock, identity passthrough
  (apiKey + userEmail reach every leg), per-leg timeout / error, partial
  failure, over-cap truncation, deep-link extraction, and the **real**
  `invokeAgent` self-call guard (self leg → `skipped`, network edge fires only
  `targets.length - 1` times).
- `shared/deep-links.spec.ts` — `extractDeepLinks` rules (§1.5.12): markdown ∪
  bare URLs, de-dup, origin-scoping, relative-path completion, empty fallback.
- `shared/digest.spec.ts` / `shared/limits.spec.ts` — the pure digest helpers
  (status derivation, default title, no-LLM stitch) and the size caps.
- `actions/compile-briefing.spec.ts` — the real `compile-briefing` action over
  an in-memory libsql db with `discoverAgents` + `runFanout` + `routeViaBrain` +
  settings mocked: insert → fan-out → write round-trip, complete / partial /
  failed derivation, wanted-but-undiscovered → `skipped`, `selfAppId` forwarding,
  owner scoping, the brain second-level fan-out (delegation hints route to a new
  app and a second `runFanout` runs), and settings overrides (enabledApps +
  per-app prompt override reach `buildPrompt`).
- `actions/synthesis.spec.ts` — the compile → `update-briefing` two-step
  end-to-end (§1.5.18): the agent's polish marker lands in `summaryMd`, it is
  `!= deterministicDigest(sources)`, raw sources stay expandable, the compile-time
  LLM spy is 0, and cross-user isolation (A's row never holds B's source text).
- `shared/brain-routing.spec.ts` — `parseDelegationAppIds` (raw / prose-wrapped /
  fenced JSON, dedupe, bad entries) and `routeViaBrain` (∩ discovered −
  alreadyWanted − self/brain, identity passthrough, non-fatal failure).
- `shared/briefing-settings.spec.ts` — `parseBriefingSettings` normalization
  (default fallback, trimmed/de-duped apps, override cleaning).
- `shared/app-prompts.spec.ts` — `DEFAULT_APPS` is the four sources, brain's
  router phrasing, the analytics §1.5.13 caliber, focus append, generic fallback.
- `app/pages/today-compile-button.spec.ts` — source-level guard that the panel's
  "Compile now" goes through `sendToAgentChat`, not a direct `compile-briefing`
  call (§1.5.3).
- `server/lib/briefing-meta.server.spec.ts` — the public-share SSR privacy gate
  (§455 / §462): `fetchPublicBriefing` returns content only for a `public` row
  and `null` for private/org/missing, so a private title/body is never SSR'd.
- `shared/briefing-meta-format.spec.ts` — the OG/description formatter strips
  markdown and truncates on a word boundary.
- `app/lib/briefing-notice.spec.ts` — the §1.5.19 status-notice decision logic
  (failed / partial / all-clear / none) and the per-source problem summary.

Run: `pnpm --filter chief-of-staff test`. Coverage:
`pnpm --filter chief-of-staff test:coverage` (named core modules ≥80% lines,
§1.5.20 item 2).

## Adding to this app

Follow the four-area rule (`adding-a-feature`): a briefing feature usually
touches the action surface, the panel/detail UI, application state, and this
skill. Keep data in SQL via Drizzle, keep the action surface small and
orthogonal, and keep access scoped through `accessFilter` / `assertAccess`.
