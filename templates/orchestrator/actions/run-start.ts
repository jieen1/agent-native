import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { resolveAccess } from "@agent-native/core/sharing";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { newId, nowIso } from "./_util.js";
import { executeRun } from "../server/engine/index.js";
import { startRunForWorkItem } from "../server/queue/run-work-item.js";
import { writeAudit } from "../server/audit/write-audit.js";

// Instantiate a template (or a work item) into a workflow_runs row and schedule
// it (DESIGN §4.2 / §0.6). `templateId` and `workItemId` are MUTUALLY EXCLUSIVE
// and exactly one is required. The `templateId` path is the P1 path; the
// `workItemId` path (P3b) resolves the item's EXPLICIT workflowId → template,
// binds workflow_run.work_item_id, and runs it (no microVM — runs on the engine).
// `wait` (default true) drives the run to completion in-process so a headless CLI
// test can assert the final state — echo is fast. A production server-plugin tick
// may drive runs async, but a headless run MUST be awaitable.
export default defineAction({
  description:
    "Start a v2 workflow run from a template. Returns { runId }. With wait=true (default) drives the run to completion (echo executor) so the final state is assertable headlessly.",
  schema: z.object({
    templateId: z.string().optional(),
    workItemId: z.string().optional(),
    // z.coerce so headless `--flag value` (string) CLI args validate.
    tokenBudget: z.coerce.number().int().positive().optional(),
    seed: z.coerce.number().int().optional(),
    /** Observable echo delay (ms) so concurrency shows in timestamps. */
    echoDelayMs: z.coerce.number().int().min(0).optional(),
    /** Pin the model-call concurrency cap (tests assert overlap/queueing). */
    maxConcurrentModelCalls: z.coerce.number().int().positive().optional(),
    /** false = create + schedule but return immediately (no await). */
    wait: z.coerce.boolean().optional(),
  }),
  run: async (args) => {
    const hasTemplate = !!args.templateId;
    const hasWorkItem = !!args.workItemId;
    if (hasTemplate === hasWorkItem) {
      throw new Error(
        "Provide exactly one of templateId or workItemId (mutually exclusive).",
      );
    }

    // ── workItemId path (P3b): resolve the item's explicit workflow → run it,
    // binding workflow_run.work_item_id. The workflow is resolved INSIDE
    // startRunForWorkItem (explicit item.workflowId only for P3b; project-default
    // + dynamic build is P3c). The caller must have write access to the item.
    if (hasWorkItem) {
      const itemAccess = await resolveAccess("work_item", args.workItemId!);
      if (!itemAccess)
        throw new Error(`Work item ${args.workItemId} not found`);
      if (itemAccess.role === "viewer") throw new Error("Read-only access");

      const ownerEmail = getRequestUserEmail() ?? "local@localhost";
      const orgId = getRequestOrgId() ?? null;
      const wait = args.wait ?? true;

      const result = await startRunForWorkItem(args.workItemId!, {
        ownerEmail,
        orgId,
        tokenBudget: args.tokenBudget ?? null,
        execute: wait,
        executeOpts: {
          echoDelayMs: args.echoDelayMs,
          caps: args.maxConcurrentModelCalls
            ? { maxConcurrentModelCalls: args.maxConcurrentModelCalls }
            : undefined,
        },
      });
      await writeAudit({
        action: "run.start",
        targetType: "workflow_run",
        targetId: result.runId,
        detail: {
          workItemId: args.workItemId,
          templateSource: result.templateSource,
        },
      });
      return {
        runId: result.runId,
        workItemId: args.workItemId,
        status: result.status,
        tokensSpent: result.tokensSpent,
        // DESIGN §6.3 three-order decomposition: surface WHICH order resolved
        // the workflow (explicit | default | dynamic) and whether this is a
        // dynamic-authored placeholder the brain must build.
        templateId: result.templateId,
        templateSource: result.templateSource,
        dynamicAuthored: result.dynamicAuthored,
        noWorkflow: result.noWorkflow ?? false,
        reason: result.reason,
      };
    }

    const access = await resolveAccess("workflow_template", args.templateId!);
    if (!access) throw new Error(`Template ${args.templateId} not found`);
    if (access.role === "viewer") throw new Error("Read-only access");

    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId();
    const db = getDb();
    const runId = newId("run");
    const now = nowIso();

    await db.insert(schema.workflowRuns).values({
      id: runId,
      templateId: args.templateId!,
      workItemId: null,
      status: "pending",
      deliverable: null,
      tokenBudget: args.tokenBudget ?? null,
      tokensSpent: 0,
      startedAt: now,
      completedAt: null,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    await writeAudit({
      action: "run.start",
      targetType: "workflow_run",
      targetId: runId,
      detail: { templateId: args.templateId },
    });

    const wait = args.wait ?? true;
    if (!wait) {
      // Fire-and-forget: schedule without blocking (production tick model).
      void executeRun(runId, {
        echoDelayMs: args.echoDelayMs,
        caps: args.maxConcurrentModelCalls
          ? { maxConcurrentModelCalls: args.maxConcurrentModelCalls }
          : undefined,
      }).catch(() => undefined);
      return { runId };
    }

    const outcome = await executeRun(runId, {
      echoDelayMs: args.echoDelayMs,
      caps: args.maxConcurrentModelCalls
        ? { maxConcurrentModelCalls: args.maxConcurrentModelCalls }
        : undefined,
    });
    return {
      runId,
      status: outcome.status,
      tokensSpent: outcome.tokensSpent,
      nodeRunCount: outcome.nodeRuns.length,
    };
  },
});
