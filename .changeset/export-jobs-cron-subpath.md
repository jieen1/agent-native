---
"@agent-native/core": patch
---

Export the `./jobs` subpath from `@agent-native/core`. The cron helpers
(`isValidCron`, `describeCron`, `nextOccurrence`) and job frontmatter utilities
(`parseJobFrontmatter`, `buildJobContent`, `processRecurringJobs`,
`createJobTools`, and the `JobFrontmatter` / `SchedulerDeps` types) were already
built to `dist/jobs/index.js` but were not exposed through the package `exports`
map, so app code could not import them. This adds the missing `exports` entry so
consumers (e.g. a Routines app that validates and humanizes cron expressions
client-side and server-side) can `import { isValidCron, describeCron } from
"@agent-native/core/jobs"`. Pure additive; no source behavior changes.
