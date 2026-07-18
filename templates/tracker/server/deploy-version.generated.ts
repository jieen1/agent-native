/**
 * Overwritten in place by orchestrator's deploy pipeline "building" stage
 * (see templates/orchestrator/server/deploy/deploy-runner.ts) immediately
 * before `pnpm --filter tracker build` runs, so the compiled server bundle
 * embeds the exact commit SHA it was built from. This is the build/version
 * marker `checkHealth` compares against the commit THIS deploy run is
 * shipping, so a stale CDN-cached 200 (see AGENTS.md: SSR HTML is
 * "hard-cached at the CDN for every visitor") can never be mistaken for a
 * live new build.
 *
 * The checked-in "dev" default below is what local dev/test builds see —
 * `git reset --hard` restores it on every deploy before the build stage
 * overwrites it with the real commit SHA, so this file must stay tracked in
 * git, never gitignored.
 */
export const DEPLOY_COMMIT_SHA = "dev";
