// Nitro plugin: v3-workspace-reap-sweep
//
// Mounted at server startup to register the periodic sweep that reclaims
// workspace checkouts whose work is done — see
// server/queue/v3-workspace-reap-sweep.ts for the full rationale (2026-07-20
// disk-full incident: destroyLocalWorkspace's rm -rf was fixed, but nothing
// ever called it automatically, so disk usage kept growing right back up).

import { startWorkspaceReapSweep } from "../queue/v3-workspace-reap-sweep.js";

export default function v3WorkspaceReapSweepPlugin() {
  startWorkspaceReapSweep();
}
