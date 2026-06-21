import { describe, expect, it } from "vitest";
import {
  CRON_PRESETS,
  CUSTOM_CRON_PRESET_ID,
  describeCron,
  looksLikeCron,
  presetIdForCron,
} from "./cron";

describe("looksLikeCron", () => {
  it("accepts well-formed 5-field expressions", () => {
    expect(looksLikeCron("30 8 * * *")).toBe(true);
    expect(looksLikeCron("0 8 * * 1-5")).toBe(true);
    expect(looksLikeCron("*/15 * * * *")).toBe(true);
  });

  it("accepts known aliases", () => {
    expect(looksLikeCron("@daily")).toBe(true);
    expect(looksLikeCron("@hourly")).toBe(true);
  });

  it("rejects empty and wrong-arity expressions", () => {
    expect(looksLikeCron("")).toBe(false);
    expect(looksLikeCron("   ")).toBe(false);
    expect(looksLikeCron("30 8 * *")).toBe(false);
    expect(looksLikeCron("30 8 * * * *")).toBe(false);
  });

  it("rejects fields with illegal characters", () => {
    expect(looksLikeCron("30 8 * * !")).toBe(false);
  });
});

describe("describeCron", () => {
  it("describes the canonical morning routine", () => {
    expect(describeCron("30 8 * * *")).toBe("Every day at 8:30 AM");
  });

  it("describes weekday schedules", () => {
    expect(describeCron("30 8 * * 1-5")).toBe("Every weekday at 8:30 AM");
  });

  it("describes hourly schedules", () => {
    expect(describeCron("0 * * * *")).toBe("Every hour at :00");
  });

  it("describes every-minute and every-N-minute schedules", () => {
    expect(describeCron("* * * * *")).toBe("Every minute");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("falls back to the raw expression for unusual patterns", () => {
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});

describe("presetIdForCron", () => {
  it("matches each built-in preset by its exact cron", () => {
    for (const preset of CRON_PRESETS) {
      expect(presetIdForCron(preset.cron)).toBe(preset.id);
    }
  });

  it("returns custom for an unrecognized expression", () => {
    expect(presetIdForCron("15 9 1 * *")).toBe(CUSTOM_CRON_PRESET_ID);
  });
});
