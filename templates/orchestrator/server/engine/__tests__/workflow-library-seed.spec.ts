// S8 workflow library seed, R4a hardened (docs/sdlc-product-design/
// r4-workflow-families-planning-skills.md §4.1/§4.3 — task board #77): 13
// built-in templates (core 族 4 套，收编自 101 自举血统 + sdlc 族 5 套 + 轻量族
// 4 套). Proves the seed data is actually save-able through the SAME
// validateDag() workflowSave/workflowRun enforce, so a boot-time seed-plugin
// failure (swallowed by its best-effort try/catch) can't silently mean
// "every entry always fails validation and nothing ever gets seeded".

import { describe, it, expect } from "vitest";

import { validateDag } from "../dag-validator.js";
import {
  WORKFLOW_LIBRARY_SEED,
  type WorkflowFamily,
} from "../workflow-library-seed.js";

describe("WORKFLOW_LIBRARY_SEED", () => {
  it("has exactly 14 templates: 5 core + 5 sdlc + 4 light (r4 doc §4.1/§4.3 + task board #95's sdlc-merge-review)", () => {
    expect(WORKFLOW_LIBRARY_SEED).toHaveLength(14);
    const byFamily = WORKFLOW_LIBRARY_SEED.reduce(
      (acc, e) => {
        acc[e.family] = (acc[e.family] ?? 0) + 1;
        return acc;
      },
      {} as Record<WorkflowFamily, number>,
    );
    expect(byFamily.core).toBe(5);
    expect(byFamily.sdlc).toBe(5);
    expect(byFamily.light).toBe(4);
    expect(byFamily.custom).toBeUndefined();
  });

  it("has unique, non-empty names", () => {
    const names = WORKFLOW_LIBRARY_SEED.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.length).toBeGreaterThan(0);
  });

  it.each(WORKFLOW_LIBRARY_SEED.map((e) => [e.name, e] as const))(
    "%s: dag passes the real validateDag()",
    (_name, entry) => {
      const result = validateDag(entry.dag);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    },
  );

  it.each(WORKFLOW_LIBRARY_SEED.map((e) => [e.name, e] as const))(
    "%s: has a non-empty description, changeNote, and at least one tag",
    (_name, entry) => {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.changeNote.length).toBeGreaterThan(0);
      expect(entry.tags.length).toBeGreaterThan(0);
    },
  );

  it.each(WORKFLOW_LIBRARY_SEED.map((e) => [e.name, e] as const))(
    "%s: inputSchema is a compilable JSON Schema object",
    (_name, entry) => {
      expect(entry.inputSchema.type).toBe("object");
      expect(typeof entry.inputSchema.properties).toBe("object");
    },
  );

  // SDLC-039 / B1: sdlc-dev 的 develop 节点必须把 TDD 红先行两段提交纪律 +
  // done 报告测试证据纪律写进 prompt（可机检标记），否则 develop 节点会退回
  // 单 squash commit、done 报告无测试输出的旧行为。
  it("sdlc-dev: develop 节点 prompt 含 TDD 两段提交 + 测试证据纪律标记", () => {
    const entry = WORKFLOW_LIBRARY_SEED.find((e) => e.name === "sdlc-dev");
    expect(entry).toBeDefined();
    const devNode = entry!.dag.nodes.find(
      (n) => (n as { id?: string }).id === "develop",
    ) as { prompt?: string } | undefined;
    expect(devNode).toBeDefined();
    const prompt = devNode!.prompt ?? "";

    // (A) TDD 红先行两段提交纪律
    expect(prompt).toContain("test:");
    expect(prompt).toContain("红");
    expect(prompt).toContain("分两段提交");
    expect(prompt).toContain("git log");

    // (B) done 报告必须附测试执行证据
    expect(prompt).toContain("测试命令");
    expect(prompt).toContain("输出摘录");
    expect(prompt).toContain("commit hash");
  });
});
