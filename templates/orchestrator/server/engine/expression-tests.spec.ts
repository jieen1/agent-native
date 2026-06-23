import { describe, it, expect } from "vitest";
import { evaluateExpression, validateExpressionSyntax, type ExpressionContext } from "./expression-parser.js";
import { renderTemplate } from "./interpolation.js";
import { validateDag, type V3Dag } from "./dag-validator.js";

const ctx: ExpressionContext = {
  inputs: { feature: "auth" },
  deps: {
    spec: { output: { plan: "implement auth module" } },
    review: { output: { verdict: "pass", score: 95 } },
  },
  item: undefined,
  iteration: undefined,
};

// ═══════════════════════════════════════════════════════════
// Expression Parser
// ═══════════════════════════════════════════════════════════

describe("expression parser — paths", () => {
  it("inputs.X resolves to value", () => {
    expect(evaluateExpression("inputs.feature", ctx)).toBe("auth");
  });

  it("deps.spec.output resolves to nested object", () => {
    expect(evaluateExpression("deps.spec.output", ctx)).toEqual({ plan: "implement auth module" });
  });

  it("deps.spec.output.plan drills into leaf string", () => {
    expect(evaluateExpression("deps.spec.output.plan", ctx)).toBe("implement auth module");
  });
});

describe("expression parser — comparisons", () => {
  it('deps.review.output.verdict == "pass"', () => {
    expect(evaluateExpression('deps.review.output.verdict == "pass"', ctx)).toBe(true);
  });

  it("deps.review.output.score > 90", () => {
    expect(evaluateExpression("deps.review.output.score > 90", ctx)).toBe(true);
  });
});

describe("expression parser — boolean", () => {
  it("&& combines two comparisons", () => {
    const expr = 'deps.review.output.verdict == "pass" && deps.review.output.score > 90';
    expect(evaluateExpression(expr, ctx)).toBe(true);
  });

  it("!true => false", () => {
    expect(evaluateExpression("!true", ctx)).toBe(false);
  });
});

describe("expression parser — functions", () => {
  it('len("hello") => 5', () => {
    expect(evaluateExpression('len("hello")', ctx)).toBe(5);
  });

  it('contains("hello world", "world") => true', () => {
    expect(evaluateExpression('contains("hello world", "world")', ctx)).toBe(true);
  });

  it('startsWith("hello", "hel") => true', () => {
    expect(evaluateExpression('startsWith("hello", "hel")', ctx)).toBe(true);
  });

  it('endsWith("hello", "llo") => true', () => {
    expect(evaluateExpression('endsWith("hello", "llo")', ctx)).toBe(true);
  });

  it('exists("inputs.feature") => true', () => {
    // exists() takes an expression argument, not a string literal path
    expect(evaluateExpression("exists(inputs.feature)", ctx)).toBe(true);
  });

  it('coalesce(null, "fallback") => "fallback"', () => {
    expect(evaluateExpression('coalesce(null, "fallback")', ctx)).toBe("fallback");
  });
});

describe("validateExpressionSyntax", () => {
  it("valid expression returns ok: true", () => {
    const result = validateExpressionSyntax('inputs.feature == "auth"');
    expect(result.ok).toBe(true);
  });

  it("invalid syntax returns ok: false", () => {
    const result = validateExpressionSyntax("1 +");
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// Interpolation
// ═══════════════════════════════════════════════════════════

describe("interpolation — renderTemplate", () => {
  it("string interpolation", () => {
    expect(renderTemplate("Hello {{inputs.feature}}", ctx)).toBe("Hello auth");
  });

  it("number interpolation", () => {
    expect(renderTemplate("Score: {{deps.review.output.score}}", ctx)).toBe("Score: 95");
  });

  it("object interpolation serializes as JSON", () => {
    const result = renderTemplate("{{deps.review.output}}", ctx);
    expect(result).toBe(JSON.stringify({ verdict: "pass", score: 95 }));
  });

  it("undefined path throws", () => {
    expect(() => renderTemplate("{{inputs.nonexistent}}", ctx)).toThrow(
      "interpolation error: path not found in {{ inputs.nonexistent }}"
    );
  });
});

// ═══════════════════════════════════════════════════════════
// DAG Validator
// ═══════════════════════════════════════════════════════════

describe("dag validator — validateDag", () => {
  it("valid 4-node DAG (agent -> agent -> parallel_over -> loop) passes", () => {
    const dag: V3Dag = {
      nodes: [
        { type: "agent", id: "spec", agent: "claude", prompt: "Write spec" },
        { type: "agent", id: "review", agent: "claude", prompt: "Review spec", deps: ["spec"] },
        { type: "parallel_over", id: "reviews", deps: ["spec"], body: "review" },
        { type: "loop", id: "refine", body: "spec", until: "deps.review.output.verdict == 'pass'" },
      ],
    };
    const result = validateDag(dag);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("unknown node type is rejected", () => {
    const result = validateDag({
      nodes: [{ type: "unknown_type", id: "x" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown type");
  });

  it("cycle detection rejects circular deps", () => {
    const result = validateDag({
      nodes: [
        { type: "agent", id: "a", agent: "x", prompt: "p", deps: ["b"] },
        { type: "agent", id: "b", agent: "x", prompt: "p", deps: ["a"] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Cycle");
  });

  it("parallel_over with missing deps is rejected", () => {
    const result = validateDag({
      nodes: [
        { type: "parallel_over", id: "p", deps: ["nonexistent"], body: "body_node" },
        { type: "agent", id: "body_node", agent: "x", prompt: "p" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("loop with nonexistent body is rejected", () => {
    const result = validateDag({
      nodes: [
        { type: "loop", id: "l", body: "ghost" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not found");
  });

  it("invalid guard expression is rejected", () => {
    const result = validateDag({
      nodes: [
        { type: "agent", id: "a", agent: "x", prompt: "p", guard: "1 +" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("guard");
  });
});
