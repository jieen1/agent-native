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
});
