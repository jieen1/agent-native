---
"@agent-native/core": patch
---

Fixed `isAgentHarnessPackageInstalled`/`canResolvePackage` (`agent/harness/registry.ts`)
silently reporting a genuinely-installed harness package as missing when that package
ships `"type": "module"` with an `"exports"` map defining only an `"import"` condition
for `"."` (no `"require"`). Once a package declares `"exports"`, Node's CJS resolver
ignores the legacy `"main"` field entirely and throws `ERR_PACKAGE_PATH_NOT_EXPORTED`
for a bare `require.resolve(packageName)` — regardless of whether the package is
actually installed. Confirmed live: `@agentclientprotocol/claude-agent-acp` (the
`acp:claude-code` harness's own `installPackage`) hit exactly this, so a fully,
correctly deployed app with the harness packages genuinely present on disk still had
`isAgentHarnessPackageInstalled` return `false`, silently degrading every turn to the
raw-spawn fallback.

The check now falls back to resolving the package's own `package.json` specifically
when the bare specifier throws `ERR_PACKAGE_PATH_NOT_EXPORTED` — sidesteps the
module-format question entirely (a JSON file has no import/require distinction) while
still proving real, on-disk presence. An ordinary `MODULE_NOT_FOUND` (the package is
genuinely absent) is unaffected and still correctly reports `false`.
