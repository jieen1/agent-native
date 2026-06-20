// P3a status-scheme validator matrix (DESIGN §6.2a / §6.2b). Pure unit tests of
// `evaluateTransition` — no DB. Covers, per the IMPLEMENTATION P3 acceptance
// list: forward skip-forward, illegal backward rejection, completed/cancelled
// resolution enforcement, reopen clearing resolution, cancel defaulting, the
// duplicate-link gate, and statusCategory derivation across all four default
// types (+ docs).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCHEMES,
  defaultSchemeSet,
  evaluateTransition,
  initialStage,
  stageIndex,
  categoryOf,
  type StatusScheme,
} from "../status-schemes.js";

const REQ = DEFAULT_SCHEMES.requirement;
const BUG = DEFAULT_SCHEMES.bug;
const PROD = DEFAULT_SCHEMES["prod-issue"];
const TASK = DEFAULT_SCHEMES.task;
const DOCS = DEFAULT_SCHEMES.docs;

describe("scheme shape", () => {
  it("all four default types + docs exist", () => {
    expect(Object.keys(DEFAULT_SCHEMES).sort()).toEqual(
      ["bug", "docs", "prod-issue", "requirement", "task"].sort(),
    );
  });

  it("defaultSchemeSet is a deep clone (mutating it never touches the constant)", () => {
    const set = defaultSchemeSet();
    set.bug.stages[0].key = "MUTATED";
    expect(DEFAULT_SCHEMES.bug.stages[0].key).not.toBe("MUTATED");
  });

  it("every type has the four categories represented", () => {
    for (const s of [REQ, BUG, PROD, TASK, DOCS]) {
      const cats = new Set(s.stages.map((st) => st.category));
      expect(cats.has("todo")).toBe(true);
      expect(cats.has("in-progress")).toBe(true);
      expect(cats.has("completed")).toBe(true);
      expect(cats.has("cancelled")).toBe(true);
    }
  });

  it("initialStage is the first todo stage", () => {
    expect(initialStage(REQ)).toBe("待分析");
    expect(initialStage(BUG)).toBe("待确认");
    expect(initialStage(PROD)).toBe("已触发");
    expect(initialStage(TASK)).toBe("待办");
    expect(initialStage(DOCS)).toBe("待写作");
  });

  it("docs scheme has no test/release stages (non-code projects)", () => {
    const keys = DOCS.stages.map((s) => s.key);
    expect(keys).toEqual(["待写作", "撰写中", "评审中", "定稿", "已取消"]);
    expect(keys).not.toContain("测试中");
    expect(keys).not.toContain("待发布");
  });
});

describe("forward (skip-forward allowed)", () => {
  it("requirement 开发中 → 待发布 in one call is legal (skip-forward)", () => {
    const r = evaluateTransition(REQ, "开发中", "待发布");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("forward");
      expect(r.statusCategory).toBe("in-progress");
      expect(r.resolution).toBeNull();
    }
  });

  it("bug 待确认 → 测试中 is legal forward", () => {
    const r = evaluateTransition(BUG, "待确认", "测试中");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.kind).toBe("forward");
  });

  it("forward index is strictly increasing (待发布 is after 开发中)", () => {
    expect(stageIndex(REQ, "待发布")).toBeGreaterThan(
      stageIndex(REQ, "开发中"),
    );
  });
});

describe("illegal transitions are rejected", () => {
  it("an unlisted backward move (待发布 → 开发中) is rejected", () => {
    const r = evaluateTransition(REQ, "待发布", "开发中");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/illegal transition/);
  });

  it("a move into a cancelled stage is classified 'cancel', never plain 'forward'", () => {
    // 已取消 is reachable from 开发中 via the listed cancel edge (NOT as a plain
    // forward — isForward excludes cancelled targets). cancel auto-defaults the
    // resolution to 'cancelled', so this succeeds but as kind 'cancel'.
    const r = evaluateTransition(REQ, "开发中", "已取消");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("cancel");
      expect(r.resolution).toBe("cancelled");
    }
  });

  it("entering a cancelled stage NOT listed as a cancel edge is rejected", () => {
    // 已拒绝 is reachable only from review stages (待评审/评审中), not from 待发布.
    const r = evaluateTransition(REQ, "待发布", "已拒绝", {
      resolution: "rejected",
    });
    expect(r.ok).toBe(false);
  });

  it("unknown target stage is rejected", () => {
    const r = evaluateTransition(REQ, "开发中", "no-such-stage");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown target/);
  });

  it("no-op (from == to) is rejected", () => {
    const r = evaluateTransition(REQ, "开发中", "开发中");
    expect(r.ok).toBe(false);
  });
});

describe("entering completed/cancelled requires a valid resolution", () => {
  it("已上线 without a resolution is rejected", () => {
    const r = evaluateTransition(REQ, "待发布", "已上线");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/requires a resolution/);
  });

  it("已上线 with shipped is accepted, category completed", () => {
    const r = evaluateTransition(REQ, "待发布", "已上线", {
      resolution: "shipped",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.statusCategory).toBe("completed");
      expect(r.resolution).toBe("shipped");
    }
  });

  it("已上线 with a resolution NOT in resolutionsAt (rejected) is rejected", () => {
    const r = evaluateTransition(REQ, "待发布", "已上线", {
      resolution: "rejected",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid at/);
  });

  it("bug 已关闭 accepts rolled-back (prod-issue-style closure set)", () => {
    const r = evaluateTransition(BUG, "待发布", "已关闭", {
      resolution: "rolled-back",
    });
    expect(r.ok).toBe(true);
  });

  it("prod-issue 已关闭 accepts shipped and rolled-back only", () => {
    expect(
      evaluateTransition(PROD, "待发布", "已关闭", { resolution: "shipped" })
        .ok,
    ).toBe(true);
    expect(
      evaluateTransition(PROD, "待发布", "已关闭", {
        resolution: "rolled-back",
      }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(PROD, "待发布", "已关闭", {
        resolution: "cannot-reproduce",
      }).ok,
    ).toBe(false);
  });
});

describe("cancel defaults resolution=cancelled", () => {
  it("requirement 开发中 → 已取消 with no resolution defaults to cancelled", () => {
    const r = evaluateTransition(REQ, "开发中", "已取消");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("cancel");
      expect(r.statusCategory).toBe("cancelled");
      expect(r.resolution).toBe("cancelled");
    }
  });

  it("cancel can also carry deferred (soft-cancel)", () => {
    const r = evaluateTransition(REQ, "开发中", "已取消", {
      resolution: "deferred",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolution).toBe("deferred");
  });
});

describe("reopen clears resolution and must hit the re-entry stage", () => {
  it("requirement 已上线 → 待开发 (reopen) clears resolution", () => {
    const r = evaluateTransition(REQ, "已上线", "待开发", {
      resolution: "shipped",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("reopen");
      expect(r.resolution).toBeNull();
      expect(r.statusCategory).toBe("todo");
    }
  });

  it("bug reopens to 待修复, task to 待办, prod-issue to 复盘中", () => {
    expect(
      evaluateTransition(BUG, "已关闭", "待修复", { resolution: "shipped" }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(TASK, "已完成", "待办", { resolution: "shipped" }).ok,
    ).toBe(true);
    expect(
      evaluateTransition(PROD, "已关闭", "复盘中", { resolution: "shipped" })
        .ok,
    ).toBe(true);
  });

  it("reopen to a NON-reentry stage is rejected", () => {
    // 已上线 → 开发中 is neither a forward nor a listed reopen edge.
    const r = evaluateTransition(REQ, "已上线", "开发中", {
      resolution: "shipped",
    });
    expect(r.ok).toBe(false);
  });
});

describe("duplicate resolution requires a duplicate-of link", () => {
  it("bug 不予处理 with duplicate but NO link is rejected", () => {
    const r = evaluateTransition(BUG, "待确认", "不予处理", {
      resolution: "duplicate",
      hasDuplicateLink: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicate-of/);
  });

  it("bug 不予处理 with duplicate AND a link is accepted", () => {
    const r = evaluateTransition(BUG, "待确认", "不予处理", {
      resolution: "duplicate",
      hasDuplicateLink: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe("rework back-edges", () => {
  it("requirement 评审中 → 开发中 is a listed rework", () => {
    const r = evaluateTransition(REQ, "评审中", "开发中");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.kind).toBe("rework");
      expect(r.statusCategory).toBe("in-progress");
    }
  });

  it("a rework target not listed is rejected", () => {
    // 评审中 → 待分析 is a backward move to a todo stage, not a listed edge.
    const r = evaluateTransition(REQ, "评审中", "待分析");
    expect(r.ok).toBe(false);
  });
});

describe("categoryOf derivation", () => {
  it("derives the four categories for sampled stages", () => {
    const cases: [StatusScheme, string, string][] = [
      [REQ, "待分析", "todo"],
      [REQ, "开发中", "in-progress"],
      [REQ, "已上线", "completed"],
      [REQ, "已取消", "cancelled"],
    ];
    for (const [scheme, stage, expected] of cases) {
      expect(categoryOf(scheme, stage)).toBe(expected);
    }
  });
});
