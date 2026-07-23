// Nitro plugin: v3-lifecycle-sweep
//
// Mounted at server startup to register the periodic sweep that drives the
// P4-A data lifecycle cleanup (artifact TTL, event TTL, expired-run
// archival listing) — see server/queue/v3-lifecycle-sweep.ts for the full
// rationale (2026-07-23 SDLC audit: runLifecycleCleanup was fully correct
// but had never been called from anywhere in the running app).

import { startLifecycleSweep } from "../queue/v3-lifecycle-sweep.js";

export default function v3LifecycleSweepPlugin() {
  startLifecycleSweep();
}
