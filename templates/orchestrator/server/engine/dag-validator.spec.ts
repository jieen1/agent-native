import { describe, it, expect } from "vitest";

import {
  validateDag,
  isClaudeCodeEngineRef,
  nodeTargetsClaudeCode,
  type V3Dag,
  type V3Node,
} from "./dag-validator.js";

const validDag: V3Dag = {
  nodes: [
    {
      type: "agent" as const,
      id: "research",
      agent: "claude",
      prompt: "Research the topic",
    },
    {
      type: "agent" as const,
      id: "write",
      agent: "claude",
      prompt: "Write the article",
      deps: ["research"],
    },
    {
      type: "parallel_over" as const,
      id: "fanout",
      deps: ["research"],
      body: "review_step",
    },
    {
      type: "agent" as const,
      id: "review_step",
      agent: "claude",
      prompt: "Review each",
    },
  ],
};

describe("validateDag", () => {
  it("valid 4-node template passes", () => {
    const result = validateDag(validDag);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("unknown node type rejected", () => {
    const result = validateDag({ nodes: [{ type: "unknown_type", id: "x" }] });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown type");
  });

  it("cycle detected", () => {
    const result = validateDag({
      nodes: [
        {
          type: "agent" as const,
          id: "a",
          agent: "x",
          prompt: "p",
          deps: ["b"],
        },
        {
          type: "agent" as const,
          id: "b",
          agent: "x",
          prompt: "p",
          deps: ["a"],
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Cycle");
  });

  it("parallel_over with missing deps rejected", () => {
    const result = validateDag({
      nodes: [
        {
          type: "parallel_over" as const,
          id: "p",
          deps: ["nonexistent"],
          body: "body_node",
        },
        { type: "agent" as const, id: "body_node", agent: "x", prompt: "p" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("duplicate node ids rejected", () => {
    const result = validateDag({
      nodes: [
        { type: "agent" as const, id: "x", agent: "a", prompt: "p" },
        { type: "agent" as const, id: "x", agent: "a", prompt: "p" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("duplicate");
  });

  it("missing required fields rejected", () => {
    const result = validateDag({ nodes: [{ type: "agent", id: "a" }] });
    expect(result.ok).toBe(false);
  });

  it("invalid guard expression rejected", () => {
    const result = validateDag({
      nodes: [
        {
          type: "agent" as const,
          id: "a",
          agent: "x",
          prompt: "p",
          guard: "1 +",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("guard");
  });

  it("invalid output_schema rejected", () => {
    const result = validateDag({
      nodes: [
        {
          type: "agent" as const,
          id: "a",
          agent: "x",
          prompt: "p",
          output_schema: { type: "invalid_type" },
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("output_schema");
  });

  it("non-object rejected", () => {
    expect(validateDag(null as any).ok).toBe(false);
    expect(validateDag("string" as any).ok).toBe(false);
    expect(validateDag([] as any).ok).toBe(false);
  });

  // ── G40: V3AgentNode optional fields ────────────────────────────────────────

  describe("G40: agent node optional fields", () => {
    it("accepts all new optional fields on agent node", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            workspace: "ws_123",
            max_summary_tokens: 2000,
            engine_override: "ai-sdk:openai",
            model_override: "gpt-4o",
            retry: { max: 2, on: ["transient"] },
            timeout_seconds: 600,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects non-number max_summary_tokens", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            max_summary_tokens: "2000" as any,
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("max_summary_tokens");
    });

    it("rejects non-number timeout_seconds", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            timeout_seconds: "600" as any,
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("timeout_seconds");
    });

    it("rejects retry without max field", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            retry: { on: ["transient"] } as any,
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("retry.max");
    });

    it("rejects non-string engine_override", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            engine_override: 42 as any,
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("engine_override");
    });

    it("rejects engine_override:'claude-code' on a worker node (CC subscription reserved for the brain)", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            engine_override: "claude-code",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain(
        "engine_override 'claude-code' is not allowed",
      );
    });

    it("rejects engine_override:'acp:claude*' variants case-insensitively", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            engine_override: "ACP:Claude-Code",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain(
        "engine_override 'claude-code' is not allowed",
      );
    });

    // R4a.3 §4.2 point 7 — `agent:"claude-code"` is a first-party, sanctioned
    // review/audit worker (all 9 seed templates' REVIEW constant + production
    // brain DAGs like sdlc-issue-pipeline v4 depend on it). The gap the design
    // closes is resource-protection (the concurrency gate in
    // server/queue/claude-code-admit.ts), NOT a validateDag ban — banning it
    // here would break those sanctioned DAGs.
    it("does NOT reject agent:'claude-code' (sanctioned review/audit worker, unlike engine_override)", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "review",
            agent: "claude-code",
            prompt: "Review the diff",
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  // ── G41: parallel_over body object + max_concurrency + items_from ────────────

  describe("G41: parallel_over inline body and max_concurrency", () => {
    it("accepts inline agent body object in parallel_over", () => {
      const result = validateDag({
        nodes: [
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            items_from: "deps.src.output.files",
            body: {
              type: "agent" as const,
              agent: "impl",
              prompt: "Impl {{item}}",
            },
          },
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts max_concurrency on parallel_over", () => {
      const result = validateDag({
        nodes: [
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: "step",
            max_concurrency: 4,
          },
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects max_concurrency less than 1", () => {
      const result = validateDag({
        nodes: [
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: "step",
            max_concurrency: 0,
          },
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("max_concurrency");
    });

    it("rejects inline body with wrong type", () => {
      const result = validateDag({
        nodes: [
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: { type: "loop" as any, agent: "impl", prompt: "p" },
          },
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("body type must be 'agent'");
    });

    it("rejects invalid items_from expression", () => {
      const result = validateDag({
        nodes: [
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: "step",
            items_from: "deps.src.output +",
          },
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("items_from expression");
    });
  });

  // ── G42: loop body as string[] and max_iterations alias ─────────────────────

  describe("G42: loop body array and max_iterations alias", () => {
    it("accepts loop with body as array of node ids", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "fix", agent: "x", prompt: "fix" },
          { type: "agent" as const, id: "test", agent: "x", prompt: "test" },
          {
            type: "loop" as const,
            id: "fix_loop",
            body: ["fix", "test"],
            until: "deps.test.output.passed == true",
            max_iterations: 3,
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts max_iterations as alias for maxIterations", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          { type: "loop" as const, id: "lp", body: "step", max_iterations: 5 },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("accepts maxIterations (legacy name)", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          { type: "loop" as const, id: "lp", body: "step", maxIterations: 5 },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("rejects conflicting maxIterations and max_iterations", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          {
            type: "loop" as const,
            id: "lp",
            body: "step",
            maxIterations: 3,
            max_iterations: 5,
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("aliases");
    });

    it("rejects loop body array with missing node id", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "fix", agent: "x", prompt: "fix" },
          { type: "loop" as const, id: "lp", body: ["fix", "nonexistent"] },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("body node 'nonexistent' not found");
    });

    it("rejects empty loop body array", () => {
      const result = validateDag({
        nodes: [{ type: "loop" as const, id: "lp", body: [] }],
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some((e) => e.includes("body array must not be empty")),
      ).toBe(true);
    });
  });

  // ── Guard lifted to all node types (§4) ─────────────────────────────────────

  describe("guard validated on all node types", () => {
    it("parallel_over with valid guard passes", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: "step",
            guard: "deps.src.output.count > 0",
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("parallel_over with invalid guard rejected", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "src", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          {
            type: "parallel_over" as const,
            id: "fanout",
            deps: ["src"],
            body: "step",
            guard: "1 +",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("guard");
    });

    it("loop with valid guard passes", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          {
            type: "loop" as const,
            id: "lp",
            body: "step",
            guard: "inputs.enabled == true",
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("loop with invalid guard rejected", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "step", agent: "x", prompt: "p" },
          {
            type: "loop" as const,
            id: "lp",
            body: "step",
            guard: "== bad",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("guard");
    });

    it("human_gate with valid guard passes", () => {
      const result = validateDag({
        nodes: [
          {
            type: "human_gate" as const,
            id: "gate",
            prompt: "Approve?",
            guard: "inputs.requireApproval == true",
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("human_gate with invalid guard rejected", () => {
      const result = validateDag({
        nodes: [
          {
            type: "human_gate" as const,
            id: "gate",
            prompt: "Approve?",
            guard: "&&",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("guard");
    });
  });

  // ── Task board #83 — guard deps.<id> must be a direct dependency ───────────
  // `v3-dispatcher.ts`'s getNodeDeps() / `v3-reconciler.ts`'s
  // buildGuardContext() only ever populate deps.<id> from a node's OWN
  // direct `deps` array — never transitively. A guard referencing an
  // ancestor's output that isn't directly depended on silently resolves to
  // `undefined` at runtime instead of erroring at save time; validateDag()
  // must catch this at author time.
  describe("guard deps must be direct dependencies", () => {
    it("guard referencing its own direct dep passes", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "review1", agent: "x", prompt: "p" },
          {
            type: "agent" as const,
            id: "fix1",
            agent: "x",
            prompt: "p",
            deps: ["review1"],
            guard: "deps.review1.output.verdict != 'approved'",
          },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("guard referencing a non-direct (transitive) dep is rejected", () => {
      // review2 depends only on fix1, but its guard reaches past fix1 to
      // review1 (a dep of fix1, not of review2 itself) — the exact R4a
      // core-lineage bug found in sdlc-review/sdlc-audit/sdlc-full.
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "review1", agent: "x", prompt: "p" },
          {
            type: "agent" as const,
            id: "fix1",
            agent: "x",
            prompt: "p",
            deps: ["review1"],
          },
          {
            type: "agent" as const,
            id: "review2",
            agent: "x",
            prompt: "p",
            deps: ["fix1"],
            guard: "deps.review1.output.verdict != 'approved'",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes("review2") &&
            e.includes("deps.review1") &&
            e.includes("not a"),
        ),
      ).toBe(true);
    });

    it("guard referencing a dep not in an empty/missing deps array is rejected", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "a", agent: "x", prompt: "p" },
          {
            type: "agent" as const,
            id: "b",
            agent: "x",
            prompt: "p",
            guard: "deps.a.output.verdict == 'ok'",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("deps.a"))).toBe(true);
    });

    it("guard referencing only inputs.* (no deps.*) is unaffected", () => {
      const result = validateDag({
        nodes: [
          {
            type: "agent" as const,
            id: "a",
            agent: "x",
            prompt: "p",
            guard: "inputs.enabled == true",
          },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("guard referencing one of several direct deps passes, flags only the missing one", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "a", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "b", agent: "x", prompt: "p" },
          { type: "agent" as const, id: "c", agent: "x", prompt: "p" },
          {
            type: "agent" as const,
            id: "d",
            agent: "x",
            prompt: "p",
            deps: ["a", "b"],
            guard: "deps.a.output.ok == true && deps.c.output.ok == true",
          },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0]).toContain("deps.c");
      expect(result.errors[0]).not.toContain("deps.a");
    });
  });
});

// R4a.3 §4.2 point 7 — shared claude-code recognition predicate, used by both
// this file's (unchanged) engine_override hard-reject AND the concurrency
// admission gate (server/queue/claude-code-admit.ts) so both paths recognize
// the SAME "targets claude-code" condition.
describe("isClaudeCodeEngineRef", () => {
  it("matches the literal 'claude-code' agent-def name", () => {
    expect(isClaudeCodeEngineRef("claude-code")).toBe(true);
  });

  it("matches 'acp:claude*' variants case-insensitively", () => {
    expect(isClaudeCodeEngineRef("acp:claude-code")).toBe(true);
    expect(isClaudeCodeEngineRef("ACP:Claude-Code")).toBe(true);
    expect(isClaudeCodeEngineRef("  acp:claude-code  ")).toBe(true);
  });

  it("does not match other engines/agents", () => {
    expect(isClaudeCodeEngineRef("claude")).toBe(false);
    expect(isClaudeCodeEngineRef("ai-sdk:anthropic")).toBe(false);
    expect(isClaudeCodeEngineRef("vllm")).toBe(false);
  });

  it("tolerates null/undefined/empty", () => {
    expect(isClaudeCodeEngineRef(null)).toBe(false);
    expect(isClaudeCodeEngineRef(undefined)).toBe(false);
    expect(isClaudeCodeEngineRef("")).toBe(false);
  });
});

describe("nodeTargetsClaudeCode", () => {
  it("true when agent is 'claude-code'", () => {
    expect(
      nodeTargetsClaudeCode({
        agent: "claude-code",
        engine_override: undefined,
      }),
    ).toBe(true);
  });

  it("true when engine_override is 'claude-code'", () => {
    expect(
      nodeTargetsClaudeCode({ agent: "vllm", engine_override: "claude-code" }),
    ).toBe(true);
  });

  it("false for a plain non-claude-code worker", () => {
    expect(
      nodeTargetsClaudeCode({ agent: "vllm", engine_override: undefined }),
    ).toBe(false);
  });
});
