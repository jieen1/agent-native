// Dispatch-grade template lint (docs/sdlc-product-design/
// r4-workflow-families-planning-skills.md §4.2 — task board #78/R4a.2).
//
// Two kinds of coverage:
//  1. Synthetic fixtures — one deliberately-passing and one deliberately-
//     failing DAG per rule, isolating exactly what each rule checks.
//  2. Real-corpus coverage — every entry in the now-merged (R4a.1-hardened)
//     WORKFLOW_LIBRARY_SEED run through the real lint, asserting the SPECIFIC
//     pass/fail pattern this file's rule implementations were traced against
//     (see dispatch-grade-lint.ts's per-rule doc comments for the reasoning).
//     This is what actually exercises rules 4/5's heuristic word lists
//     against real prompt text, not just hand-written fixtures.

import { describe, it, expect } from "vitest";

import { lintTemplateDispatchGrade } from "./dispatch-grade-lint.js";
import { WORKFLOW_LIBRARY_SEED } from "./workflow-library-seed.js";

function findRule(
  result: ReturnType<typeof lintTemplateDispatchGrade>,
  rule: number,
) {
  const r = result.results.find((x) => x.rule === rule);
  if (!r) throw new Error(`rule ${rule} missing from result`);
  return r;
}

// A fully compliant single-round DAG — passes rules 1-5 and 7. Rule 6
// (timeout/retry) is asserted separately since NO seed template in this
// corpus declares timeout_seconds/retry yet (see the real-corpus section
// below) — this fixture demonstrates rule 6 CAN pass when those fields are
// present, decoupled from that corpus-wide gap.
const CLEAN_DAG = {
  nodes: [
    {
      type: "agent",
      id: "dev",
      agent: "vllm",
      prompt:
        "你是开发者。在当前 workspace 完成开发规格:\n\n{{inputs.spec}}\n\n只改动声明范围内的文件:{{inputs.scopeGlobs}}",
      workspace: "{{inputs.workspaceId}}",
      timeout_seconds: 1800,
      retry: { max: 1 },
    },
    {
      type: "agent",
      id: "review1",
      agent: "reviewer",
      deps: ["dev"],
      prompt: "审查当前 workspace 改动,对照规格判断:{{inputs.spec}}",
      workspace: "{{inputs.workspaceId}}",
      output_schema: {
        type: "object",
        required: ["verdict"],
        properties: {
          verdict: { type: "string", enum: ["approved", "changes_requested"] },
        },
      },
    },
    {
      type: "agent",
      id: "fix1",
      agent: "vllm",
      deps: ["review1"],
      guard: "deps.review1.output.verdict != 'approved'",
      prompt: "按审查意见修复:{{deps.review1.output}}",
      workspace: "{{inputs.workspaceId}}",
      timeout_seconds: 1800,
      retry: { max: 1 },
    },
  ],
};
const CLEAN_INPUT_SCHEMA = {
  type: "object",
  required: ["spec", "workspaceId", "scopeGlobs"],
  properties: {
    spec: { type: "string" },
    workspaceId: { type: "string" },
    scopeGlobs: { type: "array" },
  },
};

describe("lintTemplateDispatchGrade — clean fixture", () => {
  it("passes all 7 rules when every field is wired correctly", () => {
    const result = lintTemplateDispatchGrade(CLEAN_DAG, CLEAN_INPUT_SCHEMA);
    expect(result.results.map((r) => [r.rule, r.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
      [6, true],
      [7, true],
    ]);
    expect(result.ok).toBe(true);
    expect(result.level).toBe("dispatch-grade");
    expect(result.passCount).toBe(7);
  });

  it("labels the 5 structured rules and 2 heuristic rules distinctly", () => {
    const result = lintTemplateDispatchGrade(CLEAN_DAG, CLEAN_INPUT_SCHEMA);
    const byRule = new Map(result.results.map((r) => [r.rule, r.confidence]));
    expect(byRule.get(1)).toBe("structural");
    expect(byRule.get(2)).toBe("structural");
    expect(byRule.get(3)).toBe("structural");
    expect(byRule.get(4)).toBe("heuristic");
    expect(byRule.get(5)).toBe("heuristic");
    expect(byRule.get(6)).toBe("structural");
    expect(byRule.get(7)).toBe("structural");
  });

  it("malformed dag input never throws — returns an all-failing result", () => {
    expect(() => lintTemplateDispatchGrade("not json{{", {})).not.toThrow();
    const result = lintTemplateDispatchGrade("not json{{", {});
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(7);
    expect(result.results.every((r) => !r.ok)).toBe(true);
  });
});

describe("rule 1 — input wiring", () => {
  it("fails when a required input is never referenced", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "只提到 {{inputs.spec}}",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    };
    const schema = {
      type: "object",
      required: ["spec", "goal"],
      properties: { spec: {}, goal: {} },
    };
    const r = findRule(lintTemplateDispatchGrade(dag, schema), 1);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("goal");
  });

  it("fails when the prompt references an undeclared input", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "{{inputs.spec}} {{inputs.mystery}}",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    };
    const schema = {
      type: "object",
      required: ["spec"],
      properties: { spec: {} },
    };
    const r = findRule(lintTemplateDispatchGrade(dag, schema), 1);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("mystery");
  });

  it("counts items_from (raw, non-mustache) as a valid reference", () => {
    const dag = {
      nodes: [
        {
          type: "parallel_over",
          id: "fanout",
          deps: [],
          items_from: "inputs.repos",
          body: {
            type: "agent",
            agent: "vllm",
            prompt: "跑 {{inputs.repos}}",
            workspace: "{{inputs.workspaceId}}",
          },
        },
      ],
    };
    const schema = {
      type: "object",
      required: ["repos", "workspaceId"],
      properties: { repos: {}, workspaceId: {} },
    };
    const r = findRule(lintTemplateDispatchGrade(dag, schema), 1);
    expect(r.ok).toBe(true);
  });
});

describe("rule 2 — judgment node structure", () => {
  it("fails when a guard references a node with no output_schema", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "reviewer",
          agent: "vllm",
          prompt: "审查",
          workspace: "{{inputs.workspaceId}}",
        },
        {
          type: "agent",
          id: "fix",
          agent: "vllm",
          deps: ["reviewer"],
          guard: "deps.reviewer.output.approved != true",
          prompt: "修复",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 2);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("reviewer");
  });

  it("fails when output_schema exists but has no enum field", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "reviewer",
          agent: "vllm",
          prompt: "审查",
          workspace: "{{inputs.workspaceId}}",
          output_schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
          },
        },
        {
          type: "agent",
          id: "fix",
          agent: "vllm",
          deps: ["reviewer"],
          guard: "deps.reviewer.output.verdict != 'approved'",
          prompt: "修复",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 2);
    expect(r.ok).toBe(false);
  });

  it("passes when the guard targets a human_gate node (no output_schema needed)", () => {
    const dag = {
      nodes: [
        {
          type: "human_gate",
          id: "gate",
          prompt: "决议",
          options: ["merge", "abandon"],
        },
        {
          type: "agent",
          id: "after",
          agent: "vllm",
          deps: ["gate"],
          guard: "deps.gate.output.choice == 'merge'",
          prompt: "合并后续动作(仅在 gate 场景下的占位文本,无实际权限承诺)",
          workspace: "{{inputs.workspaceId}}",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 2);
    expect(r.ok).toBe(true);
  });
});

describe("rule 3 — bounded loops", () => {
  it("fails a loop node with no max_iterations", () => {
    const dag = {
      nodes: [
        { type: "loop", id: "retry", body: "step", until: "true" },
        {
          type: "agent",
          id: "step",
          agent: "vllm",
          prompt: "p",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("max_iterations");
  });

  it("fails a loop node with max_iterations > 3", () => {
    const dag = {
      nodes: [
        {
          type: "loop",
          id: "retry",
          body: "step",
          until: "true",
          max_iterations: 5,
        },
        {
          type: "agent",
          id: "step",
          agent: "vllm",
          prompt: "p",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(false);
  });

  it("fails when guard-unrolled judgment rounds exceed 3 (4th numbered round)", () => {
    const verdictSchema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
      },
    };
    const round = (n: number, dep: string) => ({
      type: "agent",
      id: `review${n}`,
      agent: "vllm",
      deps: [dep],
      guard:
        n > 1 ? `deps.review${n - 1}.output.verdict != 'approved'` : undefined,
      prompt: "审查",
      workspace: "w",
      output_schema: verdictSchema,
    });
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "开发",
          workspace: "w",
        },
        round(1, "dev"),
        round(2, "review1"),
        round(3, "review2"),
        round(4, "review3"),
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("> 3");
  });

  it("passes exactly 3 guard-unrolled rounds", () => {
    const verdictSchema = {
      type: "object",
      required: ["verdict"],
      properties: {
        verdict: { type: "string", enum: ["approved", "changes_requested"] },
      },
    };
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "开发",
          workspace: "w",
        },
        {
          type: "agent",
          id: "review1",
          agent: "vllm",
          deps: ["dev"],
          prompt: "审查",
          workspace: "w",
          output_schema: verdictSchema,
        },
        {
          type: "agent",
          id: "review2",
          agent: "vllm",
          deps: ["review1"],
          guard: "deps.review1.output.verdict != 'approved'",
          prompt: "审查",
          workspace: "w",
          output_schema: verdictSchema,
        },
        {
          type: "agent",
          id: "review3",
          agent: "vllm",
          deps: ["review2"],
          guard: "deps.review2.output.verdict != 'approved'",
          prompt: "审查",
          workspace: "w",
          output_schema: verdictSchema,
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(true);
  });

  it("fails when a node unconditionally depends on an unresolved loop (silent-done risk)", () => {
    const dag = {
      nodes: [
        {
          type: "loop",
          id: "retry",
          body: "step",
          until: "deps.step.output.approved == true",
          max_iterations: 3,
        },
        {
          type: "agent",
          id: "step",
          agent: "vllm",
          prompt: "重试步骤",
          workspace: "w",
        },
        // Old dead-code shape (§1.3): unconditional continuation after a
        // bounded loop exhausts, regardless of outcome.
        {
          type: "agent",
          id: "pr",
          deps: ["retry"],
          agent: "vllm",
          prompt: "无条件继续",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("耗尽路径可能被静默视为完成");
  });

  it("passes when the loop's exhaustion path routes to a human_gate", () => {
    const dag = {
      nodes: [
        {
          type: "loop",
          id: "retry",
          body: "step",
          until: "deps.step.output.approved == true",
          max_iterations: 3,
        },
        {
          type: "agent",
          id: "step",
          agent: "vllm",
          prompt: "重试步骤",
          workspace: "w",
        },
        {
          type: "human_gate",
          id: "escalate",
          deps: ["retry"],
          prompt: "仍未通过,人工裁决",
          options: ["defer", "force-accept"],
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 3);
    expect(r.ok).toBe(true);
  });
});

describe("rule 4 — workspace threading (heuristic)", () => {
  it("fails a node whose prompt describes real code operations but has no workspace field — the design doc's own quoted pre-hardening examples", () => {
    for (const prompt of [
      "实现工作项变更",
      "运行全量测试并采集证据",
      "对单个仓库运行全量测试套件",
    ]) {
      const dag = {
        nodes: [{ type: "agent", id: "dev", agent: "vllm", prompt }],
      };
      const r = findRule(lintTemplateDispatchGrade(dag, {}), 4);
      expect(
        r.ok,
        `expected "${prompt}" to fail rule 4 without a workspace field`,
      ).toBe(false);
    }
  });

  it("does not require workspace on a pure planning/report node with no code-op verb", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "plan",
          agent: "vllm",
          prompt:
            "汇总本次验证覆盖的仓库清单,并给出验证顺序建议(不做实际测试,只做规划)",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 4);
    expect(r.ok).toBe(true);
  });

  it("does not false-positive on a pure text-synthesis report node using bare '撰写' (write a report, not code)", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "report",
          agent: "vllm",
          prompt:
            "基于上面的探索结果,撰写结构化调研报告(结论/证据/选项对比/建议)。",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 4);
    expect(r.ok).toBe(true);
  });
});

describe("rule 5 — permission honesty (heuristic)", () => {
  it("flags an explicit merge/push promise", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "promote",
          agent: "vllm",
          prompt: "把 sprint 分支合入 base 分支,然后 git push origin main",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 5);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("promote");
  });

  it("flags a 建单/发起PR-style unauthorized-ticket promise", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "audit",
          agent: "vllm",
          prompt: "RED 结果自动生成 from-audit 单",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 5);
    expect(r.ok).toBe(false);
  });

  it("passes a prompt with no permission-adjacent vocabulary", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "在当前 workspace 实现以下规格并运行测试。",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 5);
    expect(r.ok).toBe(true);
  });
});

describe("rule 6 — timeout & retry", () => {
  it("fails a dev/qa-class node missing timeout_seconds and retry", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "开发",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 6);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("timeout_seconds");
    expect(r.detail).toContain("retry");
  });

  it("exempts judgment nodes (output_schema+enum) and human_gate from this rule's scope", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "review",
          agent: "vllm",
          prompt: "审查",
          workspace: "w",
          output_schema: {
            type: "object",
            properties: {
              verdict: {
                type: "string",
                enum: ["approved", "changes_requested"],
              },
            },
          },
        },
        { type: "human_gate", id: "gate", prompt: "决议", options: ["merge"] },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 6);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("无 dev/qa 类节点");
  });

  it("passes once timeout_seconds and retry.max>=1 are both declared", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "开发",
          workspace: "w",
          timeout_seconds: 1800,
          retry: { max: 1 },
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 6);
    expect(r.ok).toBe(true);
  });
});

describe("rule 7 — engine policy", () => {
  it("fails a node whose engine_override resolves to claude-code", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "dev",
          agent: "vllm",
          prompt: "开发",
          workspace: "w",
          engine_override: "acp:claude-code",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 7);
    expect(r.ok).toBe(false);
  });

  it("does not fail a sanctioned agent:'claude-code' review/audit worker (not a violation per §4.2 point 7's own resolution)", () => {
    const dag = {
      nodes: [
        {
          type: "agent",
          id: "review",
          agent: "claude-code",
          prompt: "审查",
          workspace: "w",
        },
      ],
    };
    const r = findRule(lintTemplateDispatchGrade(dag, {}), 7);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("review");
  });
});

// ── Real-corpus coverage: rules 4/5 (and the rest) against the actual,
// now-merged, R4a.1-hardened seed prompts — not just hand-written fixtures. ──

describe("lintTemplateDispatchGrade against the real WORKFLOW_LIBRARY_SEED corpus", () => {
  const linted = new Map(
    WORKFLOW_LIBRARY_SEED.map(
      (e) => [e.name, lintTemplateDispatchGrade(e.dag, e.inputSchema)] as const,
    ),
  );

  it("rule 4 (workspace threading) is clean across the entire hardened corpus — R4a.1's own hardening pass threaded workspace onto every code-touching node", () => {
    for (const [name, result] of linted) {
      const r4 = findRule(result, 4);
      expect(r4.ok, `${name}: rule 4 — ${r4.detail}`).toBe(true);
    }
  });

  it("rule 5 (permission honesty) flags exactly the 3 known real hits in this corpus — 2 heuristic false positives, 1 genuine-but-arguable match", () => {
    const flaggedNames = [...linted.entries()]
      .filter(([, r]) => !findRule(r, 5).ok)
      .map(([name]) => name);
    // sdlc-verify's report node: "不在 DAG 内建单" — false positive, substring
    // match has no negation awareness.
    // sdlc-ui-build's fanout-screens body: "生成单屏原型 HTML" — false
    // positive, "单" here means "single screen", not "ticket".
    // sdlc-promote's promote node: real "合入"/"push" match reflecting the
    // production-verified worker doing git merge/push in its own workspace —
    // a genuine architecture tension the heuristic can't resolve on its own.
    expect(new Set(flaggedNames)).toEqual(
      new Set(["sdlc-verify", "sdlc-ui-build", "sdlc-promote"]),
    );
  });

  it("rule 6 (timeout/retry) fails uniformly for every dev/qa-class template — zero seed templates declare timeout_seconds/retry yet", () => {
    for (const [name, result] of linted) {
      // sdlc-merge-review (task board #95) is a deliberate exception: its
      // ONLY node is itself a judgment node (output_schema.verdict enum), so
      // rule 6's dev/qa-class filter (isDevQaClassNode: has workspace AND NOT
      // a judgment node) finds zero applicable nodes — a vacuous pass, not a
      // declared timeout_seconds/retry. See the dedicated assertion below.
      if (name === "sdlc-merge-review") continue;
      const r6 = findRule(result, 6);
      expect(
        r6.ok,
        `${name} unexpectedly passed rule 6 — corpus assumption changed, update this test`,
      ).toBe(false);
    }
  });

  it("rule 6 passes vacuously for sdlc-merge-review — its single node is pure judgment, no dev/qa-class node to lack timeout/retry", () => {
    const r6 = findRule(linted.get("sdlc-merge-review")!, 6);
    expect(r6.ok).toBe(true);
    expect(r6.detail).toContain("无 dev/qa 类节点");
  });

  it("rule 2 (judgment structure) and rule 3 (bounded loops) are clean across the corpus — R4a.1 hardened output_schema/guard-unrolling everywhere", () => {
    for (const [name, result] of linted) {
      expect(
        findRule(result, 2).ok,
        `${name}: rule 2 — ${findRule(result, 2).detail}`,
      ).toBe(true);
      expect(
        findRule(result, 3).ok,
        `${name}: rule 3 — ${findRule(result, 3).detail}`,
      ).toBe(true);
    }
  });

  it("rule 7 (engine policy) is clean — no seed sets engine_override, and agent:'claude-code' review nodes are correctly not flagged", () => {
    for (const [name, result] of linted) {
      const r7 = findRule(result, 7);
      expect(r7.ok, `${name}: rule 7 — ${r7.detail}`).toBe(true);
    }
  });

  it("rule 1 (input wiring) flags sdlc-issue-pipeline's gateMode — required in inputSchema but only ever referenced inside guard expressions, never in {{inputs.gateMode}} form within prompt/workspace/items_from (rule 1's literal, deliberate scope per §4.2 point 1)", () => {
    const r1 = findRule(linted.get("sdlc-issue-pipeline")!, 1);
    expect(r1.ok).toBe(false);
    expect(r1.detail).toContain("gateMode");
  });

  it("no dev/qa-bearing template reaches full dispatch-grade (7/7) yet — rule 6 alone caps every OTHER template at 6/7 today", () => {
    for (const [name, result] of linted) {
      if (name === "sdlc-merge-review") continue;
      expect(result.passCount).toBeLessThanOrEqual(6);
      expect(result.level).toBe("card-grade");
    }
  });

  it("sdlc-merge-review is the first template to reach 7/7 — a single pure-judgment node has no dev/qa-class gap for rule 6 to catch", () => {
    const result = linted.get("sdlc-merge-review")!;
    expect(result.passCount).toBe(7);
  });
});
