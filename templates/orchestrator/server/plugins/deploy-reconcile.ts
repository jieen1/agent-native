import { reconcileInterruptedDeployRuns } from "../deploy/deploy-runner.js";

// Boot-time sweep: a deploy run stuck "running"/"queued" from before a server
// restart can never finish (its ssh/build child process died with the old
// process) — mirror V3's own reconcile-on-boot discipline so the settings
// page never shows a permanently "running" deploy after a restart.
export default async function deployReconcilePlugin(): Promise<void> {
  try {
    await reconcileInterruptedDeployRuns();
  } catch {
    // Best-effort — table may not exist yet on a brand-new DB before the
    // migration runs; the next boot after migration will catch anything real.
  }
}
