import { evaluateExpression, type ExpressionContext } from "./expression-parser.js";

export type { ExpressionContext } from "./expression-parser.js";

export function renderTemplate(template: string, context: ExpressionContext): string {
  if (!template.includes("{{")) return template;

  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawExpr) => {
    const expr = rawExpr.trim();
    const value: unknown = evaluateExpression(expr, context);

    if (value === undefined) {
      throw new Error(`interpolation error: path not found in {{ ${expr} }}`);
    }
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "boolean") return String(value);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}
