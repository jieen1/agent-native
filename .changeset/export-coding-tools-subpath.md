---
"@agent-native/core": patch
---

Export the `./coding-tools` subpath from `@agent-native/core`. The model-agnostic
acting tools (`createCodingToolRegistry`, `runCodingCommand`, `spawnBackgroundCommand`,
…) were already built to `dist/coding-tools` but were not exposed through the package
`exports` map, so external consumers (e.g. an app's microVM NodeRunner that re-points
the bash/read/edit/write tool contract at a sandbox) could not import them. This adds
the missing `exports` entry; no source behavior changes.
