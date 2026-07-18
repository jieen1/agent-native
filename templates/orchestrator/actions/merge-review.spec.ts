// Task board #95 — mandatory independent-review gate ahead of
// `workspaceMergePr`. Unit tests for the verdict-storage/gating action layer
// (mergeReviewStart/mergeReviewGet/mergeReviewOverride). No live LLM call —
// the review DISPATCH itself (`workflowRun.run`) is mocked, exactly like
// `./v3-workspace.js`'s workspace lookup. The gate DECISION logic itself is
// covered exhaustively, DB-free, in server/engine/merge-review-gate.spec.ts;
// this file proves the actions wire real rows into that decision correctly.
//
// Uses the same minimal hand-rolled server/db/index.js mock as
// actions/v3-runs.spec.ts / actions/v3-run-detail.spec.ts, extended to
// disambiguate the TWO different queries this module makes against v3_runs
// (find-latest-review vs. load-origin-run-for-context) by the shape of the
// `select({...})` column projection each one passes — `inputs` in the
// projection means "origin run lookup", never present in the "latest review"
// lookup's own projection.

import { describe, it, expect, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const state = {
    reviewRuns: [] as Array<Record<string, unknown>>,
    originRuns: [] as Array<Record<string, unknown>>,
    nodes: [] as Array<Record<string, unknown>>,
    artifacts: [] as Array<Record<string, unknown>>,
    overrides: [] as Array<Record<string, unknown>>,
  };

  function tableKind(table: unknown): string {
    if (table && typeof table === "object") {
      if ("reviewRunId" in (table as object)) return "overrides";
      if ("objectContent" in (table as object)) return "artifacts";
      if ("nodeIdInDag" in (table as object)) return "nodes";
      if ("dagVersion" in (table as object)) return "runs";
    }
    return "unknown";
  }

  function makeDb() {
    return {
      select: (cols?: Record<string, unknown>) => ({
        from: (table: unknown) => {
          const kind = tableKind(table);
          let rows: Array<Record<string, unknown>> = [];
          if (kind === "runs") {
            rows =
              cols && "inputs" in cols ? state.originRuns : state.reviewRuns;
          } else if (kind === "nodes") {
            rows = state.nodes;
          } else if (kind === "artifacts") {
            rows = state.artifacts;
          } else if (kind === "overrides") {
            rows = state.overrides;
          }
          return {
            where: (_filter?: unknown) => ({
              orderBy: (_o?: unknown) => ({
                limit: (n: number) => rows.slice(0, n),
              }),
              limit: (n: number) => rows.slice(0, n),
            }),
          };
        },
      }),
      insert: (table: unknown) => ({
        values: async (data: Record<string, unknown>) => {
          const kind = tableKind(table);
          if (kind === "overrides") {
            state.overrides.unshift({ createdAt: new Date(), ...data });
          }
        },
      }),
    };
  }

  return { state, makeDb, tableKind };
});

vi.mock("../server/db/index.js", async () => {
  const v3Schema = await vi.importActual<
    typeof import("../server/db/v3-schema.js")
  >("../server/db/v3-schema.js");
  return {
    v3Schema,
    schema: {},
    getV3Db: () => hoisted.makeDb(),
    resolveOwnerEmail: () => "local@localhost",
  };
});

vi.mock("./v3-workspace.js", () => ({
  assertWorkspaceExists: vi.fn(async (workspaceId: string) => ({
    id: workspaceId,
    ownerKind: "user",
    ownerId: "local@localhost",
    tags: null,
    vmName: null,
    repoUrl: "https://github.com/x/y",
    branch: "run-branch",
    state: "ready",
    createdAt: null,
    destroyedAt: null,
    createdBy: "local@localhost",
  })),
}));

vi.mock("./v3-workflow.js", () => ({
  workflowRun: {
    run: vi.fn(async () => ({
      runId: "v3r_new_review",
      dagVersion: 1,
      templateId: "v3wf_merge_review",
      templateVersion: 1,
      status: "pending" as const,
      nodeCount: 1,
    })),
  },
}));

import {
  mergeReviewGet,
  mergeReviewOverride,
  mergeReviewStart,
} from "./merge-review.js";
import { workflowRun } from "./v3-workflow.js";

function resetState(): void {
  hoisted.state.reviewRuns.length = 0;
  hoisted.state.originRuns.length = 0;
  hoisted.state.nodes.length = 0;
  hoisted.state.artifacts.length = 0;
  hoisted.state.overrides.length = 0;
  vi.mocked(workflowRun.run).mockClear();
}

describe("mergeReviewGet", () => {
  beforeEach(resetState);

  it("reports blocked with no review and no override when nothing has ever run", async () => {
    const result = await mergeReviewGet.run({ workspaceId: "ws1" });
    expect(result.review).toBeNull();
    expect(result.override).toBeNull();
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
  });

  it("allows merge once the review run's node output is a safe_to_merge verdict", async () => {
    hoisted.state.reviewRuns.push({
      id: "v3r_review1",
      status: "done",
      startedAt: new Date("2026-07-18T00:00:00Z"),
      completedAt: new Date("2026-07-18T00:05:00Z"),
    });
    hoisted.state.nodes.push({
      status: "done",
      error: null,
      outputArtifactId: "art1",
    });
    hoisted.state.artifacts.push({
      objectContent: {
        verdict: "safe_to_merge",
        summary: "No blocking issues.",
        findings: [],
      },
      textContent: null,
    });

    const result = await mergeReviewGet.run({ workspaceId: "ws1" });
    expect(result.review?.verdict).toBe("safe_to_merge");
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("review-passed");
  });

  it("blocks merge when the review flags concerns and there is no override, surfacing findings", async () => {
    hoisted.state.reviewRuns.push({
      id: "v3r_review1",
      status: "done",
      startedAt: new Date("2026-07-18T00:00:00Z"),
      completedAt: new Date("2026-07-18T00:05:00Z"),
    });
    hoisted.state.nodes.push({
      status: "done",
      error: null,
      outputArtifactId: "art1",
    });
    hoisted.state.artifacts.push({
      objectContent: {
        verdict: "concerns_found",
        summary: "Missing tests for the new branch.",
        findings: ["no unit test for the new gate", "hardcoded timeout"],
      },
      textContent: null,
    });

    const result = await mergeReviewGet.run({ workspaceId: "ws1" });
    expect(result.canMerge).toBe(false);
    expect(result.source).toBe("blocked");
    expect(result.review?.findings).toEqual([
      "no unit test for the new gate",
      "hardcoded timeout",
    ]);
  });

  it("allows merge via a human override recorded against the SAME flagged review", async () => {
    hoisted.state.reviewRuns.push({
      id: "v3r_review1",
      status: "done",
      startedAt: new Date("2026-07-18T00:00:00Z"),
      completedAt: new Date("2026-07-18T00:05:00Z"),
    });
    hoisted.state.nodes.push({
      status: "done",
      error: null,
      outputArtifactId: "art1",
    });
    hoisted.state.artifacts.push({
      objectContent: {
        verdict: "concerns_found",
        summary: "flagged",
        findings: ["x"],
      },
      textContent: null,
    });
    hoisted.state.overrides.push({
      reviewRunId: "v3r_review1",
      reason: "verified manually, findings are false positives",
      overriddenBy: "human@example.com",
      createdAt: new Date("2026-07-18T01:00:00Z"),
    });

    const result = await mergeReviewGet.run({ workspaceId: "ws1" });
    expect(result.canMerge).toBe(true);
    expect(result.source).toBe("human-override");
    expect(result.override?.reason).toContain("false positives");
  });
});

describe("mergeReviewStart", () => {
  beforeEach(resetState);

  it("dispatches a fresh sdlc-merge-review run through workflowRun (the mocked review dispatch) when none exists yet", async () => {
    hoisted.state.originRuns.push({
      inputs: { spec: "Add the merge review gate", workspaceId: "ws1" },
      tags: { pr_url: "https://github.com/x/y/pull/42" },
    });

    const result = await mergeReviewStart.run({
      workspaceId: "ws1",
      runId: "v3r_origin",
    });

    expect(workflowRun.run).toHaveBeenCalledTimes(1);
    const call = vi.mocked(workflowRun.run).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(call.template).toBe("sdlc-merge-review");
    expect((call.inputs as Record<string, unknown>).workspaceId).toBe("ws1");
    expect((call.inputs as Record<string, unknown>).spec).toBe(
      "Add the merge review gate",
    );
    expect((call.inputs as Record<string, unknown>).prUrl).toBe(
      "https://github.com/x/y/pull/42",
    );
    expect(call.tags).toEqual({
      mergeReviewFor: "ws1",
      originRunId: "v3r_origin",
    });

    expect(result).toEqual({
      reviewRunId: "v3r_new_review",
      status: "pending",
      alreadyRunning: false,
    });
  });

  it("falls back to a generic spec when the origin run has neither spec nor goal", async () => {
    hoisted.state.originRuns.push({ inputs: {}, tags: {} });

    await mergeReviewStart.run({ workspaceId: "ws1", runId: "v3r_origin" });

    const call = vi.mocked(workflowRun.run).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect((call.inputs as Record<string, unknown>).spec).toContain(
      "未提供原始规格",
    );
  });

  it("does NOT start a duplicate dispatch when a review is already pending/running for this workspace", async () => {
    hoisted.state.reviewRuns.push({
      id: "v3r_inflight",
      status: "running",
      startedAt: new Date(),
      completedAt: null,
    });

    const result = await mergeReviewStart.run({
      workspaceId: "ws1",
      runId: "v3r_origin",
    });

    expect(workflowRun.run).not.toHaveBeenCalled();
    expect(result).toEqual({
      reviewRunId: "v3r_inflight",
      status: "running",
      alreadyRunning: true,
    });
  });
});

describe("mergeReviewOverride", () => {
  beforeEach(resetState);

  it("pins a new override to the current latest review run", async () => {
    hoisted.state.reviewRuns.push({
      id: "v3r_review1",
      status: "done",
      startedAt: new Date(),
      completedAt: new Date(),
    });

    const result = await mergeReviewOverride.run({
      workspaceId: "ws1",
      reason: "  reviewed manually, safe to merge  ",
    });

    expect(result.reviewRunId).toBe("v3r_review1");
    expect(result.reason).toBe("reviewed manually, safe to merge");
    expect(result.overriddenBy).toBe("local@localhost");
    expect(hoisted.state.overrides).toHaveLength(1);
    expect(hoisted.state.overrides[0]).toMatchObject({
      workspaceId: "ws1",
      reviewRunId: "v3r_review1",
      reason: "reviewed manually, safe to merge",
    });
  });

  it("records reviewRunId: null when overriding before any review has ever run", async () => {
    const result = await mergeReviewOverride.run({
      workspaceId: "ws1",
      reason: "hotfix, skipping review by design",
    });

    expect(result.reviewRunId).toBeNull();
    expect(hoisted.state.overrides[0]).toMatchObject({ reviewRunId: null });
  });
});
