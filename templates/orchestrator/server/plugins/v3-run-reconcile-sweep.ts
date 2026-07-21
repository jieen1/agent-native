// Nitro plugin: v3-run-reconcile-sweep
//
// Mounted at server startup to register the periodic reconcile sweep that
// detects and finalizes stuck v3_runs whose nodes are all terminal but the
// run status remains non-terminal.
//
// This prevents the brain-monitor from repeatedly waking done brain threads
// for runs that should have been finalized.

import { startReconcileSweep } from "../queue/v3-run-reconcile-sweep.js";

export default function v3RunReconcileSweepPlugin() {
  startReconcileSweep();
}
