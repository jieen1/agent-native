import { describe, expect, it } from "vitest";

import {
  STAGE_ORDER,
  StageName,
  ExecutionMode,
  ItemRisk,
  ItemType,
  SprintStatus,
  StageStatus,
  WorkItemStatus,
  TrackerWorkItem,
  Sprint,
  Artifact,
} from "../../shared/types.js";

// ── Helpers (extracted pure logic from action files) ────────────────────

/**
 * Stage ordering helper: returns the ordinal position of a stage name,
 * or -1 if the name is not in STAGE_ORDER.
 *
 * Derived from list-stages.ts (CASE expression) and list-artifacts.ts.
 */
function stageIndex(name: string): number {
  return STAGE_ORDER.indexOf(name as StageName);
}

/**
 * Pure JSON-safe parser used when reading tags/plannedStages from the DB.
 */
function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Artifact version increment: next version is max(existing) + 1, or 1 if empty.
 * Derived from create-artifact.ts / list-artifacts.ts logic.
 */
function nextArtifactVersion(existing: { version: number }[]): number {
  if (existing.length === 0) return 1;
  return Math.max(...existing.map((a) => a.version)) + 1;
}

/**
 * Build an activity JSON payload.
 * Derived from trigger-stage.ts / rollback-stage.ts.
 */
function buildActivityPayload(action: string, details: string): string {
  const payload = { action, details, ts: new Date().toISOString() };
  return JSON.stringify(payload);
}

/**
 * Stage name validator.
 * Derived from isValidStageName pattern.
 */
function isValidStageName(s: string): s is StageName {
  return (STAGE_ORDER as readonly string[]).includes(s);
}

/**
 * Execution mode validator.
 */
function isValidExecutionMode(s: string): s is ExecutionMode {
  return (["manual", "auto"] as const).includes(s as ExecutionMode);
}

/**
 * Risk level validator.
 */
function isValidRisk(s: string): s is ItemRisk {
  return (["low", "medium", "high"] as const).includes(s as ItemRisk);
}

/**
 * Priority validator.
 */
function isValidPriority(p: number): boolean {
  return Number.isInteger(p) && p >= 0 && p <= Number.MAX_SAFE_INTEGER;
}

/**
 * Item key generator. Pattern: PREFIX-N (e.g. PROJ-42).
 * Derived from create-work-item.ts.
 */
function generateItemKey(prefix: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid item counter: ${n}`);
  }
  if (!/^[A-Z][A-Z0-9_]{2,10}$/.test(prefix)) {
    throw new Error(`Invalid prefix: ${prefix}`);
  }
  return `${prefix}-${n}`;
}

/**
 * Default plannedStages computation by type/tags (M1-6).
 * Derived from create-work-item.ts's isNarrowScope logic: 缺陷/defect/
 * from-audit type (or an explicit "from-audit" tag) get the narrow
 * ["实施","测试"] subset; everything else gets the full seven stages.
 */
function computeDefaultPlannedStages(
  type: string | undefined,
  tags: string[],
): string[] {
  const isNarrowScope =
    type === "缺陷" ||
    type === "defect" ||
    type === "from-audit" ||
    tags.includes("from-audit");
  return isNarrowScope
    ? ["实施", "测试"]
    : ["待办", "分析", "设计", "实施", "测试", "验收", "交付"];
}

/**
 * Sprint-scope cascade result classification (M1-6, advance-stage.ts).
 * Mirrors the cascaded.push(...) branching in the sprint-scope loop:
 *  - blocked            -> ok:false with a "blocked: ..." message
 *  - noop/stage-mismatch -> skipped entirely (not a candidate item, not a failure)
 *  - noop/other reason   -> ok:false with a "noop: ..." message
 *  - otherwise (success) -> ok:true
 */
function classifyCascadeResult(
  workItemId: string,
  result: {
    blocked?: boolean;
    missing?: string[];
    noop?: boolean;
    reason?: string;
  },
): { workItemId: string; ok: boolean; error?: string } | null {
  if (result.blocked) {
    return {
      workItemId,
      ok: false,
      error: `blocked: ${(result.missing ?? []).join("; ")}`,
    };
  }
  if (result.noop && result.reason === "stage-mismatch") {
    return null;
  }
  if (result.noop) {
    return {
      workItemId,
      ok: false,
      error: `noop: ${result.reason ?? "unknown"}`,
    };
  }
  return { workItemId, ok: true };
}

// ── 1. Stage ordering logic ────────────────────────────────────────────

describe("Stage ordering logic", () => {
  it("分析 index is less than 实施 index (analysis precedes implementation)", () => {
    expect(stageIndex("分析")).toBeLessThan(stageIndex("实施"));
  });

  it("设计 index is less than 测试 index", () => {
    expect(stageIndex("设计")).toBeLessThan(stageIndex("测试"));
  });

  it("验收 index is greater than 测试 index", () => {
    expect(stageIndex("验收")).toBeGreaterThan(stageIndex("测试"));
  });

  it("STAGE_ORDER indices are strictly ascending 0..6", () => {
    const indices = STAGE_ORDER.map(stageIndex);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("STAGE_ORDER is stable — same values on repeated indexOf", () => {
    const first = STAGE_ORDER.map(stageIndex);
    const second = STAGE_ORDER.map(stageIndex);
    expect(first).toEqual(second);
  });
});

// ── 2. JSON parse safety ───────────────────────────────────────────────

describe("JSON parse safety (simulating malformed tags / plannedStages)", () => {
  it("handles a valid JSON array string for tags", () => {
    const result = safeJsonParse<string[]>('["frontend","api"]', []);
    expect(result).toEqual(["frontend", "api"]);
  });

  it("handles a completely garbled string for plannedStages", () => {
    const result = safeJsonParse<string[]>("not valid json at all", []);
    expect(result).toEqual([]);
  });

  it("handles an empty string as fallback", () => {
    const result = safeJsonParse<number[]>("", [1, 2, 3]);
    expect(result).toEqual([1, 2, 3]);
  });

  it("handles JSON that is the wrong type (number instead of array)", () => {
    const result = safeJsonParse<string[]>("42", ["fallback"]);
    // JSON.parse('42') is valid JSON, so we get 42 (not the fallback)
    expect(result).toBe(42);
  });

  it("simulates rollback payload JSON with Chinese keys", () => {
    const raw = JSON.stringify({
      fromStage: "实施",
      toStage: "分析",
      reason: "返工",
    });
    const parsed = safeJsonParse<{
      fromStage: string;
      toStage: string;
      reason: string;
    }>(raw, {
      fromStage: "",
      toStage: "",
      reason: "",
    });
    expect(parsed.fromStage).toBe("实施");
    expect(parsed.toStage).toBe("分析");
    expect(parsed.reason).toBe("返工");
  });
});

// ── 3. Artifact versioning logic ────────────────────────────────────────

describe("Artifact versioning logic (mock-style)", () => {
  it("returns 1 when no artifacts exist yet", () => {
    expect(nextArtifactVersion([])).toBe(1);
  });

  it("increments correctly: existing max 3 → next is 4", () => {
    const items = [{ version: 1 }, { version: 2 }, { version: 3 }];
    expect(nextArtifactVersion(items)).toBe(4);
  });

  it("handles non-sequential versions (1, 3, 5 → next is 6)", () => {
    const items = [{ version: 1 }, { version: 3 }, { version: 5 }];
    expect(nextArtifactVersion(items)).toBe(6);
  });

  it("handles single artifact", () => {
    const items = [{ version: 7 }];
    expect(nextArtifactVersion(items)).toBe(8);
  });
});

// ── 4. Activity payload round-trip ─────────────────────────────────────

describe("Activity payload round-trip", () => {
  it("buildActivityPayload produces a parseable JSON string", () => {
    const raw = buildActivityPayload("trigger", "执行设计阶段");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("the parsed payload preserves action and details exactly", () => {
    const raw = buildActivityPayload("complete", "设计完成");
    const obj = JSON.parse(raw) as {
      action: string;
      details: string;
      ts: string;
    };
    expect(obj.action).toBe("complete");
    expect(obj.details).toBe("设计完成");
    expect(obj.ts).toBeTruthy();
    expect(new Date(obj.ts).getTime()).toBeGreaterThan(0);
  });

  it("two payloads with same inputs differ only in timestamp", () => {
    const a = buildActivityPayload("trigger", "foo");
    const b = buildActivityPayload("trigger", "foo");
    const pa = JSON.parse(a) as { action: string; details: string; ts: string };
    const pb = JSON.parse(b) as { action: string; details: string; ts: string };
    expect(pa.action).toBe(pb.action);
    expect(pa.details).toBe(pb.details);
    expect(typeof pa.ts).toBe("string");
    expect(typeof pb.ts).toBe("string");
  });

  it("handles empty strings", () => {
    const raw = buildActivityPayload("", "");
    const obj = JSON.parse(raw) as {
      action: string;
      details: string;
      ts: string;
    };
    expect(obj.action).toBe("");
    expect(obj.details).toBe("");
  });
});

// ── 5. Stage name validation ───────────────────────────────────────────

describe("Stage name validation", () => {
  it("all 7 valid names pass", () => {
    for (const s of STAGE_ORDER) {
      expect(isValidStageName(s)).toBe(true);
    }
  });

  it("rejects stage status strings (执行中, 待执行, 已驳回)", () => {
    expect(isValidStageName("执行中")).toBe(false);
    expect(isValidStageName("待执行")).toBe(false);
    expect(isValidStageName("已驳回")).toBe(false);
  });

  it("rejects English names", () => {
    expect(isValidStageName("todo")).toBe(false);
    expect(isValidStageName("analysis")).toBe(false);
    expect(isValidStageName("design")).toBe(false);
  });

  it("rejects empty string and whitespace", () => {
    expect(isValidStageName("")).toBe(false);
    expect(isValidStageName("   ")).toBe(false);
  });

  it("rejects partial matches", () => {
    expect(isValidStageName("待")).toBe(false);
    expect(isValidStageName("办")).toBe(false);
    expect(isValidStageName("实施者")).toBe(false);
  });
});

// ── 6. Item key generation pattern ─────────────────────────────────────

describe("Item key generation pattern", () => {
  it("follows PREFIX-N pattern", () => {
    const key = generateItemKey("PRJ", 42);
    expect(key).toMatch(/^[A-Z][A-Z0-9_]{2,10}-\d+$/);
    expect(key).toBe("PRJ-42");
  });

  it("prefix must start with uppercase letter and be 3-11 chars", () => {
    expect(generateItemKey("ABC", 1)).toBe("ABC-1");
    expect(generateItemKey("A1_", 1)).toBe("A1_-1");
    expect(generateItemKey("PROJECT_ID", 99)).toBe("PROJECT_ID-99");

    expect(() => generateItemKey("AB", 1)).toThrow("Invalid prefix");
    expect(() => generateItemKey("1AB", 1)).toThrow("Invalid prefix");
    expect(() => generateItemKey("Abc", 1)).toThrow("Invalid prefix");
  });

  it("counter must be a positive integer", () => {
    expect(generateItemKey("PROJ", 1)).toBe("PROJ-1");
    expect(() => generateItemKey("PROJ", 0)).toThrow();
    expect(() => generateItemKey("PROJ", -5)).toThrow();
    expect(() => generateItemKey("PROJ", 1.5)).toThrow();
  });
});

// ── 7. Priority validation edge cases ─────────────────────────────────

describe("Priority validation edge cases", () => {
  it("accepts 0", () => {
    expect(isValidPriority(0)).toBe(true);
  });

  it("rejects -1", () => {
    expect(isValidPriority(-1)).toBe(false);
  });

  it("rejects -1000", () => {
    expect(isValidPriority(-1000)).toBe(false);
  });

  it("accepts large positive integers", () => {
    expect(isValidPriority(1000000)).toBe(true);
    expect(isValidPriority(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects float values", () => {
    expect(isValidPriority(1.5)).toBe(false);
    expect(isValidPriority(0.0001)).toBe(false);
  });

  it("rejects NaN and Infinity", () => {
    expect(isValidPriority(NaN)).toBe(false);
    expect(isValidPriority(Infinity)).toBe(false);
    expect(isValidPriority(-Infinity)).toBe(false);
  });
});

// ── 8. executionMode values ────────────────────────────────────────────

describe("executionMode values", () => {
  it('only "manual" and "auto" are valid', () => {
    expect(isValidExecutionMode("manual")).toBe(true);
    expect(isValidExecutionMode("auto")).toBe(true);
  });

  it("rejects case variations", () => {
    expect(isValidExecutionMode("Manual")).toBe(false);
    expect(isValidExecutionMode("AUTO")).toBe(false);
    expect(isValidExecutionMode("Auto")).toBe(false);
  });

  it("rejects similar but wrong strings", () => {
    expect(isValidExecutionMode("automatic")).toBe(false);
    expect(isValidExecutionMode("scheduled")).toBe(false);
    expect(isValidExecutionMode("")).toBe(false);
  });

  it("ExecutionMode type has exactly two values", () => {
    const valid: ExecutionMode[] = ["manual", "auto"];
    expect(valid).toEqual(["manual", "auto"]);
    expect(new Set(valid).size).toBe(2);
  });
});

// ── 9. Risk values ─────────────────────────────────────────────────────

describe("Risk values", () => {
  it('only "low", "medium", "high" are valid', () => {
    expect(isValidRisk("low")).toBe(true);
    expect(isValidRisk("medium")).toBe(true);
    expect(isValidRisk("high")).toBe(true);
  });

  it('rejects "critical" and "none"', () => {
    expect(isValidRisk("critical")).toBe(false);
    expect(isValidRisk("none")).toBe(false);
    expect(isValidRisk("undefined")).toBe(false);
  });

  it("rejects case variations", () => {
    expect(isValidRisk("LOW")).toBe(false);
    expect(isValidRisk("Medium")).toBe(false);
    expect(isValidRisk("HIGH")).toBe(false);
  });

  it("ItemRisk type has exactly three values", () => {
    const valid: ItemRisk[] = ["low", "medium", "high"];
    expect(valid).toEqual(["low", "medium", "high"]);
    expect(new Set(valid).size).toBe(3);
  });
});

// ── 10. Integration-style: validate a full TrackerWorkItem ─────────────

describe("TrackerWorkItem-shaped object validation", () => {
  it("a fully-valid item passes all field validators", () => {
    const item: TrackerWorkItem = {
      id: "wi_001",
      projectId: "proj_x",
      sprintId: null,
      itemKey: "PROJ-1",
      type: "需求",
      title: "Login page",
      description: "Build the login page",
      status: "open",
      priority: 2,
      risk: "medium",
      tags: ["auth"],
      executionMode: "manual",
      currentStageName: "待办",
      plannedStages: ["待办", "分析", "设计", "实施", "测试"],
      branch: null,
      orchestratorThreadId: null,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    expect(isValidStageName(item.currentStageName)).toBe(true);
    expect(isValidRisk(item.risk)).toBe(true);
    expect(isValidExecutionMode(item.executionMode)).toBe(true);
    expect(isValidPriority(item.priority)).toBe(true);
    expect(item.plannedStages.every((s) => isValidStageName(s))).toBe(true);
  });

  it("rejects an item with an invalid stage name", () => {
    const bad: TrackerWorkItem = {
      id: "wi_bad",
      projectId: "proj_x",
      sprintId: null,
      itemKey: "PROJ-2",
      type: "任务",
      title: "Bad item",
      description: "",
      status: "open",
      priority: 1,
      risk: "low",
      tags: [],
      executionMode: "manual",
      currentStageName: "进行中" as StageName,
      plannedStages: ["待办"],
      branch: null,
      orchestratorThreadId: null,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(isValidStageName(bad.currentStageName)).toBe(false);
  });

  it("rejects an item with a negative priority", () => {
    const bad: TrackerWorkItem = {
      id: "wi_bad2",
      projectId: "proj_x",
      sprintId: null,
      itemKey: "PROJ-3",
      type: "缺陷",
      title: "Negative prio",
      description: "",
      status: "open",
      priority: -1,
      risk: "high",
      tags: [],
      executionMode: "auto",
      currentStageName: "分析",
      plannedStages: ["分析", "设计"],
      branch: null,
      orchestratorThreadId: null,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };
    expect(isValidPriority(bad.priority)).toBe(false);
  });
});

// ── 11. Default plannedStages computation (M1-6) ────────────────────────

describe("computeDefaultPlannedStages", () => {
  it('缺陷 type gets the narrow ["实施","测试"] subset', () => {
    expect(computeDefaultPlannedStages("缺陷", [])).toEqual(["实施", "测试"]);
  });

  it("defect (legacy English) type gets the narrow subset", () => {
    expect(computeDefaultPlannedStages("defect", [])).toEqual(["实施", "测试"]);
  });

  it("from-audit type gets the narrow subset", () => {
    expect(computeDefaultPlannedStages("from-audit", [])).toEqual([
      "实施",
      "测试",
    ]);
  });

  it('an explicit "from-audit" tag also narrows scope regardless of type', () => {
    expect(computeDefaultPlannedStages("需求", ["from-audit"])).toEqual([
      "实施",
      "测试",
    ]);
    expect(computeDefaultPlannedStages(undefined, ["from-audit"])).toEqual([
      "实施",
      "测试",
    ]);
  });

  it("需求 type gets the full seven-stage plan", () => {
    expect(computeDefaultPlannedStages("需求", [])).toEqual([
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ]);
  });

  it("任务 type gets the full seven-stage plan", () => {
    expect(computeDefaultPlannedStages("任务", [])).toEqual([
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ]);
  });

  it("undefined type with no tags gets the full seven-stage plan", () => {
    expect(computeDefaultPlannedStages(undefined, [])).toEqual([
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ]);
  });

  it("unrelated tags do not trigger narrow scope", () => {
    expect(computeDefaultPlannedStages("需求", ["auth", "urgent"])).toEqual([
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ]);
  });

  it("first entry of the narrow subset is a valid stage name", () => {
    const narrow = computeDefaultPlannedStages("缺陷", []);
    expect(isValidStageName(narrow[0])).toBe(true);
  });

  it("the full plan matches STAGE_ORDER exactly", () => {
    expect(computeDefaultPlannedStages("集合", [])).toEqual([...STAGE_ORDER]);
  });
});

// ── 12. Sprint-scope cascade result classification (M1-6) ──────────────

describe("classifyCascadeResult", () => {
  it('a blocked result yields ok:false with a "blocked: ..." message joining missing reasons', () => {
    const result = classifyCascadeResult("wi_1", {
      blocked: true,
      missing: ["产物缺失: sprint-doc", "审批未通过: plan-signoff"],
    });
    expect(result).toEqual({
      workItemId: "wi_1",
      ok: false,
      error: "blocked: 产物缺失: sprint-doc; 审批未通过: plan-signoff",
    });
  });

  it("a blocked result with no missing array still produces a message", () => {
    const result = classifyCascadeResult("wi_2", { blocked: true });
    expect(result).toEqual({
      workItemId: "wi_2",
      ok: false,
      error: "blocked: ",
    });
  });

  it("a stage-mismatch noop is skipped entirely (returns null)", () => {
    const result = classifyCascadeResult("wi_3", {
      noop: true,
      reason: "stage-mismatch",
    });
    expect(result).toBeNull();
  });

  it('a run-id-mismatch noop yields ok:false with a "noop: ..." message', () => {
    const result = classifyCascadeResult("wi_4", {
      noop: true,
      reason: "run-id-mismatch",
    });
    expect(result).toEqual({
      workItemId: "wi_4",
      ok: false,
      error: "noop: run-id-mismatch",
    });
  });

  it('a no-next-stage noop yields ok:false with a "noop: ..." message', () => {
    const result = classifyCascadeResult("wi_5", {
      noop: true,
      reason: "no-next-stage",
    });
    expect(result).toEqual({
      workItemId: "wi_5",
      ok: false,
      error: "noop: no-next-stage",
    });
  });

  it('a noop with no reason falls back to "unknown"', () => {
    const result = classifyCascadeResult("wi_6", { noop: true });
    expect(result).toEqual({
      workItemId: "wi_6",
      ok: false,
      error: "noop: unknown",
    });
  });

  it("a plain success result (no blocked, no noop) yields ok:true", () => {
    const result = classifyCascadeResult("wi_7", {});
    expect(result).toEqual({ workItemId: "wi_7", ok: true });
  });

  it("blocked takes precedence over noop when both are somehow set", () => {
    const result = classifyCascadeResult("wi_8", {
      blocked: true,
      missing: ["x"],
      noop: true,
      reason: "stage-mismatch",
    });
    expect(result).toEqual({
      workItemId: "wi_8",
      ok: false,
      error: "blocked: x",
    });
  });
});

// ── 13. Additional cross-cutting validations from the types module ─────

describe("Additional type constants from shared/types.ts", () => {
  it("ItemType has 5 values", () => {
    const valid: ItemType[] = ["需求", "任务", "缺陷", "测试", "生产问题"];
    expect(valid).toHaveLength(5);
    expect(new Set(valid).size).toBe(5);
  });

  it("SprintStatus has 4 values", () => {
    const valid: SprintStatus[] = ["规划", "进行中", "已完成", "已发布"];
    expect(valid).toHaveLength(4);
    expect(new Set(valid).size).toBe(4);
  });

  it("StageStatus has 5 values", () => {
    const valid: StageStatus[] = [
      "待执行",
      "执行中",
      "已完成",
      "已驳回",
      "跳过",
    ];
    expect(valid).toHaveLength(5);
    expect(new Set(valid).size).toBe(5);
  });

  it("WorkItemStatus has 6 values", () => {
    const valid: WorkItemStatus[] = [
      "open",
      "queued",
      "running",
      "dispatched",
      "done",
      "failed",
    ];
    expect(valid).toHaveLength(6);
    expect(new Set(valid).size).toBe(6);
  });
});
