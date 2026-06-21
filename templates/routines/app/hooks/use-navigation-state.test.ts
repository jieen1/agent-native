import { describe, expect, it } from "vitest";
import {
  pathForCommand,
  routineNameForPath,
  screenForPath,
} from "./use-navigation-state";

describe("screenForPath", () => {
  it("maps the routines list and new routes to the routines screen", () => {
    expect(screenForPath("/routines")).toBe("routines");
    expect(screenForPath("/routines/new")).toBe("routines");
  });

  it("maps a routine detail path to routine-edit", () => {
    expect(screenForPath("/routines/morning-briefing")).toBe("routine-edit");
  });

  it("maps a routine runs path to runs", () => {
    expect(screenForPath("/routines/morning-briefing/runs")).toBe("runs");
  });

  it("maps the keys page to the keys screen, not routine-edit", () => {
    expect(screenForPath("/routines/keys")).toBe("keys");
  });

  it("falls back to chat for the home route", () => {
    expect(screenForPath("/")).toBe("chat");
  });

  it("preserves the existing framework screens", () => {
    expect(screenForPath("/database")).toBe("database");
    expect(screenForPath("/observability")).toBe("observability");
    expect(screenForPath("/extensions/abc")).toBe("extensions");
  });
});

describe("routineNameForPath", () => {
  it("extracts the slug from a routine detail path", () => {
    expect(routineNameForPath("/routines/morning-briefing")).toBe(
      "morning-briefing",
    );
  });

  it("extracts the slug from a runs path", () => {
    expect(routineNameForPath("/routines/morning-briefing/runs")).toBe(
      "morning-briefing",
    );
  });

  it("returns undefined for the list, new, keys, and unrelated routes", () => {
    expect(routineNameForPath("/routines")).toBeUndefined();
    expect(routineNameForPath("/routines/new")).toBeUndefined();
    expect(routineNameForPath("/routines/keys")).toBeUndefined();
    expect(routineNameForPath("/database")).toBeUndefined();
  });

  it("decodes URL-encoded slugs", () => {
    expect(routineNameForPath("/routines/weekly%2Dreport")).toBe(
      "weekly-report",
    );
  });
});

describe("pathForCommand", () => {
  it("maps routines view to the list path", () => {
    expect(pathForCommand("routines")).toBe("/routines");
  });

  it("maps routine-edit + routineName to the detail path", () => {
    expect(pathForCommand("routine-edit", "morning-briefing")).toBe(
      "/routines/morning-briefing",
    );
  });

  it("maps runs + routineName to the runs path", () => {
    expect(pathForCommand("runs", "morning-briefing")).toBe(
      "/routines/morning-briefing/runs",
    );
  });

  it("maps the keys view to the keys page", () => {
    expect(pathForCommand("keys")).toBe("/routines/keys");
  });

  it("falls back to the list when routineName is missing for edit/runs", () => {
    expect(pathForCommand("routine-edit")).toBe("/routines");
    expect(pathForCommand("runs")).toBe("/routines");
  });

  it("maps chat and unknown views to home", () => {
    expect(pathForCommand("chat")).toBe("/");
    expect(pathForCommand(undefined)).toBe("/");
  });
});
