/**
 * Unit tests for briefing-settings normalization (Phase B3). parseBriefingSettings
 * is pure (apart from the DEFAULT_APPS import) and defends every boundary.
 */
import { describe, expect, it } from "vitest";
import { parseBriefingSettings } from "./briefing-settings.js";
import { DEFAULT_APPS } from "./app-prompts.js";

describe("parseBriefingSettings", () => {
  it("falls back to the default app set + empty overrides when unset", () => {
    expect(parseBriefingSettings(null)).toEqual({
      enabledApps: [...DEFAULT_APPS],
      promptOverrides: {},
    });
    expect(parseBriefingSettings(undefined)).toEqual({
      enabledApps: [...DEFAULT_APPS],
      promptOverrides: {},
    });
  });

  it("keeps a valid enabledApps list (trimmed, de-duped)", () => {
    const out = parseBriefingSettings({
      enabledApps: ["mail", "mail", " calendar ", 7, ""],
    });
    expect(out.enabledApps).toEqual(["mail", "calendar"]);
  });

  it("falls back to defaults when enabledApps is empty or invalid", () => {
    expect(parseBriefingSettings({ enabledApps: [] }).enabledApps).toEqual([
      ...DEFAULT_APPS,
    ]);
    expect(parseBriefingSettings({ enabledApps: "mail" }).enabledApps).toEqual([
      ...DEFAULT_APPS,
    ]);
  });

  it("keeps valid promptOverrides and drops empty/non-string entries", () => {
    const out = parseBriefingSettings({
      promptOverrides: {
        mail: "  Only VIP threads.  ",
        calendar: "",
        brain: 5,
      },
    });
    expect(out.promptOverrides).toEqual({ mail: "Only VIP threads." });
  });

  it("ignores a non-object promptOverrides", () => {
    expect(
      parseBriefingSettings({ promptOverrides: ["x"] }).promptOverrides,
    ).toEqual({});
  });
});
