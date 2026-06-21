---
"@agent-native/core": patch
---

Add the cross-process event bridge: an `event_log` durable sink, an `emit()`
append hook, and two HTTP endpoints, plus the `./event-log` subpath export.

`emit()` (`event-bus/bus.ts`) now appends one row to a new core-owned
`event_log` table AFTER its in-process dispatch loop. The sink is best-effort,
fire-and-forget (a dynamic import so there is no event-bus → db module cycle),
and fully swallowed — `emit` keeps its synchronous `void` signature and the
existing same-process subscribers are unaffected. The table is created lazily
with the same `CREATE TABLE IF NOT EXISTS` `ensureTable` pattern as
`routine_runs`; because that raw DDL bypasses the migration adapter, the
auto-incrementing `seq` cursor column is branched per dialect (SQLite
`INTEGER PRIMARY KEY AUTOINCREMENT`, Postgres
`BIGINT GENERATED ALWAYS AS IDENTITY`).

Two additive endpoints mount under `/_agent-native`:
`GET /event-log?since=&names=` returns owner-scoped rows with `seq > since`
(authenticated by session cookie or an A2A Bearer JWT; NULL-owner rows never
leak), and `GET /events/catalog` returns the in-process event registry
(name + description) for cross-app event discovery.

The new `@agent-native/core/event-log` subpath exports `appendEventLog` /
`readEventLog`, the route handlers, and a fully dependency-injectable
`pollEventBridge` poller core (fetch / discovery / auth / dispatch / cursor
seams) for sibling apps to pull and dispatch cross-process events. The trigger
dispatcher gains a `sourceApp` frontmatter field and a `dispatchBridgedEvent`
entry that reuses the same condition-evaluation + agentic dispatch path as
same-process events; `verifyA2AToken` is now exported from
`@agent-native/core/a2a`. Pure additive: no existing engine semantics, schema,
or event-bus behavior changes.
