import { describe, expect, it } from "vitest";
import type { BriefingSource } from "@shared/types";
import {
  briefingNoticeKind,
  summarizeSourceProblems,
} from "./briefing-notice.js";

function src(
  over: Partial<BriefingSource> & Pick<BriefingSource, "app" | "status">,
): BriefingSource {
  return { prompt: "", responseText: "", deepLinks: [], latencyMs: 0, ...over };
}

describe("briefingNoticeKind", () => {
  it("returns 'failed' for a failed briefing", () => {
    expect(
      briefingNoticeKind("failed", [src({ app: "mail", status: "error" })]),
    ).toBe("failed");
  });

  it("returns 'partial' for a partial briefing", () => {
    expect(
      briefingNoticeKind("partial", [
        src({ app: "mail", status: "ok", responseText: "x" }),
        src({ app: "calendar", status: "timeout" }),
      ]),
    ).toBe("partial");
  });

  it("returns 'all-clear' when complete but no source reported content", () => {
    expect(
      briefingNoticeKind("complete", [
        src({ app: "mail", status: "ok", responseText: "  " }),
        src({ app: "calendar", status: "ok", responseText: "" }),
      ]),
    ).toBe("all-clear");
  });

  it("returns 'none' for a complete briefing that has content", () => {
    expect(
      briefingNoticeKind("complete", [
        src({ app: "mail", status: "ok", responseText: "Reply to Dana." }),
      ]),
    ).toBe("none");
  });

  it("returns 'none' for a still-compiling briefing", () => {
    expect(briefingNoticeKind("compiling", [])).toBe("none");
  });
});

describe("summarizeSourceProblems", () => {
  it("groups error / timeout / skipped sources by reason", () => {
    const out = summarizeSourceProblems([
      src({ app: "mail", status: "error" }),
      src({ app: "calendar", status: "timeout" }),
      src({ app: "analytics", status: "skipped" }),
      src({ app: "brain", status: "ok", responseText: "x" }),
    ]);
    expect(out).toBe(
      "couldn't reach mail; calendar timed out; analytics not connected",
    );
  });

  it("returns null when every source is ok", () => {
    expect(
      summarizeSourceProblems([
        src({ app: "mail", status: "ok", responseText: "x" }),
      ]),
    ).toBeNull();
  });
});
