// S8 workflow library (04-orchestrator.md §4/§13 workflowDiff action). Proves
// the action wires two saved template version fetches through to the pure
// diffDagNodes() helper (already unit-tested directly in
// server/engine/__tests__/workflow-stats.spec.ts) — this test is about the
// action's plumbing (two sequential per-version reads, error on a missing
// version), not the diff algorithm itself.
//
// Uses the same minimal hand-rolled server/db/index.js mock pattern as
// actions/v3-runs.spec.ts. workflowDiff's two `fetchVersion()` calls run via
// `Promise.all([fetchVersion(v1), fetchVersion(v2)])`; since none of the mock
// chain methods below are themselves `async`, both chains build and call
// `.limit(1)` synchronously (in v1-then-v2 program order) before either
// `await` suspends — so a plain FIFO queue of canned results, popped one per
// `.limit()` call, deterministically corresponds to [v1 result, v2 result].
// No drizzle-orm internals are mocked or introspected.

import { describe, it, expect, beforeEach, vi } from "vitest";

import { workflowDiff } from "./v3-workflow.js";

const hoisted = vi.hoisted(() => {
  const state = {
    queue: [] as Array<Array<Record<string, any>>>,
  };

  function makeDb() {
    return {
      select: (_cols?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (_n: number) => state.queue.shift() ?? [],
          }),
        }),
      }),
    };
  }

  return { state, makeDb };
});

vi.mock("../server/db/index.js", async () => {
  const v3Schema = await vi.importActual<
    typeof import("../server/db/v3-schema.js")
  >("../server/db/v3-schema.js");
  return {
    v3Schema,
    schema: {},
    getV3Db: () => hoisted.makeDb(),
    getDbExec: () => hoisted.makeDb(),
    resolveOwnerEmail: () => "local@localhost",
  };
});

function resetState(): void {
  hoisted.state.queue.length = 0;
}

describe("workflowDiff", () => {
  beforeEach(() => {
    resetState();
  });

  it("diffs two saved versions of the same template by name", async () => {
    hoisted.state.queue.push(
      [
        {
          dag: {
            nodes: [
              { id: "dev", agent: "vllm", prompt: "implement" },
              { id: "qa", agent: "vllm", prompt: "test" },
            ],
          },
        },
      ],
      [
        {
          dag: {
            nodes: [
              { id: "dev", agent: "vllm", prompt: "implement" },
              { id: "qa", agent: "vllm", prompt: "test with coverage" },
              { id: "gate", agent: "vllm", prompt: "human gate" },
            ],
          },
        },
      ],
    );

    const result = await workflowDiff.run({
      name: "sdlc-issue-pipeline",
      v1: 1,
      v2: 2,
    });

    expect(result).toEqual({
      name: "sdlc-issue-pipeline",
      v1: 1,
      v2: 2,
      added: ["gate"],
      removed: [],
      changed: ["qa"],
      unchanged: ["dev"],
    });
  });

  it("throws a clear error when a requested version does not exist", async () => {
    hoisted.state.queue.push([{ dag: { nodes: [{ id: "dev" }] } }], []); // v2 not found

    await expect(
      workflowDiff.run({ name: "sdlc-issue-pipeline", v1: 1, v2: 99 }),
    ).rejects.toThrow(/no version 99/);
  });
});
