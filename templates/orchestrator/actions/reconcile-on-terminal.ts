import { defineAction } from "@agent-native/core";
import { z } from "zod";
import { reconcileOnTerminal } from "../server/work-items/watchdog.js";

// Headless entrypoint for the reconciliation watchdog (DESIGN §6.2b L2). The
// engine wires reconcileOnTerminal automatically on run-finalize; this action
// exercises it directly (and lets a board/webhook re-check a run). A run with no
// bound work item is exempt and returns checked=false.
export default defineAction({
  description:
    "Run the status watchdog for a workflow run: if the run is bound to a work item, reached a terminal status, and no status change was logged during it, flag the work item status_stale. A run with no work item is exempt.",
  schema: z.object({
    runId: z.string().describe("The workflow run to reconcile"),
  }),
  run: async (args) => {
    return reconcileOnTerminal(args.runId);
  },
});
