import { describe, it, expect } from "vitest";
import { evaluateExpression, validateExpressionSyntax, type ExpressionContext } from "./expression-parser.js";

const ctx: ExpressionContext = {
  inputs: { name: "Alice", count: 5, tags: ["a", "b", "c"], config: { mode: "test" } },
  deps: {
    research: { output: { summary: "Research complete", score: 95 }, previous_iteration: { output: { summary: "Draft" } }, history: [{ review: { output: { score: 80 } } }] },
    writing: { output: { text: "The article text here" } },
  },
  item: { title: "Current item" },
  iteration: 3,
};

describe("path expressions", () => {
  it.each([
    ["inputs.name", "Alice"],
    ["inputs.count", 5],
    ["inputs.tags", ["a", "b", "c"]],
    ["inputs.config.mode", "test"],
    ["inputs.nonexistent", undefined],
    ["deps.research.output.summary", "Research complete"],
    ["deps.research.output.score", 95],
    ["deps.research.previous_iteration.output.summary", "Draft"],
    ["deps.research.history[0].review.output.score", 80],
    ["deps.writing.output.text", "The article text here"],
    ["iteration", 3],
  ])("%s => %j", (expr, expected) => {
    expect(evaluateExpression(expr, ctx)).toEqual(expected);
  });

  it("resolves item root", () => {
    expect(evaluateExpression("item", ctx)).toEqual({ title: "Current item" });
  });
});

describe("operators", () => {
  it.each([
    ["inputs.count == 5", true],
    ["inputs.count != 3", true],
    ["inputs.count > 3", true],
    ["inputs.count >= 5", true],
    ["inputs.count < 10", true],
    ["inputs.count <= 5", true],
    ["inputs.count == 3", false],
    ["inputs.count > 5 && inputs.count < 10 || inputs.count == 5", true],
    ["!true", false],
    ["!false", true],
  ])("%s => %j", (expr, expected) => {
    expect(evaluateExpression(expr, ctx)).toBe(expected);
  });
});

describe("functions", () => {
  it.each([
    ['len("hello")', 5],
    ["len(inputs.tags)", 3],
    ['contains("hello world", "world")', true],
    ['contains("hello", "xyz")', false],
    ['startsWith("hello", "hel")', true],
    ['endsWith("hello", "llo")', true],
    ["exists(inputs.name)", true],
    ["exists(inputs.missing)", false],
    ["exists(null)", false],
    ['coalesce(null, "default")', "default"],
    ["coalesce(inputs.missing, inputs.name)", "Alice"],
  ])("%s => %j", (expr, expected) => {
    expect(evaluateExpression(expr, ctx)).toEqual(expected);
  });
});

describe("validateExpressionSyntax", () => {
  it("accepts valid paths", () => {
    expect(validateExpressionSyntax("inputs.name")).toEqual({ ok: true });
    expect(validateExpressionSyntax("dep.output[0]")).toEqual({ ok: true });
  });

  it("accepts function calls", () => {
    expect(validateExpressionSyntax("len(x)")).toEqual({ ok: true });
  });

  it("rejects unsupported operators", () => {
    const result = validateExpressionSyntax("1 + 2");
    expect(result.ok).toBe(false);
  });
});
