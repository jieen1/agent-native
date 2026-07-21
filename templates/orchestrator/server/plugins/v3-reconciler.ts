// V3 Reconciler Server Plugin (DESIGN §9, IMPLEMENTATION §D).
// Registers on app startup, initializes the V3 reconciler, and exposes:
// - SSE event stream: GET /_v3/runs/:runId/events
// - Health check: GET /_v3/health
//
// The reconciler is initialized but does NOT auto-tick. Ticks are event-driven:
// triggered by workflow.run action, spawn completion callbacks, etc.
//
// G1: Constructs a concrete V3Dispatcher(db, executor) using
//     RoutingRuntimeExecutor as the routing executor — per node, it consults
//     the run owner's LIVE runtime_configs rows (the same table Settings'
//     save-runtime-config/activate-runtime/test-runtime-config read/write)
//     and routes to the active/explicit saved runtime, falling back to
//     RemoteApiExecutor (the framework engine registry) unchanged when
//     nothing is configured/active — see routing-runtime-executor.ts.
//     Exports triggerTickSafe for actions to call after state changes.
// G30: Actually mounts the SSE/health router on the Nitro h3 app instead of
//      only stashing it on globalThis.

import { getH3App } from "@agent-native/core/server";
import { defineEventHandler, createRouter } from "h3";

import { getV3Db } from "../db/index.js";
import { V3Dispatcher } from "../engine/v3-dispatcher.js";
import {
  V3Reconciler,
  type V3Dispatcher as IV3Dispatcher,
} from "../engine/v3-reconciler.js";
import { RoutingRuntimeExecutor } from "../runtime/executors/index.js";
import { v3HealthEventHandler } from "../utils/v3-health.js";
import { v3SseEventHandler } from "../utils/v3-sse.js";

// Singleton state — holds the reconciler and dispatcher instances.
let reconciler: V3Reconciler | null = null;
let dispatcher: IV3Dispatcher | null = null;
let initialized = false;

/**
 * Build (or return cached) the V3Dispatcher singleton.
 * Uses RoutingRuntimeExecutor as the runtime brain — per-node engine routing
 * is handled inside V3Dispatcher.spawn() via node.engine + node.model
 * overrides, and RoutingRuntimeExecutor.run() resolves each node's owner's
 * live runtime_configs rows before falling back to the framework engine
 * registry (RemoteApiExecutor).
 */
function getOrCreateDispatcher(): IV3Dispatcher {
  if (!dispatcher) {
    const db = getV3Db();
    const executor = new RoutingRuntimeExecutor();
    // eslint-disable-next-line no-console
    console.log(
      "[v3-dispatcher] executor=RoutingRuntimeExecutor (routes to active runtime_configs rows, falls back to RemoteApiExecutor)",
    );
    dispatcher = new V3Dispatcher(db as any, executor);
  }
  return dispatcher;
}

/**
 * Get or create the V3 reconciler singleton.
 * Called lazily on first tick request to avoid failing startup when PG is
 * temporarily unavailable.
 */
function getOrCreateReconciler(): V3Reconciler {
  if (!reconciler) {
    const db = getV3Db();
    reconciler = new V3Reconciler(db as any, getOrCreateDispatcher());
  }
  return reconciler;
}

/**
 * Public API to trigger a reconciler tick for a given run.
 * This is the event-driven entry point — call from actions, spawn completion
 * callbacks, or any event that changes run state.
 *
 * G1: Called at the END of workflowRun (actions/v3-workflow.ts) and on spawn
 * completion / gate resolve.
 */
export async function triggerTick(runId: string): Promise<void> {
  const r = getOrCreateReconciler();
  await r.tick(runId);
}

/**
 * Best-effort triggerTick — swallows errors.
 * Use from actions where tick failure must not block the action response.
 */
export async function triggerTickSafe(runId: string): Promise<void> {
  try {
    await triggerTick(runId);
  } catch {
    // Advisory — DB may not be available yet, or run already terminal.
  }
}

/**
 * F9-followup (task board #38): best-effort drain of the persistent
 * writeback outbox — the SAME "reconciler owns HOW, sweep owns WHEN" split
 * `triggerTickSafe` establishes for run reconciliation. Called by
 * server/queue/v3-writeback-outbox-sweep.ts on its periodic timer.
 */
export async function triggerWritebackDrainSafe(): Promise<void> {
  try {
    const r = getOrCreateReconciler();
    await r.drainWritebackOutbox();
  } catch {
    // Advisory — DB may not be available yet; next sweep tick retries.
  }
}

/**
 * SDLC-083: best-effort sweep for runs whose PR was merged directly on
 * GitHub, bypassing `workspaceMergePr` — see
 * `V3Reconciler.sweepBypassedMerges` for the full rationale. Called by
 * server/queue/v3-writeback-outbox-sweep.ts on the SAME periodic timer as
 * `triggerWritebackDrainSafe` — no separate scheduler.
 */
export async function triggerBypassedMergeSweepSafe(): Promise<void> {
  try {
    const r = getOrCreateReconciler();
    await r.sweepBypassedMerges();
  } catch {
    // Advisory — DB may not be available yet; next sweep tick retries.
  }
}

/**
 * Public API to access the reconciler for pause/resume/cancel.
 */
export function getReconcilerRef(): V3Reconciler {
  return getOrCreateReconciler();
}

/**
 * Mark initialization complete. The reconciler was successfully wired.
 */
export function markInitialized(): void {
  initialized = true;
}

export function isReconcilerReady(): boolean {
  return initialized && reconciler !== null;
}

/**
 * V3 internal router — mounts under /_v3.
 * G30: Returns a real h3 router with the SSE and health handlers registered.
 */
function createV3Router(): ReturnType<typeof createRouter> {
  const router = createRouter();

  // SSE event stream for a specific run
  router.get("/_v3/runs/:runId/events", v3SseEventHandler);

  // Health check endpoint
  router.get("/_v3/health", v3HealthEventHandler);

  return router;
}

/**
 * Nitro server plugin for V3 reconciler.
 * G30: Registers routes on the Nitro h3 app instead of stashing on globalThis.
 * The reconciler instance is created lazily on first tick (event-driven), not
 * on plugin load.
 */
export default async function orchestratorV3ReconcilerPlugin(
  nitroApp: any,
): Promise<void> {
  // G30: Mount the V3 router on the Nitro h3 app so routes are reachable.
  // getH3App() returns the h3 shim; .use(path, handler) registers middleware.
  const h3App = getH3App(nitroApp);
  const v3Router = createV3Router();

  // Mount the V3 router at the root so full paths (/_v3/runs/:runId/events,
  // /_v3/health) are matched by the router's own pattern table.
  // Using path="" avoids prefix-stripping so /_v3/... routes resolve correctly.
  h3App.use(defineEventHandler((event) => v3Router.handler(event)));

  // Mark the reconciler plugin as ready.
  markInitialized();
}
