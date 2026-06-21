---
"@agent-native/core": patch
---

Add a `routine_runs` history table and the `./routine-runs` subpath export.

The job scheduler (`jobs/scheduler.ts`) and trigger dispatcher
(`triggers/dispatcher.ts`) now record one `routine_runs` row per real run: a
`running` row when the run starts (carrying `routineName`, `kind`
(`schedule`/`event`), `trigger`, and `threadId`) and a terminal
`success`/`error` row when it finishes. The table is created lazily with the
same `CREATE TABLE IF NOT EXISTS` `ensureTable` pattern as `application_state`
and `chat_threads`, carries only the two ownable columns (`owner_email`,
`org_id`), and uses a caller-generated TEXT uuid id to avoid the
SQLite/Postgres autoincrement split.

The new `@agent-native/core/routine-runs` subpath exports `insertRoutineRun`,
`finishRoutineRun`, and an owner-scoped `listRoutineRuns` reader so a Routines
app can render run history. Pure additive: no existing engine logic, schema, or
job/trigger state machine changes, and history writes are best-effort
(failures are swallowed) so they can never break an in-flight run.
