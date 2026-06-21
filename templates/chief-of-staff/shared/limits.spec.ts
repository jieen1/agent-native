/**
 * Unit tests for the briefing size limits (docs/IMPLEMENTATION_PLAN.md
 * §1.5.18 "有上限": named constants are referenced; over-limit content is
 * truncated and marked).
 */
import { describe, expect, it } from "vitest";
import {
  MAX_PER_SOURCE_CHARS,
  MAX_BRIEFING_BYTES,
  TRUNCATION_MARKER,
  truncateSourceText,
  byteLength,
} from "./limits.js";

describe("size limit constants", () => {
  it("are positive and ordered (per-source < whole-briefing budget)", () => {
    expect(MAX_PER_SOURCE_CHARS).toBeGreaterThan(0);
    expect(MAX_BRIEFING_BYTES).toBeGreaterThan(MAX_PER_SOURCE_CHARS);
  });
});

describe("truncateSourceText", () => {
  it("leaves short text untouched and unmarked", () => {
    const { text, truncated } = truncateSourceText("hello");
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });

  it("truncates a 50KB input to <= MAX_PER_SOURCE_CHARS (plus marker) and marks it", () => {
    const big = "x".repeat(50_000);
    const { text, truncated } = truncateSourceText(big);
    expect(truncated).toBe(true);
    expect(text.endsWith(TRUNCATION_MARKER)).toBe(true);
    // The retained body is exactly the cap; the only extra is the marker.
    expect(text.length).toBe(MAX_PER_SOURCE_CHARS + TRUNCATION_MARKER.length);
    expect(text.slice(0, MAX_PER_SOURCE_CHARS)).toBe(
      big.slice(0, MAX_PER_SOURCE_CHARS),
    );
  });

  it("honors a caller-supplied cap", () => {
    const { text, truncated } = truncateSourceText("abcdef", 3);
    expect(truncated).toBe(true);
    expect(text).toBe(`abc${TRUNCATION_MARKER}`);
  });
});

describe("byteLength", () => {
  it("measures UTF-8 bytes, not code units", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("é")).toBe(2); // é is 2 bytes in UTF-8
  });
});
