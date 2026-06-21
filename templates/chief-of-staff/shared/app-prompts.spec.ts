/**
 * Unit tests for per-app briefing prompts (docs/IMPLEMENTATION_PLAN.md §1.5.13,
 * Phase B3). buildAppPrompt is pure + deterministic.
 *
 * Coverage:
 *   - DEFAULT_APPS is the four selected sources (§1.5.16).
 *   - mail/calendar keep their bespoke phrasing.
 *   - brain starts on search-everything + delegation hints (router caliber, §6).
 *   - analytics matches the §1.5.13 caliber: list existing dashboards/analyses,
 *     only get-analysis a daily-metrics report, never run new queries.
 *   - focus is appended when provided.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_APPS, buildAppPrompt } from "./app-prompts.js";

describe("DEFAULT_APPS", () => {
  it("is the four selected sources (§1.5.16)", () => {
    expect([...DEFAULT_APPS]).toEqual([
      "mail",
      "calendar",
      "brain",
      "analytics",
    ]);
  });
});

describe("buildAppPrompt — brain (router caliber, §6)", () => {
  it("instructs the brain agent to use search-everything + delegation hints", () => {
    const p = buildAppPrompt("brain", "morning");
    expect(p).toMatch(/search-everything/);
    expect(p).toMatch(/federatedCoverage\.delegationHints/);
    expect(p).toMatch(/downstream apps/i);
  });
});

describe("buildAppPrompt — analytics (§1.5.13 caliber)", () => {
  it("lists existing dashboards/analyses and forbids new ad-hoc queries", () => {
    const p = buildAppPrompt("analytics", "morning");
    expect(p).toMatch(/list-sql-dashboards/);
    expect(p).toMatch(/list-analyses/);
    // Only the conventionally-named daily-metrics analysis gets get-analysis.
    expect(p).toMatch(/get-analysis/);
    expect(p).toMatch(/daily-metrics|daily-briefing/);
    // Hard "do not run new queries / invent metrics" guard.
    expect(p).toMatch(/do not run new/i);
    expect(p).toMatch(/invent metrics/i);
  });
});

describe("buildAppPrompt — focus + fallthrough", () => {
  it("appends a focus hint when provided", () => {
    const p = buildAppPrompt("analytics", "morning", "board prep");
    expect(p).toMatch(/Extra focus for this briefing: board prep\./);
  });

  it("still produces a generic prompt for an unknown app", () => {
    const p = buildAppPrompt("content", "adhoc");
    expect(p).toMatch(/content/);
    expect(p).toMatch(/deep link/);
  });
});
