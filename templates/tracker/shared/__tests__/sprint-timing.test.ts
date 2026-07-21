import { describe, expect, it } from "vitest";

import {
  classifyNodeStage,
  deriveWorkItemTimings,
  formatDurationSec,
  spawnItemId,
  type NodeTimingRow,
  type SpawnTimingRow,
} from "../sprint-timing.js";

const NODES: NodeTimingRow[] = [
  { id: "n-dev", nodeIdInDag: "dev" },
  { id: "n-qa", nodeIdInDag: "qa" },
  { id: "n-review", nodeIdInDag: "review1" },
  { id: "n-gate", nodeIdInDag: "gateTests" },
  { id: "n-unknown", nodeIdInDag: "promote" },
];

function spawn(partial: Partial<SpawnTimingRow> & { id: string }): SpawnTimingRow {
  return {
    nodeId: null,
    runId: null,
    status: "done",
    tags: { source: "tracker", item_id: "WI-1" },
    startedAt: null,
    completedAt: null,
    ...partial,
  };
}

describe("classifyNodeStage — DAG node id → review stage", () => {
  it("maps the workflow-library node families onto the four stages", () => {
    expect(classifyNodeStage("dev")).toBe("dev");
    expect(classifyNodeStage("develop")).toBe("dev");
    expect(classifyNodeStage("devFix")).toBe("dev");
    expect(classifyNodeStage("qa")).toBe("qa");
    expect(classifyNodeStage("qa2")).toBe("qa");
    expect(classifyNodeStage("review1")).toBe("review");
    expect(classifyNodeStage("reviewfix")).toBe("review");
    expect(classifyNodeStage("merge_review")).toBe("review");
    expect(classifyNodeStage("gateStack")).toBe("gate");
    expect(classifyNodeStage("gateTests")).toBe("gate");
  });

  it("returns null for unknown / empty node ids (never guesses)", () => {
    expect(classifyNodeStage("promote")).toBeNull();
    expect(classifyNodeStage("audit")).toBeNull();
    expect(classifyNodeStage("")).toBeNull();
    expect(classifyNodeStage(null)).toBeNull();
  });
});

describe("spawnItemId — read item_id off raw spawn tags", () => {
  it("reads from a JSONB object", () => {
    expect(spawnItemId({ source: "tracker", item_id: "WI-9" })).toBe("WI-9");
  });
  it("reads from a JSON string", () => {
    expect(spawnItemId('{"item_id":"WI-7"}')).toBe("WI-7");
  });
  it("returns null when absent / malformed", () => {
    expect(spawnItemId({})).toBeNull();
    expect(spawnItemId("not json")).toBeNull();
    expect(spawnItemId(null)).toBeNull();
    expect(spawnItemId(["item_id"])).toBeNull();
  });
});

describe("deriveWorkItemTimings — real v3_spawns timestamps only (M5)", () => {
  it("derives each stage's duration from started_at/completed_at and keeps raw timestamps", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-dev",
        runId: "r1",
        startedAt: "2026-07-01T10:00:00Z",
        completedAt: "2026-07-01T10:10:00Z", // 600s
      }),
      spawn({
        id: "s2",
        nodeId: "n-qa",
        runId: "r1",
        startedAt: "2026-07-01T10:10:00Z",
        completedAt: "2026-07-01T10:15:30Z", // 330s
      }),
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    const dev = wi!.stages.find((s) => s.stage === "dev")!;
    const qa = wi!.stages.find((s) => s.stage === "qa")!;
    expect(dev.totalSec).toBe(600);
    expect(dev.spawnCount).toBe(1);
    // Raw source timestamps preserved verbatim for human cross-check.
    expect(dev.spawns[0]!.startedAt).toBe("2026-07-01T10:00:00Z");
    expect(dev.spawns[0]!.completedAt).toBe("2026-07-01T10:10:00Z");
    expect(dev.spawns[0]!.durationSec).toBe(600);
    expect(dev.spawns[0]!.nodeIdInDag).toBe("dev");
    expect(qa.totalSec).toBe(330);
  });

  it("sums multiple spawns (retries) within the same stage", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-review",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:05:00Z", // 300s
      }),
      spawn({
        id: "s2",
        nodeId: "n-review",
        startedAt: "2026-07-01T01:00:00Z",
        completedAt: "2026-07-01T01:02:00Z", // 120s
      }),
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    const review = wi!.stages.find((s) => s.stage === "review")!;
    expect(review.totalSec).toBe(420);
    expect(review.spawnCount).toBe(2);
  });

  it("reports `no data` (null) for a stage with no spawn — never 0", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-dev",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:01:00Z",
      }),
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    expect(wi!.stages.find((s) => s.stage === "dev")!.totalSec).toBe(60);
    expect(wi!.stages.find((s) => s.stage === "qa")!.totalSec).toBeNull();
    expect(wi!.stages.find((s) => s.stage === "gate")!.totalSec).toBeNull();
  });

  it("treats a still-running spawn (no completed_at) as no measured duration", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-dev",
        status: "running",
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: null,
      }),
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    const dev = wi!.stages.find((s) => s.stage === "dev")!;
    expect(dev.totalSec).toBeNull();
    expect(dev.spawnCount).toBe(0);
    // The running spawn is still listed as evidence (null duration).
    expect(dev.spawns).toHaveLength(1);
    expect(dev.spawns[0]!.durationSec).toBeNull();
  });

  it("only counts spawns tagged for the given work item", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-dev",
        tags: { item_id: "WI-1" },
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:01:00Z",
      }),
      spawn({
        id: "s2",
        nodeId: "n-dev",
        tags: { item_id: "WI-2" },
        startedAt: "2026-07-01T00:00:00Z",
        completedAt: "2026-07-01T00:09:00Z",
      }),
    ];
    const rows = deriveWorkItemTimings(spawns, NODES, ["WI-1", "WI-2"]);
    expect(rows[0]!.stages.find((s) => s.stage === "dev")!.totalSec).toBe(60);
    expect(rows[1]!.stages.find((s) => s.stage === "dev")!.totalSec).toBe(540);
  });

  it("skips spawns whose node id is unknown or absent (never guesses a stage)", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({ id: "s1", nodeId: "n-unknown" }), // promote → not a timed stage
      spawn({ id: "s2", nodeId: null }), // ad-hoc spawn
      spawn({ id: "s3", nodeId: "n-missing" }), // node row not provided
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    for (const s of wi!.stages) {
      expect(s.totalSec).toBeNull();
      expect(s.spawns).toHaveLength(0);
    }
  });

  it("ignores a malformed row where completed_at precedes started_at", () => {
    const spawns: SpawnTimingRow[] = [
      spawn({
        id: "s1",
        nodeId: "n-dev",
        startedAt: "2026-07-01T01:00:00Z",
        completedAt: "2026-07-01T00:00:00Z",
      }),
    ];
    const [wi] = deriveWorkItemTimings(spawns, NODES, ["WI-1"]);
    expect(wi!.stages.find((s) => s.stage === "dev")!.totalSec).toBeNull();
  });

  it("always emits a row (with no-data stages) for every requested work item", () => {
    const rows = deriveWorkItemTimings([], NODES, ["WI-1", "WI-2"]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.workItemId)).toEqual(["WI-1", "WI-2"]);
    expect(rows[0]!.stages).toHaveLength(4);
  });
});

describe("formatDurationSec", () => {
  it("renders no-data and the s/m/h buckets", () => {
    expect(formatDurationSec(null)).toBe("无数据");
    expect(formatDurationSec(45)).toBe("45s");
    expect(formatDurationSec(750)).toBe("12m30s");
    expect(formatDurationSec(7500)).toBe("2h05m");
  });
});
