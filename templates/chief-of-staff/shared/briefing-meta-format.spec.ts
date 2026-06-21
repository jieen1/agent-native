import { describe, expect, it } from "vitest";
import { buildBriefingMetaDescription } from "./briefing-meta-format.js";

describe("buildBriefingMetaDescription", () => {
  it("strips markdown markers to plain prose", () => {
    const out = buildBriefingMetaDescription(
      "## Mail\n\n**Reply to Dana** — see [the thread](https://mail.test/t/1).",
    );
    expect(out).toBe("Mail Reply to Dana — see the thread.");
    expect(out).not.toContain("#");
    expect(out).not.toContain("**");
    expect(out).not.toContain("https://");
  });

  it("truncates to <=160 chars on a word boundary with an ellipsis", () => {
    const long = `word ${"alpha ".repeat(60)}`.trim();
    const out = buildBriefingMetaDescription(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith("…")).toBe(true);
  });

  it("falls back to a generic description when empty", () => {
    expect(buildBriefingMetaDescription("   ")).toContain("Chief of Staff");
  });
});
