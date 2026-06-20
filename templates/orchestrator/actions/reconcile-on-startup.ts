import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { z } from "zod";
import { reconcileOnStartup } from "../server/recovery/reconcile.js";

// reconcile-on-startup (DESIGN §14 / §1.7): the headless crash-recovery entry.
// The recovery server-plugin runs this automatically on boot; this action
// exercises it directly so an operator (or the P6 crash-recovery test) can drive
// reconciliation on demand: re-queue stranded claimed/running work items (so
// exactly one worker re-claims), and re-drive stranded `running` workflow_runs
// (done NodeRuns replay from the journal, a stranded running NodeRun re-runs
// whole). Every reaped row leaves an audit trail.
export default defineAction({
  description:
    "Run crash-recovery reconciliation: re-queue stranded claimed/running work items and re-drive stranded running workflow runs (done nodes replay from journal). Returns the recovered runs + requeued items. Idempotent.",
  schema: z.object({}),
  run: async () => {
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;
    const result = await reconcileOnStartup({ ownerEmail, orgId });
    return {
      recoveredRunCount: result.recoveredRuns.length,
      requeuedWorkItemCount: result.requeuedWorkItems.length,
      recoveredRuns: result.recoveredRuns.map((r) => ({
        runId: r.runId,
        resetNodeRuns: r.resetNodeRuns.length,
        preservedDoneCount: r.preservedDoneCount,
        status: r.status,
      })),
      requeuedWorkItems: result.requeuedWorkItems.map((w) => ({
        id: w.id,
        fromState: w.fromState,
      })),
    };
  },
});
