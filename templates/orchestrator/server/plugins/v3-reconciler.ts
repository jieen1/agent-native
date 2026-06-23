// V3 Reconciler Server Plugin (DESIGN §9, IMPLEMENTATION §D).
// Registers on app startup, initializes the V3 reconciler, and exposes:
// - SSE event stream: GET /_v3/runs/:runId/events
// - Health check: GET /_v3/health
//
// The reconciler is initialized but does NOT auto-tick. Ticks are event-driven:
// triggered by workflow.run action, spawn completion callbacks, etc.

import { createRouter } from "h3";
import { v3SseEventHandler } from "../utils/v3-sse.js";
import { v3HealthEventHandler } from "../utils/v3-health.js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { V3Reconciler, type V3Dispatcher } from "../engine/v3-reconciler.js";

// Singleton state — holds the reconciler and dispatcher instances.
let reconciler: V3Reconciler | null = null;
let initialized = false;

/**
 * Get or create the V3 reconciler singleton.
 * Called lazily on first tick request to avoid failing startup when PG is
 * temporarily unavailable.
 */
function getReconciler(
  db: PostgresJsDatabase,
  dispatcher: V3Dispatcher,
): V3Reconciler {
  if (!reconciler) {
    reconciler = new V3Reconciler(db, dispatcher);
  }
  return reconciler;
}

/**
 * Public API to trigger a reconciler tick for a given run.
 * This is the event-driven entry point — call from actions, spawn completion
 * callbacks, or any event that changes run state.
 */
export async function triggerTick(
  runId: string,
  db: PostgresJsDatabase,
  dispatcher: V3Dispatcher,
): Promise<void> {
  const r = getReconciler(db, dispatcher);
  await r.tick(runId);
}

/**
 * Public API to access the reconciler for pause/resume/cancel.
 */
export function getReconcilerRef(
  db: PostgresJsDatabase,
  dispatcher: V3Dispatcher,
): V3Reconciler {
  return getReconciler(db, dispatcher);
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
 */
function createV3Router() {
  const router = createRouter();

  // SSE event stream for a specific run
  router.get("/_v3/runs/:runId/events", v3SseEventHandler);

  // Health check endpoint
  router.get("/_v3/health", v3HealthEventHandler);

  return router;
}

/**
 * Nitro server plugin for V3 reconciler.
 * Registers routes on startup. The reconciler instance is created lazily
 * on first tick (event-driven), not on plugin load.
 */
export default async function orchestratorV3ReconcilerPlugin(): Promise<void> {
  // Routes are registered via the Nitro app handler chain.
  // We export the router for the Nitro app to use.
  if ((globalThis as any).__v3Router === undefined) {
    (globalThis as any).__v3Router = createV3Router();
  }
}

/**
 * Get the V3 router to mount in the Nitro app.
 */
export function getV3Router(): ReturnType<typeof createV3Router> {
  if ((globalThis as any).__v3Router === undefined) {
    (globalThis as any).__v3Router = createV3Router();
  }
  return (globalThis as any).__v3Router;
}
