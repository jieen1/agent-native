import { describe, it, expect } from "vitest";
import { renderTemplate, type ExpressionContext } from "./interpolation.js";

const ctx: ExpressionContext = {
  inputs: { name: "Alice", count: 5, tags: ["a", "b", "c"], config: { mode: "test" } },
  deps: {
    research: { output: { summary: "Research complete", score: 95 }, previous_iteration: { output: { summary: "Draft" } }, history: [{ review: { output: { score: 80 } } }] },
    writing: { output: { text: "The article text here" } },
  },
  item: { title: "Current item" },
  iteration: 3,
};

describe("renderTemplate", () => {
  it("interpolates string value", () => {
    expect(renderTemplate("Hello {{ inputs.name }}", ctx)).toBe("Hello Alice");
  });

  it("interpolates number value", () => {
    expect(renderTemplate("Count: {{ inputs.count }}", ctx)).toBe("Count: 5");
  });

  it("interpolates deps path", () => {
    expect(renderTemplate("Score: {{ deps.research.output.score }}", ctx)).toBe("Score: 95");
  });

  it("serializes arrays as JSON", () => {
    expect(renderTemplate("{{ inputs.tags }}", ctx)).toBe(JSON.stringify(["a", "b", "c"]));
  });

  it("throws for undefined path", () => {
    expect(() => renderTemplate("{{ inputs.nonexistent }}", ctx)).toThrow(
      "interpolation error: path not found in {{ inputs.nonexistent }}"
    );
  });

  it("passes through plain text", () => {
    expect(renderTemplate("No interpolation here", ctx)).toBe("No interpolation here");
  });

  it("handles multiple interpolations", () => {
    expect(renderTemplate("A={{ inputs.name }} B={{ inputs.count }}", ctx)).toBe("A=Alice B=5");
  });
});
