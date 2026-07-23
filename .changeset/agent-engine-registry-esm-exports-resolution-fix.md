---
"@agent-native/core": patch
---

Fixed `isAgentEnginePackageInstalled`/`canResolvePackage` (`agent/engine/registry.ts`)
having the identical ESM-`"exports"`-map resolution bug fixed in the sibling
`agent/harness/registry.ts` (see the `agent-harness-esm-exports-resolution-fix`
changeset) — a copy-pasted twin that was missed. A package that ships
`"type": "module"` with an `"exports"` map defining only an `"import"` condition for
`"."` (no `"require"`) has no `"main"` for Node's CJS resolver to fall back to, so a
bare `require.resolve(packageName)` throws `ERR_PACKAGE_PATH_NOT_EXPORTED` regardless
of whether the package is actually installed. Any agent ENGINE package registered in
the future that ships ESM-only exports would have been silently misreported as "not
installed" by this check, degrading engine selection with no visible reason.

The check now falls back to resolving the package's own `package.json` specifically
when the bare specifier throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, matching the harness
registry's fix. An ordinary `MODULE_NOT_FOUND` (the package is genuinely absent) is
unaffected and still correctly reports `false`.
