import { describe, it, expect } from "vitest";
import { validateDag, type V3Dag, type V3Node } from "./dag-validator.js";

const validDag: V3Dag = {
  nodes: [
    { type: "agent" as const, id: "research", agent: "claude", prompt: "Research the topic" },
    { type: "agent" as const, id: "write", agent: "claude", prompt: "Write the article", deps: ["research"] },
    { type: "parallel_over" as const, id: "fanout", deps: ["research"], body: "review_step" },
    { type: "agent" as const, id: "review_step", agent: "claude", prompt: "Review each" },
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
        { type: "agent" as const, id: "a", agent: "x", prompt: "p", deps: ["b"] },
        { type: "agent" as const, id: "b", agent: "x", prompt: "p", deps: ["a"] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Cycle");
  });

  it("parallel_over with missing deps rejected", () => {
    const result = validateDag({
      nodes: [
        { type: "parallel_over" as const, id: "p", deps: ["nonexistent"], body: "body_node" },
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
      nodes: [{ type: "agent" as const, id: "a", agent: "x", prompt: "p", guard: "1 +" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("guard");
  });

  it("invalid output_schema rejected", () => {
    const result = validateDag({
      nodes: [{ type: "agent" as const, id: "a", agent: "x", prompt: "p", output_schema: { type: "invalid_type" } }],
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
          { type: "agent" as const, id: "a", agent: "x", prompt: "p", max_summary_tokens: "2000" as any },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("max_summary_tokens");
    });

    it("rejects non-number timeout_seconds", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "a", agent: "x", prompt: "p", timeout_seconds: "600" as any },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("timeout_seconds");
    });

    it("rejects retry without max field", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "a", agent: "x", prompt: "p", retry: { on: ["transient"] } as any },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("retry.max");
    });

    it("rejects non-string engine_override", () => {
      const result = validateDag({
        nodes: [
          { type: "agent" as const, id: "a", agent: "x", prompt: "p", engine_override: 42 as any },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain("engine_override");
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
            body: { type: "agent" as const, agent: "impl", prompt: "Impl {{item}}" },
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
          { type: "loop" as const, id: "lp", body: "step", maxIterations: 3, max_iterations: 5 },
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
        nodes: [
          { type: "loop" as const, id: "lp", body: [] },
        ],
      });
      expect(result.ok).toBe(false);
      expect(result.errors.some(e => e.includes("body array must not be empty"))).toBe(true);
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
});
