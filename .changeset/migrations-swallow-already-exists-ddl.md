---
"@agent-native/core": patch
---

`runMigrations`'s per-statement loop now also swallows Postgres "already
exists / duplicate object" DDL races (`isPgCatalogRace`, e.g. `CREATE TYPE`
re-run without an `IF NOT EXISTS` clause), the same way it already swallows
duplicate-column and permission errors. This lets a template fold
non-idempotent DDL (enum types have no `IF NOT EXISTS` syntax) into
`runMigrations` and re-run it safely on every boot instead of needing a
`DO $$...$$` guard, which the statement splitter cannot parse anyway.
`isPgCatalogRace` is now exported from `@agent-native/core/db` for reuse by
other idempotent-DDL callers.
