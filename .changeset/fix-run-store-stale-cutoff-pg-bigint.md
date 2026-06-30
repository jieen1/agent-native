---
"@agent-native/core": patch
---

fix(run-store): cast stale-cutoff parameter to BIGINT to avoid int32 overflow on Postgres

Millisecond epoch timestamps exceed int32. Postgres would infer an untyped
parameter in `? - <integer literal>` as `integer`, causing "value is out of
range for type integer" errors. The CAST is a no-op on SQLite (ints are
already 64-bit there).
