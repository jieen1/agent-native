// v3-run-reconcile-sweep — F10 R9 widening unit tests (docs/sdlc-impl-f5-f10.md
// §6A row 1, part of the "reconciler 传导" T-F10-01/02/08 coverage umbrella;
// docs/sdlc-product-design/02-workflows.md §4 R9, SDLC-050).
//
// server/engine/v3-reconciler.spec.ts's T-F10-01/02/08 exercise the actual
// conduction RULE (V3Reconciler.tick()) directly — they never go through this
// sweep's own "should I even bother re-ticking this run" decision. This file
// closes that gap: it proves the sweep's widened bail-check specifically
// (previously: ANY 'running' node unconditionally skipped the run; now: a
// 'running' node whose bound spawn is ALREADY terminal does NOT count as
// "genuinely active" and triggers a re-tick instead of a silent skip).
//
// Uses a small hand-rolled getV3Db()/triggerTickSafe mock — the query set here
// is narrow enough (three fixed shapes) that "ignore the WHERE, return
// everything for the table" is unsafe for exactly ONE query (the terminal-
// spawn lookup), so that one query filters by the real, hardcoded terminal
// status set instead — everything else follows the same filter-blind
// convention as the other new spec files in this task.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { reconcileStrandedV3RunsOnce } from "./v3-run-reconcile-sweep.js";

const TERMINAL_SPAWN_STATUSES = new Set(["done", "failed", "cancelled"]);

const hoisted = vi.hoisted(() => {
  const state = {
    runs: [] as Array<Record<string, any>>,
    nodes: [] as Array<Record<string, any>>,
    spawns: [] as Array<Record<string, any>>,
  };
  const triggerTickSafe = vi.fn(async (_runId: string) => {});
  return { state, triggerTickSafe };
});

vi.mock("../plugins/v3-reconciler.js", () => ({
  triggerTickSafe: hoisted.triggerTickSafe,
}));

// reconcileStrandedV3RunsOnce no-ops under the local-file/sqlite dev default
// (`if (!isPostgres()) return [];`) — this test process has no DATABASE_URL,
// so without this mock every assertion below would trivially pass on an
// empty array for the wrong reason (a text-lock, not a real assertion).
vi.mock("@agent-native/core/db", () => ({
  isPostgres: () => true,
}));

vi.mock("../db/index.js", async () => {
  const v3Schema =
    await vi.importActual<typeof import("../db/v3-schema.js")>(
      "../db/v3-schema.js",
    );

  function isRunsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "dagVersion" in (table as object)
    );
  }
  function isNodesTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "nodeIdInDag" in (table as object)
    );
  }
  function isSpawnsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "renderedPrompt" in (table as object)
    );
  }

  const TERMINAL_SPAWN_STATUSES_LOCAL = new Set([
    "done",
    "failed",
    "cancelled",
  ]);

  function makeDb() {
    return {
      select: (_cols?: unknown) => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => {
            if (isRunsTable(table))
              return Promise.resolve([...hoisted.state.runs]);
            if (isNodesTable(table))
              return Promise.resolve([...hoisted.state.nodes]);
            if (isSpawnsTable(table)) {
              // The ONE query where the real filter matters for this test's
              // correctness: reconcileStrandedV3RunsOnce checks "is this
              // spawn id ALREADY terminal" — filtering by the real status
              // column (not just returning everything) is what lets the
              // "still running" vs "already terminal" test cases diverge.
              return Promise.resolve(
                hoisted.state.spawns.filter((s) =>
                  TERMINAL_SPAWN_STATUSES_LOCAL.has(s.status),
                ),
              );
            }
            return Promise.resolve([]);
          },
        }),
      }),
    };
  }

  return {
    v3Schema,
    schema: {},
    getV3Db: () => makeDb(),
    resolveOwnerEmail: () => "local@localhost",
  };
});

function resetState(): void {
  hoisted.state.runs.length = 0;
  hoisted.state.nodes.length = 0;
  hoisted.state.spawns.length = 0;
  hoisted.triggerTickSafe.mockClear();
}

describe("reconcileStrandedV3RunsOnce — F10 R9 conduction-gap widening", () => {
  beforeEach(() => {
    resetState();
  });

  it("R9 gap: a 'running' node whose bound spawn is ALREADY terminal is re-ticked, not silently skipped", async () => {
    hoisted.state.runs.push({ id: "run-1", status: "running" });
    hoisted.state.nodes.push({
      id: "node-1",
      runId: "run-1",
      status: "running",
      currentSpawnId: "spawn-1",
      startedAt: new Date(),
      completedAt: null,
    });
    hoisted.state.spawns.push({ id: "spawn-1", status: "failed" });

    const reconciled = await reconcileStrandedV3RunsOnce();

    expect(reconciled).toContain("run-1");
    expect(hoisted.triggerTickSafe).toHaveBeenCalledWith("run-1");
    expect(hoisted.triggerTickSafe).toHaveBeenCalledTimes(1);
  });

  it("genuinely active: a 'running' node whose bound spawn is still 'running' is left alone (no re-tick)", async () => {
    hoisted.state.runs.push({ id: "run-2", status: "running" });
    hoisted.state.nodes.push({
      id: "node-2",
      runId: "run-2",
      status: "running",
      currentSpawnId: "spawn-2",
      startedAt: new Date(),
      completedAt: null,
    });
    hoisted.state.spawns.push({ id: "spawn-2", status: "running" });

    const reconciled = await reconcileStrandedV3RunsOnce();

    expect(reconciled).not.toContain("run-2");
    expect(hoisted.triggerTickSafe).not.toHaveBeenCalled();
  });

  it("genuinely active: a 'running' node with no spawn bound yet (just dispatched) is left alone (no re-tick)", async () => {
    hoisted.state.runs.push({ id: "run-3", status: "running" });
    hoisted.state.nodes.push({
      id: "node-3",
      runId: "run-3",
      status: "running",
      currentSpawnId: null,
      startedAt: new Date(),
      completedAt: null,
    });

    const reconciled = await reconcileStrandedV3RunsOnce();

    expect(reconciled).not.toContain("run-3");
    expect(hoisted.triggerTickSafe).not.toHaveBeenCalled();
  });
});
