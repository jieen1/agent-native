/**
 * Phase B2 guard: the today panel's "Compile now" button must route through the
 * agent chat (`sendToAgentChat`), NOT call a compile action directly
 * (docs/IMPLEMENTATION_PLAN.md §1.5.3 / Phase B2). The polished `summaryMd` is
 * only ever produced by the Chief-of-Staff agent running compile → update; a
 * direct frontend `compile-briefing` call would bypass that and break the
 * "all AI goes through the agent chat" contract.
 *
 * This is a source-level assertion (not a render test) so it stays true
 * regardless of styling: it reads the page file and checks what it wires up.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
  fileURLToPath(new URL("./TodayBriefingPage.tsx", import.meta.url)),
  "utf8",
);

describe("TodayBriefingPage — compile routes through the agent chat", () => {
  it("imports and calls sendToAgentChat", () => {
    expect(pageSource).toMatch(
      /import\s*\{[^}]*\bsendToAgentChat\b[^}]*\}\s*from\s*["']@agent-native\/core\/client["']/,
    );
    expect(pageSource).toMatch(/sendToAgentChat\(\s*\{/);
  });

  it("does NOT call the compile-briefing action directly from the panel", () => {
    // No action-hook call bound to compile-briefing.
    expect(pageSource).not.toMatch(
      /useActionMutation\(\s*["']compile-briefing/,
    );
    expect(pageSource).not.toMatch(/useActionQuery\(\s*["']compile-briefing/);
    // No raw action invocation by name either.
    expect(pageSource).not.toMatch(/["']compile-briefing["']/);
  });
});
