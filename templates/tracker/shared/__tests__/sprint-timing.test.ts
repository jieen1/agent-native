import { describe, expect, it } from "vitest";

import {
  classifyNodeStage,
  deriveWorkItemTimings,
  durationSec,
  formatDurationSec,
  spawnItemId,
  type NodeTimingRow,
  type SpawnTimingRow,
} from "../sprint-timing.js";

// ── classifyNodeStage ─────────────────────────────────────────────────────────

describe("classifyNodeStage — DAG node → timing stage mapping", () => {
  it("maps dev node ids", () => {
    expect(classifyNodeStage("dev")).toBe("dev");
    expect(classifyNodeStage("develop")).toBe("dev");
    expect(classifyNodeStage("devFix")).toBe("dev");
  });
  it("maps qa node ids", () => {
    expect(classifyNodeStage("qa")).toBe("qa");
    expect(classifyNodeStage("qa2")).toBe("qa");
  });
  it("maps review node ids", () => {
    expect(classifyNodeStage("review1")).toBe("review");
    expect(classifyNodeStage("reviewfix")).toBe("review");
    expect(classifyNodeStage("merge_review")).toBe("review");
  });
  it("maps gate node ids", () => {
    expect(classifyNodeStage("gateStack")).toBe("gate");
    expect(classifyNodeStage("gateTests")).toBe("gate");
  });
  it("returns null for unmapped / empty node ids", () => {
    expect(classifyNodeStage("promote")).toBeNull();
    expect(classifyNodeStage("audit")).toBeNull();
    expect(classifyNodeStage("")).toBeNull();
    expect(classifyNodeStage(null)).toBeNull();
    expect(classifyNodeStage(undefined)).toBeNull();
  });
});

// ── spawnItemId ───────────────────────────────────────────────────────────────

describe("spawnItemId — extract item_id from tags", () => {
  it("extracts from a JSONB object", () => {
    expect(spawnItemId({ source: "tracker", item_id: "wi_1" })).toBe("wi_1");
  });
  it("extracts from a JSON string", () => {
    expect(spawnItemId('{"item_id":"wi_2"}')).toBe("wi_2");
  });
  it("returns null for missing / malformed tags", () => {
    expect(spawnItemId(null)).toBeNull();
    expect(spawnItemId(undefined)).toBeNull();
    expect(spawnItemId({})).toBeNull();
    expect(spawnItemId([])).toBeNull();
    expect(spawnItemId("not json")).toBeNull();
    expect(spawnItemId({ item_id: "" })).toBeNull();
    expect(spawnItemId({ item_id: 123 })).toBeNull();
  });
});

// ── durationSec ───────────────────────────────────────────────────────────────

describe("durationSec — honest duration from timestamps", () => {
  it("computes seconds between start and end", () => {
    expect(
      durationSec("2026-07-01T10:00:00Z", "2026-07-01T10:05:30Z"),
    ).toBeCloseTo(330, 0);
  });
  it("returns null when either timestamp is missing", () => {
    expect(durationSec(null, "2026-07-01T10:00:00Z")).toBeNull();
    expect(durationSec("2026-07-01T10:00:00Z", null)).toBeNull();
    expect(durationSec(null, null)).toBeNull();
  });
  it("returns null for unparseable timestamps", () => {
    expect(durationSec("garbage", "2026-07-01T10:00:00Z")).toBeNull();
  });
  it("returns null for negative intervals (clock skew → no honest data)", () => {
    expect(
      durationSec("2026-07-01T10:05:00Z", "2026-07-01T10:00:00Z"),
    ).toBeNull();
  });
});

// ── deriveWorkItemTimings ─────────────────────────────────────────────────────

describe("deriveWorkItemTimings — batched, honest stage timing", () => {
  const nodes: NodeTimingRow[] = [
    { id: "n1", nodeIdInDag: "develop" },
    { id: "n2", nodeIdInDag: "review1" },
    { id: "n3", nodeIdInDag: "qa" },
    { id: "n4", nodeIdInDag: "gateStack" },
  ];

  function spawn(
    overrides: Partial<SpawnTimingRow> = {},
  ): SpawnTimingRow {
    return {
      id: "sp1",
      nodeId: "n1",
      runId: "run1",
      status: "completed",
      tags: { source: "tracker", item_id: "wi_1" },
      startedAt: "2026-07-01T10:00:00Z",
      completedAt: "2026-07-01T10:10:00Z",
      ...overrides,
    };
  }

  it("derives timing from real spawn timestamps", () => {
    const spawns = [
      spawn(),
      spawn({
        id: "sp2",
        nodeId: "n2",
        startedAt: "2026-07-01T11:00:00Z",
        completedAt: "2026-07-01T11:05:00Z",
      }),
    ];
    const result = deriveWorkItemTimings(spawns, nodes, ["wi_1"]);
    expect(result).toHaveLength(1);
    const dev = result[0].stages.find((s) => s.stage === "dev")!;
    expect(dev.totalSec).toBeCloseTo(600, 0);
    expect(dev.spawnCount).toBe(1);
    const review = result[0].stages.find((s) => s.stage === "review")!;
    expect(review.totalSec).toBeCloseTo(300, 0);
  });

  it("reports 无数据 (null) for stages with no spawn data — never 0", () => {
    const result = deriveWorkItemTimings([], nodes, ["wi_1"]);
    for (const stage of result[0].stages) {
      expect(stage.totalSec).toBeNull();
      expect(stage.spawnCount).toBe(0);
    }
  });

  it("still-running spawn (no completedAt) → durationSec null, not counted", () => {
    const spawns = [spawn({ completedAt: null, status: "running" })];
    const result = deriveWorkItemTimings(spawns, nodes, ["wi_1"]);
    const dev = result[0].stages.find((s) => s.stage === "dev")!;
    expect(dev.totalSec).toBeNull();
    expect(dev.spawnCount).toBe(0);
    expect(dev.spawns).toHaveLength(1);
    expect(dev.spawns[0].durationSec).toBeNull();
  });

  it("groups spawns by work-item id in one pass (batched, no N+1)", () => {
    const spawns = [
      spawn({ tags: { item_id: "wi_1" } }),
      spawn({ id: "sp2", tags: { item_id: "wi_2" } }),
      spawn({ id: "sp3", tags: { item_id: "wi_1" }, nodeId: "n3" }),
    ];
    const result = deriveWorkItemTimings(spawns, nodes, ["wi_1", "wi_2"]);
    expect(result).toHaveLength(2);
    const wi1 = result.find((t) => t.workItemId === "wi_1")!;
    const wi2 = result.find((t) => t.workItemId === "wi_2")!;
    // wi_1 has 2 spawns (dev + qa), wi_2 has 1 (dev)
    expect(wi1.stages.find((s) => s.stage === "dev")!.spawnCount).toBe(1);
    expect(wi1.stages.find((s) => s.stage === "qa")!.spawnCount).toBe(1);
    expect(wi2.stages.find((s) => s.stage === "dev")!.spawnCount).toBe(1);
    expect(wi2.stages.find((s) => s.stage === "qa")!.spawnCount).toBe(0);
  });

  it("ignores spawns for items not in workItemIds", () => {
    const spawns = [spawn({ tags: { item_id: "wi_other" } })];
    const result = deriveWorkItemTimings(spawns, nodes, ["wi_1"]);
    expect(result[0].stages.every((s) => s.spawnCount === 0)).toBe(true);
  });

  it("uses itemMeta for itemKey/title when provided", () => {
    const meta = new Map([["wi_1", { itemKey: "M5-1", title: "Test" }]]);
    const result = deriveWorkItemTimings([], nodes, ["wi_1"], meta);
    expect(result[0].itemKey).toBe("M5-1");
    expect(result[0].title).toBe("Test");
  });
});

// ── formatDurationSec ─────────────────────────────────────────────────────────

describe("formatDurationSec", () => {
  it("renders null as 无数据", () => {
    expect(formatDurationSec(null)).toBe("无数据");
  });
  it("renders seconds", () => {
    expect(formatDurationSec(45)).toBe("45s");
  });
  it("renders minutes + seconds", () => {
    expect(formatDurationSec(200)).toBe("3m20s");
  });
  it("renders hours + minutes", () => {
    expect(formatDurationSec(3900)).toBe("1h05m");
  });
});
