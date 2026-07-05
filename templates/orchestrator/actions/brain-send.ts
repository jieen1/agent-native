// brain-send — send a task/message to the orchestrator brain.
//
// The brain is a persistent, resumable Claude Code session that reaches the
// orchestrator actions as MCP tools and autonomously decides how to do the
// task. LEVEL-1 CONCURRENCY: this action no longer starts a brain child
// immediately. It inserts a `brain_tasks` row `queued`, then runs the admission
// gate (admitBrainTasks) which promotes up to `brain-concurrency` queued tasks
// to `running` and starts the brain ONLY for those; the rest stay queued until a
// slot frees (released on run-terminal by the reconciler, or by the reaper).
// Returns { threadId, status, queuePosition } immediately for the page to poll.
//
// NOTE: a RESUME of an existing thread (wake paths, or the user replying in an
// open thread) still starts directly — only a NEW dispatch goes through the
// queue. Resumes never consume a fresh slot (the thread already holds one until
// its run goes terminal).

import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { startBrainTurn } from "../server/brain/brain-session.js";
import { createLocalWorkspace } from "../server/v3-workspace-local.js";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { ensureBrainSchema } from "../server/db/brain-schema.js";
import {
  enqueueBrainTask,
  admitBrainTasks,
  countRunningBrainTasks,
} from "../server/queue/brain-admit.js";

export default defineAction({
  description:
    "Send a task or message to the orchestrator brain — a persistent, resumable " +
    "Claude Code session that reaches the orchestrator actions as MCP tools and " +
    "autonomously decides how to accomplish the task (it may author + run a DAG, " +
    "use spawnOnce, do workspace operations, or work directly), monitors by " +
    "polling, and completes. Omit threadId to start a new session; pass it to " +
    "resume the same session. Pass repo to provision a workspace first. New " +
    "dispatches are admitted through the brain concurrency limiter (default 2): " +
    "they run immediately if a slot is free, else queue. Returns { threadId, " +
    "status: 'running'|'queued', queuePosition }; poll brain-thread for the " +
    "live transcript.",
  schema: z.object({
    threadId: z.string().optional(),
    message: z.string().min(1),
    /** Optional git repo to clone into a workspace before the turn. */
    repo: z.string().optional(),
    /** Base branch to cut the workspace from (default main). */
    baseBranch: z.string().optional(),
    /** Existing workspace id to run the brain in (overrides repo). */
    workspaceId: z.string().optional(),
    /**
     * Optional opaque tags (e.g. { source: "tracker", item_id: "..." }). The
     * brain itself emits the create calls (workflowRun / workspaceCreate /
     * spawnOnce), so we cannot tag them server-side here. Instead we append an
     * explicit instruction to the brain message telling it to attach these tags
     * to EVERY such call, so activity is later reassemblable via
     * runsList/spawnList { tagMatch }. Additive and backward-compatible.
     */
    tags: z.record(z.string(), z.string()).optional(),
    /**
     * Periodic drift-check cadence (seconds) for the brain monitor scheduler,
     * persisted on the brain thread. Omit/undefined → env default
     * (BRAIN_MONITOR_INTERVAL_SEC, default 120); 0 → disable the timer
     * (event-only wakes). The scheduler wakes the brain every interval to
     * verify the run is on-track even when no node/run event fired.
     */
    monitorIntervalSec: z.number().int().min(0).optional(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    await ensureBrainSchema();
    const db = getV3Db();

    // Pin the threadId up-front (resume an existing thread or pre-generate a new
    // one) so it can be embedded in the activity tags BEFORE the turn starts.
    // This is what lets the reconciler's terminal-wake auto-resume THIS thread:
    // the brain attaches `brainThreadId` to its workflowRun, the run's tags then
    // carry it, and on run-terminal the reconciler resumes the same thread.
    const threadId = args.threadId ?? `bt_${randomUUID()}`;

    // Always propagate a tags object so the run links back to its brain thread.
    const tags: Record<string, string> = {
      ...(args.tags ?? {}),
      brainThreadId: threadId,
    };

    // Instruct the brain to propagate the tags onto every resource it creates so
    // the dispatcher can trace this turn's activity AND the terminal-wake can
    // find this thread.
    let message = args.message;
    message +=
      `\n\nIMPORTANT — activity tagging: pass this exact \`tags\` object on ` +
      `EVERY workflowRun, workspaceCreate, and spawnOnce call you make so ` +
      `this work is traceable and can be auto-resumed when the run finishes: ` +
      `${JSON.stringify(tags)}`;

    // ── RESUME path ───────────────────────────────────────────────────────────
    // A reply to an EXISTING thread is a resume, not a fresh dispatch: it must
    // NOT consume a fresh concurrency slot (the thread already holds one until
    // its run goes terminal). Start it directly, bypassing the queue.
    if (args.threadId) {
      const [existing] = await db
        .select({ id: v3Schema.brainThreads.id })
        .from(v3Schema.brainThreads)
        .where(eq(v3Schema.brainThreads.id, args.threadId))
        .limit(1);
      if (existing) {
        let workspaceId = args.workspaceId;
        if (!workspaceId && args.repo && args.repo.trim()) {
          const ws = await createLocalWorkspace({
            repoUrl: args.repo.trim(),
            branch: args.baseBranch?.trim() || undefined,
            ownerKind: "user",
            ownerId: ownerEmail,
            createdBy: ownerEmail,
            ownerEmail,
          });
          workspaceId = ws.id;
        }
        const { threadId: startedThreadId } = await startBrainTurn({
          threadId,
          ownerEmail,
          orgId,
          message,
          workspaceId,
          monitorIntervalSec: args.monitorIntervalSec,
        });
        const running = await countRunningBrainTasks();
        return {
          threadId: startedThreadId,
          status: "running" as const,
          queuePosition: 0,
          workspaceId: workspaceId ?? null,
          running,
        };
      }
      // A supplied-but-unknown id falls through to the NEW-dispatch path below
      // (it is treated as a pinned id for a brand-new thread).
    }

    // ── NEW dispatch path ─────────────────────────────────────────────────────
    // Create the thread row NOW (status 'queued') so the brain page resolves
    // while the task waits for a slot. startBrainTurn (called at admission) is
    // idempotent on an existing row and flips it to 'running'.
    await db
      .insert(v3Schema.brainThreads)
      .values({
        id: threadId,
        title: args.message.trim().slice(0, 60) || "New session",
        status: "queued",
        workspaceId: args.workspaceId ?? null,
        ownerEmail,
        orgId,
        monitorIntervalSec:
          typeof args.monitorIntervalSec === "number"
            ? args.monitorIntervalSec
            : null,
      })
      .onConflictDoNothing();

    // Enqueue the brain task (queued). The admission gate provisions the
    // workspace lazily (so two queued tasks don't both eagerly clone before they
    // even run) unless an explicit workspaceId was supplied.
    const { taskId, queuePosition } = await enqueueBrainTask({
      threadId,
      message,
      repo: args.repo ?? null,
      baseBranch: args.baseBranch ?? null,
      workspaceId: args.workspaceId ?? null,
      tags,
      ownerEmail,
      orgId,
    });

    // Run the admission gate: promotes up to (degree − running) queued tasks to
    // running and starts the brain ONLY for those. If this task is among them it
    // is now running; otherwise it stays queued for the driver / next release.
    const promoted = await admitBrainTasks();
    const admitted = promoted.includes(taskId);
    const running = await countRunningBrainTasks();

    return {
      threadId,
      status: admitted ? ("running" as const) : ("queued" as const),
      queuePosition: admitted ? 0 : queuePosition,
      taskId,
      running,
    };
  },
});
