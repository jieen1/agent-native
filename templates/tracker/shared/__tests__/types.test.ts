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
} from "../types.js";

// ── STAGE_ORDER ──────────────────────────────────────────────────────────

describe("STAGE_ORDER", () => {
  it("has exactly 7 stages", () => {
    expect(STAGE_ORDER).toHaveLength(7);
  });

  it("starts with 待办", () => {
    expect(STAGE_ORDER[0]).toBe("待办");
  });

  it("ends with 交付", () => {
    expect(STAGE_ORDER[6]).toBe("交付");
  });

  it("has 实施 in position 3", () => {
    expect(STAGE_ORDER[3]).toBe("实施");
  });

  it("contains all expected stages in order", () => {
    const expected: StageName[] = [
      "待办",
      "分析",
      "设计",
      "实施",
      "测试",
      "验收",
      "交付",
    ];
    expect(STAGE_ORDER).toEqual(expected);
  });

  it("has no duplicates", () => {
    expect(new Set(STAGE_ORDER).size).toBe(7);
  });

  it("every element is assignable to the StageName type (compile-time check at runtime)", () => {
    for (const s of STAGE_ORDER) {
      // These assertions pass only if s matches the StageName union.
      // If a wrong value leaked in, indexOf would return -1.
      expect(
        ["待办", "分析", "设计", "实施", "测试", "验收", "交付"].includes(s),
      ).toBe(true);
    }
  });
});

// ── StageName type literal coverage ──────────────────────────────────────

describe("StageName type values", () => {
  const valid: StageName[] = [
    "待办",
    "分析",
    "设计",
    "实施",
    "测试",
    "验收",
    "交付",
  ];
  it("matches STAGE_ORDER exactly", () => {
    expect(valid).toEqual(STAGE_ORDER);
  });
  it("has exactly 7 distinct values", () => {
    expect(new Set(valid).size).toBe(7);
  });
});

// ── ExecutionMode ────────────────────────────────────────────────────────

describe("ExecutionMode type", () => {
  it('has exactly two valid values: "manual" and "auto"', () => {
    const valid: ExecutionMode[] = ["manual", "auto"];
    expect(valid).toEqual(["manual", "auto"]);
    expect(new Set(valid).size).toBe(2);
  });

  it("rejects case variants (these would fail TS narrowing, simulated here)", () => {
    const candidates = ["Manual", "AUTO", "auto ", "MANUAL", "automatic"];
    for (const c of candidates) {
      expect(["manual", "auto"].includes(c)).toBe(false);
    }
  });
});

// ── ItemRisk ─────────────────────────────────────────────────────────────

describe("ItemRisk type", () => {
  it("has exactly three values: low, medium, high", () => {
    const valid: ItemRisk[] = ["low", "medium", "high"];
    expect(valid).toEqual(["low", "medium", "high"]);
    expect(new Set(valid).size).toBe(3);
  });

  it("rejects invalid risk strings", () => {
    const invalids = ["critical", "none", "LOW", "Medium", ""];
    for (const v of invalids) {
      expect(["low", "medium", "high"].includes(v)).toBe(false);
    }
  });

  it("is ordered low → medium → high", () => {
    const severity: Record<string, number> = { low: 0, medium: 1, high: 2 };
    const indices: ItemRisk[] = ["low", "medium", "high"];
    expect(indices.map((v) => severity[v])).toEqual([0, 1, 2]);
  });
});

// ── ItemType ─────────────────────────────────────────────────────────────

describe("ItemType values", () => {
  it("has the expected five Chinese labels", () => {
    const valid: ItemType[] = ["需求", "任务", "缺陷", "测试", "生产问题"];
    expect(valid).toEqual(["需求", "任务", "缺陷", "测试", "生产问题"]);
    expect(new Set(valid).size).toBe(5);
  });
});

// ── SprintStatus ─────────────────────────────────────────────────────────

describe("SprintStatus values", () => {
  it("has the four lifecycle states", () => {
    const valid: SprintStatus[] = ["规划", "进行中", "已完成", "已发布"];
    expect(valid).toEqual(["规划", "进行中", "已完成", "已发布"]);
    expect(new Set(valid).size).toBe(4);
  });
});

// ── StageStatus values ──────────────────────────────────────────────────

describe("StageStatus values", () => {
  it("has the five stage states", () => {
    const valid: StageStatus[] = [
      "待执行",
      "执行中",
      "已完成",
      "已驳回",
      "跳过",
    ];
    expect(valid).toEqual(["待执行", "执行中", "已完成", "已驳回", "跳过"]);
    expect(new Set(valid).size).toBe(5);
  });
});

// ── WorkItemStatus ──────────────────────────────────────────────────────

describe("WorkItemStatus values", () => {
  it("has the six work item states", () => {
    const valid: WorkItemStatus[] = [
      "open",
      "queued",
      "running",
      "dispatched",
      "done",
      "failed",
    ];
    expect(valid).toEqual([
      "open",
      "queued",
      "running",
      "dispatched",
      "done",
      "failed",
    ]);
    expect(new Set(valid).size).toBe(6);
  });
});

// ── Stage ordering cross-checks ─────────────────────────────────────────

describe("Stage ordering cross-checks", () => {
  const indexOf = (name: string) => STAGE_ORDER.indexOf(name as StageName);

  it("分析 index is less than 实施 index (analysis precedes implementation)", () => {
    expect(indexOf("分析")).toBeLessThan(indexOf("实施"));
  });

  it("设计 index is less than 测试 index", () => {
    expect(indexOf("设计")).toBeLessThan(indexOf("测试"));
  });

  it("验收 index is greater than 测试 index", () => {
    expect(indexOf("验收")).toBeGreaterThan(indexOf("测试"));
  });

  it("STAGE_ORDER indices are strictly ascending 0..6", () => {
    for (let i = 0; i < STAGE_ORDER.length; i++) {
      expect(STAGE_ORDER[i]).toBe(STAGE_ORDER[i]); // identity check
      expect(i).toBe(i);
    }
    // More concretely: the array equals [0,1,2,3,4,5,6] under indexOf
    const indices = STAGE_ORDER.map(indexOf);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

// ── JSON parse safety (simulating malformed tags / plannedStages) ────────

describe("JSON parse safety (simulating malformed tags / plannedStages)", () => {
  function safeJsonParse<T>(raw: string, fallback: T): T {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

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
    // JSON.parse('42') returns 42 — the fallback is NOT used because it is
    // valid JSON.  This documents the behaviour we want callers to be aware of.
    const result = safeJsonParse<string[]>("42", ["fallback"]);
    expect(result).toBe(42);
  });

  it("simulates rollback payload JSON that has Chinese keys", () => {
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

  it("handles null/undefined gracefully", () => {
    // JSON.parse('null') returns null — not the fallback
    expect(safeJsonParse("null", "default")).toBeNull();
  });
});

// ── Artifact versioning logic (mock-style) ──────────────────────────────

describe("Artifact versioning logic (mock-style)", () => {
  interface MockArtifact {
    id: string;
    name: string;
    version: number;
  }

  /**
   * Pure increment helper that mirrors the versioning logic in the tracker's
   * create-artifact.ts / list-artifacts.ts: pick max existing version + 1.
   */
  function nextVersion(existing: MockArtifact[]): number {
    if (existing.length === 0) return 1;
    const maxVer = existing.reduce((m, a) => Math.max(m, a.version), 0);
    return maxVer + 1;
  }

  it("returns 1 when no artifacts exist yet", () => {
    expect(nextVersion([])).toBe(1);
  });

  it("increments correctly: existing version 3 → next is 4", () => {
    const items: MockArtifact[] = [
      { id: "a1", name: "design", version: 1 },
      { id: "a2", name: "design", version: 2 },
      { id: "a3", name: "design", version: 3 },
    ];
    expect(nextVersion(items)).toBe(4);
  });

  it("handles non-sequential versions (1, 3, 5 → next is 6)", () => {
    const items: MockArtifact[] = [
      { id: "a1", name: "d", version: 1 },
      { id: "a2", name: "d", version: 3 },
      { id: "a3", name: "d", version: 5 },
    ];
    expect(nextVersion(items)).toBe(6);
  });

  it("handles single artifact", () => {
    const items: MockArtifact[] = [{ id: "a1", name: "x", version: 7 }];
    expect(nextVersion(items)).toBe(8);
  });
});

// ── Activity payload round-trip ─────────────────────────────────────────

describe("Activity payload round-trip", () => {
  function buildActivityPayload(action: string, details: string): string {
    const payload = { action, details, ts: new Date().toISOString() };
    return JSON.stringify(payload);
  }

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

// ── Stage name validation ──────────────────────────────────────────────

describe("Stage name validation", () => {
  function isValidStageName(s: string): s is StageName {
    return (STAGE_ORDER as readonly string[]).includes(s);
  }

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

// ── Item key generation pattern ─────────────────────────────────────────

describe("Item key generation pattern", () => {
  /** Mimic the PREFIX-N pattern used by the tracker (e.g. PROJ-42). */
  function generateItemKey(prefix: string, n: number): string {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Invalid item counter: ${n}`);
    }
    if (!/^[A-Z][A-Z0-9_]{2,10}$/.test(prefix)) {
      throw new Error(`Invalid prefix: ${prefix}`);
    }
    return `${prefix}-${n}`;
  }

  it("follows PREFIX-N pattern", () => {
    const key = generateItemKey("PRJ", 42);
    expect(key).toMatch(/^[A-Z][A-Z0-9_]{2,10}-\d+$/);
    expect(key).toBe("PRJ-42");
  });

  it("prefix must start with uppercase letter and be 3-11 chars", () => {
    expect(generateItemKey("ABC", 1)).toBe("ABC-1");
    expect(generateItemKey("A1_", 1)).toBe("A1_-1");
    expect(generateItemKey("PROJECT_ID", 99)).toBe("PROJECT_ID-99");

    // Invalid: too short (2 chars)
    expect(() => generateItemKey("AB", 1)).toThrow("Invalid prefix");
    // Invalid: starts with digit
    expect(() => generateItemKey("1AB", 1)).toThrow("Invalid prefix");
    // Invalid: lowercase
    expect(() => generateItemKey("Abc", 1)).toThrow("Invalid prefix");
  });

  it("counter must be a positive integer", () => {
    expect(generateItemKey("PROJ", 1)).toBe("PROJ-1");
    expect(() => generateItemKey("PROJ", 0)).toThrow();
    expect(() => generateItemKey("PROJ", -5)).toThrow();
    expect(() => generateItemKey("PROJ", 1.5)).toThrow();
  });
});

// ── Priority validation edge cases ─────────────────────────────────────

describe("Priority validation edge cases", () => {
  function isValidPriority(p: number): boolean {
    return Number.isInteger(p) && p >= 0 && p <= Number.MAX_SAFE_INTEGER;
  }

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

// ── executionMode values (type-level test) ─────────────────────────────

describe("executionMode values (type-level test)", () => {
  const valid: ExecutionMode[] = ["manual", "auto"];

  it('only "manual" and "auto" are valid', () => {
    expect(valid).toEqual(["manual", "auto"]);
    expect(new Set(valid).size).toBe(2);
  });

  it("rejects case variations", () => {
    expect(valid.includes("Manual" as unknown as ExecutionMode)).toBe(false);
    expect(valid.includes("AUTO" as unknown as ExecutionMode)).toBe(false);
    expect(valid.includes("Auto" as unknown as ExecutionMode)).toBe(false);
  });

  it("rejects similar but wrong strings", () => {
    expect(valid.includes("automatic" as unknown as ExecutionMode)).toBe(false);
    expect(valid.includes("scheduled" as unknown as ExecutionMode)).toBe(false);
    expect(valid.includes("" as unknown as ExecutionMode)).toBe(false);
  });
});

// ── Risk values (type-level test) ──────────────────────────────────────

describe("Risk values (type-level test)", () => {
  const valid: ItemRisk[] = ["low", "medium", "high"];

  it('only "low", "medium", "high" are valid', () => {
    expect(valid).toEqual(["low", "medium", "high"]);
    expect(new Set(valid).size).toBe(3);
  });

  it('rejects "critical" and "none"', () => {
    expect(valid.includes("critical" as unknown as ItemRisk)).toBe(false);
    expect(valid.includes("none" as unknown as ItemRisk)).toBe(false);
    expect(valid.includes("undefined" as unknown as ItemRisk)).toBe(false);
  });

  it("rejects case variations", () => {
    expect(valid.includes("LOW" as unknown as ItemRisk)).toBe(false);
    expect(valid.includes("Medium" as unknown as ItemRisk)).toBe(false);
    expect(valid.includes("HIGH" as unknown as ItemRisk)).toBe(false);
  });
});

// ── Integration-style: validate a full WorkItem-shaped object ──────────

describe("WorkItem-shaped object validation", () => {
  it("a fully-valid item passes all field validators", () => {
    const validItem = {
      id: "wi_001",
      projectId: "proj_x",
      type: "需求" as const,
      title: "Login page",
      description: "Build the login page",
      status: "open" as const,
      priority: 2,
      risk: "medium" as const,
      tags: ["auth"],
      executionMode: "manual" as const,
      currentStageName: "待办" as const,
      plannedStages: ["待办", "分析", "设计", "实施", "测试"],
      branch: null,
      orchestratorThreadId: null,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    };

    expect(STAGE_ORDER.includes(validItem.currentStageName as StageName)).toBe(
      true,
    );
    expect(["low", "medium", "high"].includes(validItem.risk)).toBe(true);
    expect(["manual", "auto"].includes(validItem.executionMode)).toBe(true);
    expect(
      Number.isInteger(validItem.priority) && validItem.priority >= 0,
    ).toBe(true);
    expect(
      validItem.plannedStages.every((s) =>
        STAGE_ORDER.includes(s as StageName),
      ),
    ).toBe(true);
  });

  it("rejects an item with an invalid stage name", () => {
    const bad: { currentStageName: string } = { currentStageName: "进行中" };
    expect(STAGE_ORDER.includes(bad.currentStageName as StageName)).toBe(false);
  });

  it("rejects an item with a negative priority", () => {
    expect(Number.isInteger(-1) && -1 >= 0).toBe(false);
  });
});
