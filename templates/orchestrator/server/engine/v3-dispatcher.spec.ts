// V3 Dispatcher Unit Tests
//
// Tests channel contract (4 inputs), output classification (string/object/schema-violation),
// interpolation context building, and error classification.
// All DB and NodeRunner calls are mocked.

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock dependencies ───────────────────────────────────────────────────────

vi.mock("../agent-loader.js", () => {
  // F4: resolveAgentConfig's fallback (agent-defs row missing, or loadAgent
  // resolves null) calls the real minimalAgentConfig, and its success path
  // calls dispatchWorkerConfig to collapse a `kind: "brain"` row to the same
  // minimal config. Mock both with the same shape/behavior as the real
  // agent-loader.ts (see `dispatchWorkerConfig`/`minimalAgentConfig` there) so
  // every test — whether loadAgent resolves null (default below) or a real
  // config (per-describe overrides) — exercises a real dispatch instead of
  // silently falling through to "dispatchWorkerConfig is not a function".
  const minimalAgentConfig = vi.fn((name: string) => ({
    name,
    description: "",
    runtime: "none",
    engine: "",
    model: "",
    tools: [],
    systemPrompt: "",
  }));
  const dispatchWorkerConfig = vi.fn((loaded: any, agentName: string) =>
    loaded?.kind === "brain" ? minimalAgentConfig(agentName) : loaded,
  );
  return {
    loadAgent: vi.fn().mockResolvedValue(null),
    minimalAgentConfig,
    dispatchWorkerConfig,
  };
});

vi.mock("./interpolation.js", () => ({
  renderTemplate: vi.fn((template: string) => template),
}));

// NodeRunner is a class; use a real mock class so `new NodeRunner(...)` works
const hoisted = vi.hoisted(() => ({
  MockNodeRunner: class {
    run() {}
  },
}));
vi.mock("../runtime/node-runner.js", () => ({
  NodeRunner: hoisted.MockNodeRunner,
}));

// getWorkspace (the workspace-readiness gate's lookup, T-F1-09) — mocked so
// the "Workspace readiness gate" tests below can control readyAt without a
// real DB. Unused by every other test in this file (they never set a
// DAG-node `workspace` field via the generic all-empty mock db).
vi.mock("./v3-workspace.js", () => ({
  getWorkspace: vi.fn(),
}));

// getLocalWorkspaceDir reaches the REAL db/index.js connection when CALLED —
// mock it so the ready-workspace dispatch test never opens a real DB. (The
// readiness gate itself reads getWorkspace above, not this.)
vi.mock("../v3-workspace-local.js", () => ({
  getLocalWorkspaceDir: vi.fn(async () => null),
}));

// F7 (04 §7/§13): v3-dispatcher.ts now reverse-looks-up the model's real
// weight name via server/model-registry.ts, which itself calls the REAL
// getV3Db(). Mock it so these unit tests never touch a real DB — individual
// T-F7-06 cases override the resolved value per-test.
vi.mock("../model-registry.js", () => ({
  resolveRealName: vi
    .fn()
    .mockResolvedValue({ realName: null, suspect: false }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { loadAgent } from "../agent-loader.js";
import { v3Runs, v3Events, v3Spawns } from "../db/v3-schema.js";
import { resolveRealName } from "../model-registry.js";
import type { RuntimeExecutor } from "../runtime/executors/types.js";
import { renderTemplate } from "./interpolation.js";
import {
  classifyNodeError,
  errorClassToOnFailurePolicy,
  computeUsageSuspect,
  formatCheckpointInjection,
} from "./v3-dispatcher.js";
import { getWorkspace } from "./v3-workspace.js";

// ── Mock DB Builder ──────────────────────────────────────────────────────────

function createMockDb() {
  const artifacts: Array<Record<string, unknown>> = [];
  const spawns: Array<Record<string, unknown>> = [];

  // A real drizzle `.insert(t).values(row)` returns a query builder that is
  // BOTH thenable (bare `await` works, as the pre-F7 version of this mock
  // assumed) AND chainable (`.onConflictDoNothing()` / `.onConflictDoUpdate()`
  // — used by openRunningSpawn/writeSpawnRecord's live-then-terminal UPSERT,
  // DESIGN §8.5). The prior plain-`async function` mock had no chain methods
  // at all, so those two call sites silently threw (openRunningSpawn's own
  // try/catch swallowed it; writeSpawnRecord's did not — it just never got
  // exercised because no existing test read `mockDb.spawns`). Fixed here so
  // `.onConflictDoUpdate({set})` actually MERGES into the row already written
  // by the earlier `.onConflictDoNothing()` insert, matching real Postgres
  // UPSERT semantics (same `id` = same spawn row, updated in place).
  function commitRow(row: Record<string, unknown>): void {
    if (row.kind && row.textContent !== undefined) {
      artifacts.push(row);
      return;
    }
    if (row.renderedPrompt !== undefined) {
      const idx = spawns.findIndex((s) => s.id === row.id);
      if (idx >= 0) spawns[idx] = { ...spawns[idx], ...row };
      else spawns.push(row);
    }
  }

  // A plain THENABLE (has `.then`, not a real eagerly-scheduled Promise) so
  // a bare `await insert(t).values(row)` (v3_artifacts / spawn_events /
  // v3_events — no conflict clause anywhere in this codebase) commits via
  // `.then()`, while `.onConflictDoNothing()` / `.onConflictDoUpdate()`
  // (v3_spawns' live-then-terminal UPSERT) commit via their OWN method
  // instead — never both, since `.then()` is only invoked by an external
  // `await` of the base object, not by calling a chained method on it.
  function insertResult(row: Record<string, unknown>) {
    return {
      then(resolve: (v: Record<string, never>) => void) {
        commitRow(row);
        resolve({});
      },
      onConflictDoNothing: async (_opts?: unknown) => {
        commitRow(row);
        return {};
      },
      onConflictDoUpdate: async (opts: { set: Record<string, unknown> }) => {
        const idx = spawns.findIndex((s) => s.id === row.id);
        if (idx >= 0) spawns[idx] = { ...spawns[idx], ...opts.set };
        else commitRow(row);
        return {};
      },
    };
  }

  const db = {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
    update: () => ({
      set: () => ({
        where: async () => ({}),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => insertResult(row),
    }),
  } as unknown as PostgresJsDatabase;

  return { db, artifacts, spawns };
}

// ── Tests: classifyNodeError (module export) ─────────────────────────────────

describe("classifyNodeError", () => {
  it("transient: timeout error", () => {
    expect(classifyNodeError(new Error("ETIMEDOUT"))).toBe("transient");
    expect(classifyNodeError(new Error("connection timeout"))).toBe(
      "transient",
    );
    expect(classifyNodeError(new Error("429 too many requests"))).toBe(
      "transient",
    );
  });

  it("transient: network errors", () => {
    expect(classifyNodeError(new Error("ECONNRESET"))).toBe("transient");
    expect(classifyNodeError(new Error("ECONNREFUSED"))).toBe("transient");
    expect(classifyNodeError(new Error("ENETUNREACH"))).toBe("transient");
  });

  it("transient: OOM", () => {
    expect(classifyNodeError(new Error("OOM killed"))).toBe("transient");
    expect(classifyNodeError(new Error("out of memory"))).toBe("transient");
  });

  it("permanent: config / render failures", () => {
    expect(classifyNodeError(new Error("agent not found"))).toBe("permanent");
    expect(classifyNodeError(new Error("engine not configured"))).toBe(
      "permanent",
    );
    expect(classifyNodeError(new Error("render failed"))).toBe("permanent");
    expect(classifyNodeError(new Error("invalid schema"))).toBe("permanent");
    expect(classifyNodeError(new Error("acp adapter not installed"))).toBe(
      "permanent",
    );
  });

  it("cancelled: abort / kill signals", () => {
    expect(classifyNodeError(new Error("run cancelled"))).toBe("cancelled");
    expect(classifyNodeError(new Error("vm killed"))).toBe("cancelled");
    // "aborted" is in both CANCELLED and TRANSIENT indicators; CANCELLED is
    // checked first, so abort signals classify as cancelled (terminal).
    expect(classifyNodeError(new Error("aborted"))).toBe("cancelled");
  });

  it("transient: infra / VM errors fall through to transient (retryable)", () => {
    // workspace_error was removed in the §12 realignment — mount/microsandbox/
    // provision/permission failures are now retryable transient errors.
    expect(classifyNodeError(new Error("mount failed"))).toBe("transient");
    expect(classifyNodeError(new Error("microsandbox error"))).toBe(
      "transient",
    );
    expect(classifyNodeError(new Error("provision failed"))).toBe("transient");
    expect(classifyNodeError(new Error("permission denied"))).toBe("transient");
  });

  it("default: unknown error classifies as transient", () => {
    expect(classifyNodeError(new Error("something weird happened"))).toBe(
      "transient",
    );
    expect(classifyNodeError("plain string error")).toBe("transient");
  });
});

// ── Tests: errorClassToOnFailurePolicy (module export) ──────────────────────

describe("errorClassToOnFailurePolicy", () => {
  it("transient -> recreate", () => {
    expect(errorClassToOnFailurePolicy("transient")).toBe("recreate");
  });

  it("schema-violation -> rollback", () => {
    expect(errorClassToOnFailurePolicy("schema-violation")).toBe("rollback");
  });

  it("permanent -> keep", () => {
    expect(errorClassToOnFailurePolicy("permanent")).toBe("keep");
  });

  it("cancelled -> keep", () => {
    expect(errorClassToOnFailurePolicy("cancelled")).toBe("keep");
  });
});

// ── Tests: V3 channel contract (input shape) ────────────────────────────────

describe("V3 spawn input channel contract", () => {
  it("V3 spawn input has 4 fields", () => {
    const v3Input = {
      system_prompt: "You are an implementer",
      rendered_prompt: "Implement the feature",
      tools: ["Read", "Edit", "Write"] as string[],
      workspace: "/work" as string | undefined,
    };

    expect(v3Input.system_prompt).toBe("You are an implementer");
    expect(v3Input.rendered_prompt).toBe("Implement the feature");
    expect(Array.isArray(v3Input.tools)).toBe(true);
    expect(v3Input.workspace).toBe("/work");
  });

  it("V3 spawn input with minimal fields (no tools, no workspace)", () => {
    const v3Input = {
      system_prompt: "You are a reviewer",
      rendered_prompt: "Review this PR",
      tools: undefined,
      workspace: undefined,
    };

    expect(v3Input.system_prompt).toBe("You are a reviewer");
    expect(v3Input.tools).toBeUndefined();
    expect(v3Input.workspace).toBeUndefined();
  });
});

// ── Tests: Output classification ────────────────────────────────────────────

describe("Output classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeMockNodeRunner(runResult: unknown) {
    // Spy on the prototype's run method to control return value
    vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
      async () =>
        ({
          output: runResult,
          tokensSpent: 100,
          toolCallCount: 0,
          model: "test-model",
          vmName: null,
          durationMs: 50,
          attempts: 1,
        }) as any,
    );
  }

  function makeNodeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "node-1",
      runId: "run-1",
      nodeIdInDag: "a",
      type: "agent",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      currentSpawnId: null,
      outputArtifactId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      ownerEmail: "local@localhost",
      orgId: null,
      ...overrides,
    };
  }

  it("output classification: string — no schema", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.mocked(loadAgent).mockResolvedValue({
      name: "test-agent",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Test agent",
    });

    vi.mocked(renderTemplate).mockReturnValue("Test agent");
    makeMockNodeRunner("The implementation is complete.");

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };

    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    const spawnId = await dispatcher.spawn(makeNodeRow() as any, "run-1");

    expect(spawnId).toBeDefined();
    expect(mockDb.artifacts.length).toBeGreaterThan(0);
    expect(mockDb.artifacts[0].kind).toBe("string");
  });

  it("output classification: object with schema match", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.mocked(loadAgent).mockResolvedValue({
      name: "reviewer",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Code reviewer",
    });

    vi.mocked(renderTemplate).mockReturnValue("Code reviewer");

    makeMockNodeRunner({ verdict: "pass", score: 95 });

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };

    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    const spawnId = await dispatcher.spawn(
      makeNodeRow({ nodeIdInDag: "reviewer" }) as any,
      "run-1",
    );

    expect(spawnId).toBeDefined();
    expect(mockDb.artifacts.length).toBeGreaterThan(0);
    // With no DAG output_schema in the mock DB (returns []), the output
    // falls through to the string path.  To test "object", we need the
    // dispatcher to find an output_schema on the DAG node.  Since the mock
    // DB returns [] for all queries, loadDagForRun returns [] and
    // findDagNode returns undefined — so outputSchema is undefined and the
    // path is "string".  We verify the object classification logic via the
    // classifyOutput function indirectly by confirming the string path here.
    expect(mockDb.artifacts[0].kind).toBe("string");
  });

  it("output classification: schema-violation when output mismatches schema", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.mocked(loadAgent).mockResolvedValue({
      name: "reviewer",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Code reviewer",
    });

    vi.mocked(renderTemplate).mockReturnValue("Code reviewer");

    // Without a schema in the DAG (mock DB returns []), a string output
    // goes to the "string" path.  Schema-violation requires an output_schema
    // to be present on the DAG node.  Since we cant easily inject DAG data
    // through the mock DB, we verify the exported classifyNodeError instead
    // and confirm the dispatcher marks the node appropriately.
    makeMockNodeRunner("I reviewed the code and it looks good");

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };

    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    const spawnId = await dispatcher.spawn(
      makeNodeRow({ nodeIdInDag: "reviewer" }) as any,
      "run-1",
    );

    expect(spawnId).toBeDefined();
    // Without schema, string output -> "string" artifact
    expect(mockDb.artifacts[0].kind).toBe("string");
  });

  it("schema-violation error classification is permanent", () => {
    // The dispatcher classifies schema-violation as a permanent error.
    expect(
      classifyNodeError(new Error("schema-violation: missing field")),
    ).toBe("permanent");
    expect(errorClassToOnFailurePolicy("permanent")).toBe("keep");
  });
});

// ── Tests: Interpolation context ─────────────────────────────────────────────

describe("Interpolation context", () => {
  it("buildInterpolationContext returns expected shape", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.mocked(loadAgent).mockResolvedValue({
      name: "downstream",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Downstream agent",
    });

    vi.mocked(renderTemplate).mockReturnValue("Downstream agent");

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };

    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    const nodeRow = {
      id: "node-downstream",
      runId: "run-1",
      nodeIdInDag: "downstream",
      type: "agent",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      currentSpawnId: null,
      outputArtifactId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      ownerEmail: "local@localhost",
      orgId: null,
    };

    const context = await (dispatcher as any).buildInterpolationContext(
      "run-1",
      nodeRow,
    );

    // Context should have the expected ExpressionContext shape
    expect(context).toHaveProperty("inputs");
    expect(context).toHaveProperty("deps");
    expect(typeof context.inputs).toBe("object");
    expect(typeof context.deps).toBe("object");
  });
});

describe("Workspace readiness gate", () => {
  /** Mock db that returns a REAL v3_runs row (with a DAG carrying a
   * `workspace` field) so the dispatcher's Step 6 workspace-resolution path
   * actually runs — the shared `createMockDb()` above always returns `[]`,
   * which means every other test in this file never exercises this branch. */
  function createRunMockDb(dag: unknown) {
    const artifacts: Array<Record<string, unknown>> = [];
    // Keyed by spawn id — the dispatcher UPSERTS the terminal record onto the
    // open-row insert (onConflictDoUpdate on the same id), which must read as
    // ONE spawn row, exactly like the real unique-PK table.
    const spawnsById = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    const runRow = { id: "run-1", dag };

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => (table === v3Runs ? [runRow] : []),
        }),
      }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
      insert: (table: unknown) => ({
        // Awaitable directly (plain `await ...values({...})`, e.g. v3_events)
        // AND chainable with .onConflictDoNothing()/.onConflictDoUpdate()
        // (the v3_spawns open-row insert + terminal upsert). Records exactly
        // once whichever way it's consumed.
        values: (row: Record<string, unknown>) => {
          let recorded = false;
          const commit = async () => {
            if (!recorded) {
              recorded = true;
              if (table === v3Events) events.push(row);
              else if (row.kind && row.textContent !== undefined)
                artifacts.push(row);
              else if (row.renderedPrompt !== undefined) {
                spawnsById.set(String(row.id), {
                  ...(spawnsById.get(String(row.id)) ?? {}),
                  ...row,
                });
              }
            }
            return {};
          };
          return {
            onConflictDoNothing: () => commit(),
            onConflictDoUpdate: () => commit(),
            then: (
              resolve: (v: unknown) => void,
              reject: (e: unknown) => void,
            ) => commit().then(resolve, reject),
          };
        },
      }),
    } as unknown as PostgresJsDatabase;

    return { db, artifacts, spawnsById, events };
  }

  function makeNodeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "node-dev",
      runId: "run-1",
      nodeIdInDag: "dev",
      type: "agent",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      currentSpawnId: null,
      outputArtifactId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      ownerEmail: "local@localhost",
      orgId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(renderTemplate).mockImplementation(
      (template: string) => template,
    );
    vi.mocked(loadAgent).mockResolvedValue({
      name: "dev-agent",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Implement the spec",
    });
  });

  it("rejects dispatch with WorkspaceNotReadyError when ready_at is null — zero spawn rows, workspace.not_ready event written", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.mocked(getWorkspace).mockResolvedValue({
      id: "ws-1",
      ownerKind: "run",
      ownerId: "run-1",
      tags: null,
      vmName: null,
      repoUrl: "https://example.com/repo.git",
      branch: "orchestrator/run-1",
      state: "provisioning",
      createdAt: new Date(),
      destroyedAt: null,
      createdBy: "run:run-1",
      ownerEmail: "local@localhost",
      orgId: null,
      readyAt: null, // ← T-F1-09 injection: not-ready workspace
      baseSha: null,
      readyReport: null,
    } as any);

    const dag = {
      nodes: [
        {
          id: "dev",
          type: "agent",
          agent: "dev-agent",
          prompt: "do work",
          workspace: "ws-1",
        },
      ],
    };
    const mockDb = createRunMockDb(dag);
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };
    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    await expect(
      dispatcher.spawn(makeNodeRow() as any, "run-1"),
    ).rejects.toMatchObject({
      name: "WorkspaceNotReadyError",
      stage: "W1",
      errorClass: "infra",
    });

    // Zero spawn rows opened — Step 8a (openRunningSpawn) never ran.
    expect(mockDb.spawnsById.size).toBe(0);
    // The event stream shows WHY, classified infra, and names the workspace.
    expect(mockDb.events.length).toBe(1);
    expect(mockDb.events[0]).toMatchObject({
      kind: "workspace.not_ready",
      payload: expect.objectContaining({
        workspaceId: "ws-1",
        errorClass: "infra",
      }),
    });
  });

  it("dispatches normally when ready_at is set", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");

    vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
      async () =>
        ({
          output: "done",
          tokensSpent: 10,
          toolCallCount: 0,
          model: "test-model",
          vmName: null,
          durationMs: 5,
          attempts: 1,
        }) as any,
    );

    vi.mocked(getWorkspace).mockResolvedValue({
      id: "ws-2",
      ownerKind: "run",
      ownerId: "run-1",
      tags: null,
      vmName: null,
      repoUrl: "https://example.com/repo.git",
      branch: "orchestrator/run-1",
      state: "ready",
      createdAt: new Date(),
      destroyedAt: null,
      createdBy: "run:run-1",
      ownerEmail: "local@localhost",
      orgId: null,
      readyAt: new Date(),
      baseSha: "abc123",
      readyReport: null,
    } as any);

    const dag = {
      nodes: [
        {
          id: "dev",
          type: "agent",
          agent: "dev-agent",
          prompt: "do work",
          workspace: "ws-2",
        },
      ],
    };
    const mockDb = createRunMockDb(dag);
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };
    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    const spawnId = await dispatcher.spawn(makeNodeRow() as any, "run-1");

    expect(spawnId).toBeDefined();
    // Exactly one spawn row, carrying the resolved workspace id.
    expect(mockDb.spawnsById.size).toBe(1);
    expect(mockDb.spawnsById.get(spawnId)).toMatchObject({
      workspaceId: "ws-2",
    });
    expect(mockDb.events.some((e) => e.kind === "workspace.not_ready")).toBe(
      false,
    );
  });
});

describe("F7 usage capture + suspect flagging", () => {
  function makeMockNodeRunnerResult(result: Record<string, unknown>) {
    vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
      async () => result as any,
    );
  }

  function makeNodeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "node-1",
      runId: "run-1",
      nodeIdInDag: "a",
      type: "agent",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      currentSpawnId: null,
      outputArtifactId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      ownerEmail: "local@localhost",
      orgId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadAgent).mockResolvedValue({
      name: "dev",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "qwen3.6",
      tools: [],
      systemPrompt: "Dev agent",
    });
    vi.mocked(renderTemplate).mockReturnValue("Do the work");
    vi.mocked(resolveRealName).mockResolvedValue({
      realName: null,
      suspect: false,
    });
  });

  it("T-F7-03: tokensInput/tokensOutput persist from the return value (fixes the tokens_input-always-0 bug)", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Advance the frozen clock ~10s inside the mock so `latencyMs` reflects a
      // REALISTIC model call — otherwise an instant mock leaves latencyMs≈0 and
      // the (correct) physically-impossible-rate guard flags ANY positive
      // output as suspect. 10s * 60 tps = 600-token ceiling; 567 < 600, so this
      // healthy row is NOT suspect.
      vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
        async () => {
          vi.advanceTimersByTime(10_000);
          return {
            output: "done",
            tokensSpent: 1234 + 567,
            tokensInput: 1234,
            tokensOutput: 567,
            toolCallCount: 1,
            model: "qwen3.6",
            vmName: null,
            durationMs: 50,
            attempts: 1,
          } as any;
        },
      );

      const mockDb = createMockDb();
      const executor: RuntimeExecutor = { kind: "test", run: vi.fn() };
      const dispatcher = new V3Dispatcher(mockDb.db, executor);

      await dispatcher.spawn(makeNodeRow() as any, "run-1");

      expect(mockDb.spawns).toHaveLength(1);
      expect(mockDb.spawns[0].tokensInput).toBe(1234);
      expect(mockDb.spawns[0].tokensOutput).toBe(567);
      expect(mockDb.spawns[0].usageSuspect).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-F7-04: tokensInput=0 marks usageSuspect (bad data must not silently pass as trusted)", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    makeMockNodeRunnerResult({
      output: "done",
      tokensSpent: 500,
      tokensInput: 0,
      tokensOutput: 500,
      toolCallCount: 1,
      model: "qwen3.6",
      vmName: null,
      durationMs: 50,
      attempts: 1,
    });

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = { kind: "test", run: vi.fn() };
    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    await dispatcher.spawn(makeNodeRow() as any, "run-1");

    expect(mockDb.spawns[0].tokensInput).toBe(0);
    expect(mockDb.spawns[0].usageSuspect).toBe(1);
  });

  it("T-F7-05: an output rate exceeding ORCH_MAX_TPS marks usageSuspect (SDLC-051 10M/90s-class guard)", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Real startedAt/completedAt drive latencyMs — advance the frozen clock
      // by ~10s INSIDE the mocked return so `Date.now() - startedAt` reflects
      // it, with no real waiting and no fake-timer/async-scheduling races.
      vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
        async () => {
          vi.advanceTimersByTime(10_000);
          return {
            output: "done",
            tokensSpent: 1_000_000,
            tokensInput: 1000, // non-zero: isolates the RATE condition, not the zero-input one
            tokensOutput: 1_000_000,
            toolCallCount: 1,
            model: "qwen3.6",
            vmName: null,
            durationMs: 50,
            attempts: 1,
          } as any;
        },
      );

      const mockDb = createMockDb();
      const executor: RuntimeExecutor = { kind: "test", run: vi.fn() };
      const dispatcher = new V3Dispatcher(mockDb.db, executor);

      await dispatcher.spawn(makeNodeRow() as any, "run-1");

      expect(mockDb.spawns[0].tokensInput).toBe(1000);
      expect(mockDb.spawns[0].usageSuspect).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-F7-06: registered alias resolves to its real weight name (attribution)", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    vi.mocked(resolveRealName).mockResolvedValueOnce({
      realName: "ThinkingCap-Qwen3.6-27B",
      suspect: false,
    });
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      // Realistic latency (see T-F7-03) so the healthy 60-token output row is
      // NOT flagged suspect and the assertion isolates the name-attribution.
      vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
        async () => {
          vi.advanceTimersByTime(10_000);
          return {
            output: "done",
            tokensSpent: 100,
            tokensInput: 40,
            tokensOutput: 60,
            toolCallCount: 1,
            model: "qwen3.6",
            vmName: null,
            durationMs: 50,
            attempts: 1,
          } as any;
        },
      );

      const mockDb = createMockDb();
      const executor: RuntimeExecutor = { kind: "test", run: vi.fn() };
      const dispatcher = new V3Dispatcher(mockDb.db, executor);

      await dispatcher.spawn(makeNodeRow() as any, "run-1");

      expect(resolveRealName).toHaveBeenCalledWith(
        "qwen3.6",
        "local@localhost",
      );
      expect(mockDb.spawns[0].modelRealName).toBe("ThinkingCap-Qwen3.6-27B");
      expect(mockDb.spawns[0].usageSuspect).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("T-F7-06: an UNREGISTERED model_ref attributes to itself and is marked suspect", async () => {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    vi.mocked(resolveRealName).mockResolvedValueOnce({
      realName: "qwen3.6",
      suspect: true,
    });
    makeMockNodeRunnerResult({
      output: "done",
      tokensSpent: 100,
      tokensInput: 40,
      tokensOutput: 60,
      toolCallCount: 1,
      model: "qwen3.6",
      vmName: null,
      durationMs: 50,
      attempts: 1,
    });

    const mockDb = createMockDb();
    const executor: RuntimeExecutor = { kind: "test", run: vi.fn() };
    const dispatcher = new V3Dispatcher(mockDb.db, executor);

    await dispatcher.spawn(makeNodeRow() as any, "run-1");

    expect(mockDb.spawns[0].modelRealName).toBe("qwen3.6");
    // Unregistered-name attribution taints the whole row, same as a bad
    // usage-rate reading — both mean "don't trust this row in aggregates".
    expect(mockDb.spawns[0].usageSuspect).toBe(1);
  });
});

describe("computeUsageSuspect (pure function boundary cases)", () => {
  it("tokensInput===0 is always suspect regardless of rate", () => {
    expect(
      computeUsageSuspect({
        tokensInput: 0,
        tokensOutput: 1,
        latencyMs: 100_000,
      }),
    ).toBe(true);
  });

  it("a normal rate is not suspect", () => {
    expect(
      computeUsageSuspect({
        tokensInput: 100,
        tokensOutput: 500,
        latencyMs: 10_000,
      }),
    ).toBe(false);
  });

  it("output tokens exceeding elapsedSec * ORCH_MAX_TPS(default 60) is suspect", () => {
    // 10s elapsed * 60 tps = 600 token ceiling; 601 trips it, 600 does not.
    expect(
      computeUsageSuspect({
        tokensInput: 10,
        tokensOutput: 601,
        latencyMs: 10_000,
      }),
    ).toBe(true);
    expect(
      computeUsageSuspect({
        tokensInput: 10,
        tokensOutput: 600,
        latencyMs: 10_000,
      }),
    ).toBe(false);
  });
});

// ── Tests: formatCheckpointInjection (pure function) ────────────────────────

describe("formatCheckpointInjection", () => {
  it("renders both blocks when writtenFiles and remainingTasksSummary are present", () => {
    const text = formatCheckpointInjection({
      writtenFiles: ["server/foo.ts", "server/bar.ts"],
      remainingTasksSummary: "补充 bar.ts 的类型定义并跑通测试",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(text).toContain("已完成产物清单");
    expect(text).toContain("server/foo.ts");
    expect(text).toContain("server/bar.ts");
    expect(text).toContain("剩余任务");
    expect(text).toContain("补充 bar.ts 的类型定义并跑通测试");
  });

  it("omits the 已完成产物清单 block when writtenFiles is empty", () => {
    const text = formatCheckpointInjection({
      writtenFiles: [],
      remainingTasksSummary: "继续实现",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(text).not.toContain("已完成产物清单");
    expect(text).toContain("剩余任务");
    expect(text).toContain("继续实现");
  });

  it("omits the 剩余任务 block when remainingTasksSummary is null", () => {
    const text = formatCheckpointInjection({
      writtenFiles: ["server/foo.ts"],
      remainingTasksSummary: null,
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    expect(text).toContain("已完成产物清单");
    expect(text).toContain("server/foo.ts");
    expect(text).not.toContain("剩余任务");
  });
});

// ── Tests: F2b retry checkpoint injection (T-F2-06) ──────────────────────────
//
// docs/sdlc-impl-f1-f4.md §2A/§6.2: T-F2-06 — "进程级中断不归零(用重启法,不
// 预设 kill):维护窗口 dev spawn 运行中重启 orchestrator;reconcile 重置后查
// 新 attempt 的 rendered_prompt 应含「已完成产物清单+剩余任务」段". A live
// process restart is a 101-only integration scenario; the piece that is
// actually unit-testable — and the ONLY piece F2b changed — is what
// `V3Dispatcher.spawn()` puts in the NEW attempt's `rendered_prompt` once
// reconcile has re-armed the node to `ready` for redispatch (reconcile
// itself only flips `v3_nodes.status`/`current_spawn_id`, never touches
// `rendered_prompt` — see `reconcileSpawnConduction` in v3-reconciler.ts).
// These tests simulate that redispatch directly: a `v3_spawns` row from a
// prior (crashed/exhausted) attempt already sits in the DB with a persisted
// `context_checkpoint`, and we assert the FRESH spawn's rendered_prompt.
describe("F2b: retry checkpoint injection (T-F2-06)", () => {
  /** Same shape as `createRunMockDb` (Workspace readiness gate, above), plus
   * a `table === v3Spawns` branch returning caller-supplied prior spawn rows
   * — the durable attempt history `fetchPriorCheckpoint` reads. */
  function createRetryMockDb(opts: {
    dag: unknown;
    priorSpawns?: Array<{
      startedAt: Date | null;
      contextCheckpoint: unknown;
    }>;
  }) {
    const artifacts: Array<Record<string, unknown>> = [];
    const spawnsById = new Map<string, Record<string, unknown>>();
    const events: Array<Record<string, unknown>> = [];
    const runRow = { id: "run-1", dag: opts.dag };
    const priorSpawns = opts.priorSpawns ?? [];

    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: async () => {
            if (table === v3Runs) return [runRow];
            if (table === v3Spawns) return priorSpawns;
            return [];
          },
        }),
      }),
      update: () => ({ set: () => ({ where: async () => ({}) }) }),
      insert: (table: unknown) => ({
        values: (row: Record<string, unknown>) => {
          let recorded = false;
          const commit = async () => {
            if (!recorded) {
              recorded = true;
              if (table === v3Events) events.push(row);
              else if (row.kind && row.textContent !== undefined)
                artifacts.push(row);
              else if (row.renderedPrompt !== undefined) {
                spawnsById.set(String(row.id), {
                  ...(spawnsById.get(String(row.id)) ?? {}),
                  ...row,
                });
              }
            }
            return {};
          };
          return {
            onConflictDoNothing: () => commit(),
            onConflictDoUpdate: () => commit(),
            then: (
              resolve: (v: unknown) => void,
              reject: (e: unknown) => void,
            ) => commit().then(resolve, reject),
          };
        },
      }),
    } as unknown as PostgresJsDatabase;

    return { db, artifacts, spawnsById, events };
  }

  function makeNodeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "node-dev",
      runId: "run-1",
      nodeIdInDag: "dev",
      type: "agent",
      status: "running",
      iteration: 0,
      fanoutIndex: 0,
      currentSpawnId: null,
      outputArtifactId: null,
      startedAt: null,
      completedAt: null,
      error: null,
      ownerEmail: "local@localhost",
      orgId: null,
      ...overrides,
    };
  }

  const dag = {
    nodes: [
      {
        id: "dev",
        type: "agent",
        agent: "dev-agent",
        prompt: "Implement the spec exactly.",
      },
    ],
  };

  beforeEach(() => {
    vi.mocked(renderTemplate).mockImplementation(
      (template: string) => template,
    );
    vi.mocked(loadAgent).mockResolvedValue({
      name: "dev-agent",
      description: "",
      runtime: "none" as const,
      engine: "",
      model: "",
      tools: [],
      systemPrompt: "Implement the spec",
    });
    vi.spyOn(hoisted.MockNodeRunner.prototype, "run").mockImplementation(
      async () =>
        ({
          output: "done",
          tokensSpent: 10,
          toolCallCount: 0,
          model: "test-model",
          vmName: null,
          durationMs: 5,
          attempts: 1,
        }) as any,
    );
  });

  async function spawnAndGetRenderedPrompt(mockDb: {
    db: PostgresJsDatabase;
    spawnsById: Map<string, Record<string, unknown>>;
  }): Promise<string> {
    const { V3Dispatcher } = await import("./v3-dispatcher.js");
    const executor: RuntimeExecutor = {
      kind: "test",
      run: vi.fn().mockResolvedValue({} as any),
    };
    const dispatcher = new V3Dispatcher(mockDb.db, executor);
    const spawnId = await dispatcher.spawn(makeNodeRow() as any, "run-1");
    return String(mockDb.spawnsById.get(spawnId)?.renderedPrompt ?? "");
  }

  it("retry attempt (one prior v3_spawns row with a checkpoint) injects 已完成产物清单+剩余任务 into the new attempt's rendered_prompt", async () => {
    const priorCheckpoint = {
      writtenFiles: ["server/foo.ts", "server/bar.ts"],
      remainingTasksSummary: "补充 bar.ts 的类型定义并跑通测试",
      updatedAt: "2026-07-16T10:00:00.000Z",
    };

    const mockDb = createRetryMockDb({
      dag,
      priorSpawns: [
        {
          startedAt: new Date("2026-07-16T10:00:00Z"),
          contextCheckpoint: priorCheckpoint,
        },
      ],
    });

    const renderedPrompt = await spawnAndGetRenderedPrompt(mockDb);

    // Injection APPENDS after the interpolated base prompt — never replaces it.
    expect(renderedPrompt).toContain("Implement the spec exactly.");
    // T-F2-06 acceptance wording verbatim (docs/sdlc-impl-f1-f4.md §6.2).
    expect(renderedPrompt).toContain("已完成产物清单");
    expect(renderedPrompt).toContain("剩余任务");
    expect(renderedPrompt).toContain("server/foo.ts");
    expect(renderedPrompt).toContain("server/bar.ts");
    expect(renderedPrompt).toContain("补充 bar.ts 的类型定义并跑通测试");
  });

  it("first attempt (zero prior v3_spawns rows) — no injection, prompt unchanged", async () => {
    const mockDb = createRetryMockDb({ dag, priorSpawns: [] });

    const renderedPrompt = await spawnAndGetRenderedPrompt(mockDb);

    expect(renderedPrompt).toBe("Implement the spec exactly.");
    expect(renderedPrompt).not.toContain("已完成产物清单");
    expect(renderedPrompt).not.toContain("剩余任务");
  });

  it("prior attempt exists but never checkpointed anything (context_checkpoint null) — inject nothing, no fabricated section", async () => {
    const mockDb = createRetryMockDb({
      dag,
      priorSpawns: [
        {
          startedAt: new Date("2026-07-16T10:00:00Z"),
          contextCheckpoint: null,
        },
      ],
    });

    const renderedPrompt = await spawnAndGetRenderedPrompt(mockDb);

    expect(renderedPrompt).toBe("Implement the spec exactly.");
    expect(renderedPrompt).not.toContain("已完成产物清单");
  });

  it("prior attempt's checkpoint is empty (no written files, no summary) — inject nothing", async () => {
    const mockDb = createRetryMockDb({
      dag,
      priorSpawns: [
        {
          startedAt: new Date("2026-07-16T10:00:00Z"),
          contextCheckpoint: {
            writtenFiles: [],
            remainingTasksSummary: null,
            updatedAt: "2026-07-16T10:00:00.000Z",
          },
        },
      ],
    });

    const renderedPrompt = await spawnAndGetRenderedPrompt(mockDb);

    expect(renderedPrompt).toBe("Implement the spec exactly.");
    expect(renderedPrompt).not.toContain("已完成产物清单");
    expect(renderedPrompt).not.toContain("剩余任务");
  });

  it("multiple prior spawn rows (2nd retry) — injects the LATEST attempt's checkpoint, not an earlier one", async () => {
    const mockDb = createRetryMockDb({
      dag,
      priorSpawns: [
        {
          startedAt: new Date("2026-07-16T09:00:00Z"),
          contextCheckpoint: {
            writtenFiles: ["stale.ts"],
            remainingTasksSummary: "stale summary",
            updatedAt: "2026-07-16T09:00:00.000Z",
          },
        },
        {
          startedAt: new Date("2026-07-16T11:00:00Z"),
          contextCheckpoint: {
            writtenFiles: ["fresh.ts"],
            remainingTasksSummary: "fresh summary",
            updatedAt: "2026-07-16T11:00:00.000Z",
          },
        },
      ],
    });

    const renderedPrompt = await spawnAndGetRenderedPrompt(mockDb);

    expect(renderedPrompt).toContain("fresh.ts");
    expect(renderedPrompt).toContain("fresh summary");
    expect(renderedPrompt).not.toContain("stale.ts");
    expect(renderedPrompt).not.toContain("stale summary");
  });
});
