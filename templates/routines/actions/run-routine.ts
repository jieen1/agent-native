/**
 * run-routine — manual "run now" / dry-run for a single routine (§1.5.11/12).
 *
 * Two kinds, two execution paths — both drive the REAL engine, never a shadow
 * AI:
 *
 *   schedule: construct the same prompt the scheduler builds and run it once
 *     through the run-manager (`startRun` + `runAgentLoop`), using the app's own
 *     actions + system prompt + the owner's API key. A `routine_runs` history
 *     row is written with `trigger:"manual"`. Crucially this path does NOT call
 *     `resourcePut` / advance `nextRun` — the regular cron schedule is left
 *     exactly as it was (acceptance: "nextRun 未被改动").
 *
 *   event: per §1.5.11, do NOT use `fire-test` (it is hardcoded to emit
 *     `test.event.fired` and can't carry an arbitrary sample payload). Instead:
 *       1. evaluate the routine's NL `condition` against the user's sample
 *          payload with the same `condition-evaluator` the dispatcher uses, and
 *       2. `emit(meta.event, samplePayload, { owner })`, which routes through
 *          the dispatcher's `handleEvent → evaluateCondition → dispatchAgentic`
 *          path. dispatchAgentic creates the thread, runs the agent, and writes
 *          the `routine_runs` row via the core hook. We return the standalone
 *          condition result so the "try once" UI can show match / no-match even
 *          when dispatch is async.
 *
 * Owner-scope: only the requesting user's routine can be run; another user's
 * routine is simply not found.
 *
 * Usage:
 *   pnpm action run-routine --name=morning-briefing
 *   pnpm action run-routine --name=on-new-plan --samplePayload='{"plan":{"kind":"recap"}}'
 */

import { defineAction } from "@agent-native/core/action";
import {
  parseTriggerFrontmatter,
  evaluateCondition,
} from "@agent-native/core/triggers";
import { emit } from "@agent-native/core/event-bus";
import {
  runAgentLoop,
  actionsToEngineTools,
  getOwnerActiveApiKey,
  getStoredModelForEngine,
  resolveEngine,
  createThread,
  loadActionsFromStaticRegistry,
  getRequestOrgId,
  runWithRequestContext,
} from "@agent-native/core/server";
import {
  insertRoutineRun,
  finishRoutineRun,
} from "@agent-native/core/routine-runs";
import { z } from "zod";
import {
  getOwnerRoutineResource,
  requireOwnerEmail,
  slugifyRoutineName,
} from "./_routines-lib.js";

/**
 * Load the app's action registry the same way the agent-chat plugin does.
 * Dynamically imported (not a top-level import) because the generated registry
 * statically imports every action file — including THIS one — so a top-level
 * import would form a module cycle. The registry is only needed at run time.
 */
async function loadAppActions() {
  const registryMod = await import("../.generated/actions-registry.js");
  return loadActionsFromStaticRegistry(registryMod.default);
}

// Same base system prompt the routines agent-chat plugin uses, so a manual run
// behaves like the routine's real execution rather than a divergent context.
const ROUTINES_SYSTEM_PROMPT = `You are the Routines app agent, a personal automation engine for scheduled, event-triggered, and deterministic routines that orchestrate other apps.

Use actions as the source of truth. Start by inspecting the current screen when context matters. When the user asks to extend this app, keep the change small and agent-native: add or update actions, expose useful UI, and keep application state/navigation visible to the agent.`;

const HARD_ABORT_MS = 5 * 60 * 1000;

export default defineAction({
  description:
    "Run a routine once now (dry-run / 'try it'). For a scheduled routine this executes its instructions immediately through the agent without changing its cron schedule. For an event routine this evaluates its condition against a sample payload and dispatches it through the real event path. Returns what was triggered plus, for event routines, whether the condition matched.",
  schema: z.object({
    name: z
      .string()
      .min(1)
      .describe("Routine slug name (the jobs/{name}.md file name)."),
    samplePayload: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        "Event routines only: a sample event payload to evaluate the condition against and dispatch with. Ignored for scheduled routines.",
      ),
  }),
  run: async (args) => {
    const owner = requireOwnerEmail();
    const orgId = getRequestOrgId() ?? undefined;
    const name = slugifyRoutineName(args.name);
    if (!name) {
      throw new Error(`Invalid routine name: "${args.name}".`);
    }

    const resource = await getOwnerRoutineResource(owner, name);
    if (!resource) {
      return { notFound: true, name };
    }

    const { meta, body } = parseTriggerFrontmatter(resource.content);
    if (!body.trim()) {
      throw new Error(
        `Routine "${name}" has no instructions to run. Add instructions before running it.`,
      );
    }

    if (meta.triggerType === "event") {
      return runEventRoutine({
        owner,
        name,
        event: meta.event,
        condition: meta.condition,
        samplePayload: args.samplePayload ?? {},
      });
    }

    return runScheduleRoutine({ owner, orgId, name, body });
  },
});

/**
 * Event dry-run: evaluate the condition against the sample payload, then emit
 * the routine's real event so the dispatcher path runs it (§1.5.11 — not
 * fire-test). The emit is owner-scoped so only this user's automations fire.
 */
async function runEventRoutine(input: {
  owner: string;
  name: string;
  event: string | undefined;
  condition: string | undefined;
  samplePayload: Record<string, unknown>;
}): Promise<{
  kind: "event";
  name: string;
  event?: string;
  conditionMatched: boolean;
  dispatched: boolean;
  reason?: string;
}> {
  const { owner, name, event, condition, samplePayload } = input;

  if (!event) {
    throw new Error(
      `Event routine "${name}" has no event configured. Set an event before running it.`,
    );
  }

  // Resolve the owner's key for the condition evaluator (Haiku). With no key we
  // can't evaluate the NL condition; report it instead of silently passing.
  const apiKey = await getOwnerActiveApiKey(owner);
  if (condition && condition.trim() && !apiKey) {
    return {
      kind: "event",
      name,
      event,
      conditionMatched: false,
      dispatched: false,
      reason:
        "No API key available to evaluate this routine's natural-language condition. Configure an Anthropic key, then try again.",
    };
  }

  // Same evaluator the dispatcher uses. Empty/undefined condition → true.
  const conditionMatched = await evaluateCondition(
    condition,
    samplePayload,
    apiKey ?? "",
  );

  if (!conditionMatched) {
    return {
      kind: "event",
      name,
      event,
      conditionMatched: false,
      dispatched: false,
      reason:
        "The condition did not match the sample payload, so the routine would not run for this event.",
    };
  }

  // Drive the real dispatcher path. handleEvent re-evaluates the condition and
  // calls dispatchAgentic, which creates the thread, runs the agent, and writes
  // the routine_runs row via the core hook. Owner-scoped so only this user's
  // automations fire.
  emit(event, samplePayload, { owner });

  return {
    kind: "event",
    name,
    event,
    conditionMatched: true,
    dispatched: true,
  };
}

/**
 * Schedule dry-run: construct the scheduler's prompt and run it once through
 * the agent loop, mirroring `dispatchAgentic`'s direct `runAgentLoop` +
 * `AbortController` pattern (the run-manager `startRun` wrapper is not exported
 * to templates). Writes a `trigger:"manual"` history row and never advances the
 * cron `nextRun` — it does not touch the routine resource at all.
 */
async function runScheduleRoutine(input: {
  owner: string;
  orgId: string | undefined;
  name: string;
  body: string;
}): Promise<{
  kind: "schedule";
  name: string;
  threadId: string;
  status: "success" | "error";
  error?: string;
}> {
  const { owner, orgId, name, body } = input;

  return runWithRequestContext({ userEmail: owner, orgId }, async () => {
    const actions = await loadAppActions();
    const tools = actionsToEngineTools(actions);

    const apiKey = await getOwnerActiveApiKey(owner);
    const engine = await resolveEngine({ apiKey, appId: "routines" });
    const model =
      (await getStoredModelForEngine(engine, { appId: "routines" })) ??
      engine.defaultModel;

    const now = new Date();
    const thread = await createThread(owner, {
      title: `Routine (manual): ${name} — ${now.toLocaleDateString()}`,
    });

    // History row for the manual run. trigger:"manual" distinguishes it from a
    // real cron tick; best-effort so it can never break the run itself.
    const runRowId = await insertRoutineRun({
      ownerEmail: owner,
      orgId,
      routineName: name,
      kind: "schedule",
      trigger: "manual",
      threadId: thread.id,
      status: "running",
      startedAt: now.getTime(),
    });

    // Same prompt shape as scheduler.executeJob's run, minus the cron
    // description (a manual run isn't tied to a tick).
    const jobText = `[Routine: ${name} — manual run]\n\nExecute the following routine instructions:\n\n${body}`;
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: jobText }],
      },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HARD_ABORT_MS);

    let runError: Error | null = null;
    try {
      await runAgentLoop({
        engine,
        model,
        systemPrompt: ROUTINES_SYSTEM_PROMPT,
        tools,
        messages,
        actions,
        send: () => {},
        signal: controller.signal,
        threadId: thread.id,
        ownerEmail: owner,
        orgId: orgId ?? null,
      });
    } catch (err: unknown) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timeout);
    }

    if (runError) {
      const message =
        (runError as Error).message?.slice(0, 200) || "Unknown error";
      await finishRoutineRun(runRowId, {
        status: "error",
        error: message,
        finishedAt: Date.now(),
      });
      return {
        kind: "schedule" as const,
        name,
        threadId: thread.id,
        status: "error" as const,
        error: message,
      };
    }

    await finishRoutineRun(runRowId, {
      status: "success",
      finishedAt: Date.now(),
    });

    return {
      kind: "schedule" as const,
      name,
      threadId: thread.id,
      status: "success" as const,
    };
  });
}
