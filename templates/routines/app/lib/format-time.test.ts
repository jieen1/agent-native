import { describe, expect, it } from "vitest";
import { formatDuration } from "./format-time";

describe("formatDuration", () => {
  it("renders a placeholder for null/undefined/negative", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  it("renders sub-second durations in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders one decimal under ten seconds", () => {
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(1_250)).toBe("1.3s");
    expect(formatDuration(9_900)).toBe("9.9s");
  });

  it("renders whole seconds from ten seconds up", () => {
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(59_400)).toBe("59s");
  });

  it("renders minutes and seconds past a minute", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(63_000)).toBe("1m 3s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});
