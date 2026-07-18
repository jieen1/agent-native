import { defineEventHandler, setResponseHeader } from "h3";

import { DEPLOY_COMMIT_SHA } from "../../deploy-version.generated.js";

/**
 * Build/version marker for orchestrator's deploy pipeline health check (see
 * templates/orchestrator/server/deploy/deploy-runner.ts). Never cached
 * (`no-store`) — it exists specifically so `checkHealth()` can distinguish a
 * genuinely new build from a stale CDN-cached response, which a plain
 * `res.ok` check on the SSR shell cannot do.
 */
export default defineEventHandler((event) => {
  setResponseHeader(event, "cache-control", "no-store");
  return { commitSha: DEPLOY_COMMIT_SHA };
});
