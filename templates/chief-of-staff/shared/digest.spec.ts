/**
 * Unit tests for the pure briefing-digest helpers (no LLM, no I/O).
 * Covers status derivation, default titles, today date, and the no-LLM
 * fallback summary (docs/IMPLEMENTATION_PLAN.md §1.5.3 / §1.5.20).
 */
import { describe, expect, it } from "vitest";
import {
  defaultTitle,
  deriveStatus,
  deterministicDigest,
  todayLocalDate,
} from "./digest.js";
import type { BriefingSource } from "./types.js";

function src(
  over: Partial<BriefingSource> & Pick<BriefingSource, "app" | "status">,
): BriefingSource {
  return {
    prompt: "",
    responseText: "",
    deepLinks: [],
    latencyMs: 0,
    ...over,
  };
}

describe("deriveStatus", () => {
  it("returns failed for an empty source list", () => {
    expect(deriveStatus([])).toBe("failed");
  });

  it("returns complete when every source is ok", () => {
    expect(
      deriveStatus([
        src({ app: "mail", status: "ok" }),
        src({ app: "calendar", status: "ok" }),
      ]),
    ).toBe("complete");
  });

  it("returns partial when some ok and some not", () => {
    expect(
      deriveStatus([
        src({ app: "mail", status: "ok" }),
        src({ app: "calendar", status: "timeout" }),
      ]),
    ).toBe("partial");
  });

  it("returns failed when no source is ok (all error/timeout/skipped)", () => {
    expect(
      deriveStatus([
        src({ app: "mail", status: "error" }),
        src({ app: "calendar", status: "skipped" }),
      ]),
    ).toBe("failed");
  });
});

describe("defaultTitle", () => {
  it("labels morning / evening / adhoc with the date", () => {
    expect(defaultTitle("morning", "2026-06-21")).toBe(
      "Morning briefing — 2026-06-21",
    );
    expect(defaultTitle("evening", "2026-06-21")).toBe(
      "Evening recap — 2026-06-21",
    );
    expect(defaultTitle("adhoc", "2026-06-21")).toBe("Briefing — 2026-06-21");
  });
});

describe("todayLocalDate", () => {
  it("formats a fixed local date as YYYY-MM-DD", () => {
    const d = new Date(2026, 5, 7, 9, 30); // 2026-06-07 local
    expect(todayLocalDate(d)).toBe("2026-06-07");
  });
});

describe("deterministicDigest", () => {
  it("explains an empty briefing without throwing", () => {
    expect(deterministicDigest([])).toMatch(/no sources/i);
  });

  it("stitches one markdown section per source, including raw ok text", () => {
    const md = deterministicDigest([
      src({ app: "mail", status: "ok", responseText: "Reply to Dana." }),
      src({ app: "calendar", status: "timeout", error: "slow" }),
      src({ app: "brain", status: "skipped" }),
    ]);
    expect(md).toContain("## Mail");
    expect(md).toContain("Reply to Dana.");
    expect(md).toContain("## Calendar (timed out)");
    expect(md).toContain("## Brain (not connected)");
  });

  it("is a stitch, not prose — it surfaces the literal source text verbatim", () => {
    const unique = "MARKER-7f3c raw passthrough";
    const md = deterministicDigest([
      src({ app: "mail", status: "ok", responseText: unique }),
    ]);
    expect(md).toContain(unique);
  });
});
