// statusVocabPresentation — maps V3 run/node statuses onto the Foundry
// status vocabulary (StatusRing for in-progress, StatusIcon for terminal),
// replacing the plain solid-dot marker (s7-run-detail parity gap #3).

import { describe, it, expect } from "vitest";

import { statusVocabPresentation } from "./v3-format.js";

describe("statusVocabPresentation", () => {
  it("maps in-progress-family statuses to StatusRing", () => {
    expect(statusVocabPresentation("pending")).toEqual({
      el: "ring",
      status: "pending",
    });
    expect(statusVocabPresentation("ready")).toEqual({
      el: "ring",
      status: "queued",
    });
    expect(statusVocabPresentation("running")).toEqual({
      el: "ring",
      status: "running",
    });
    expect(statusVocabPresentation("awaiting-approval")).toEqual({
      el: "ring",
      status: "gate",
    });
    expect(statusVocabPresentation("skipped")).toEqual({
      el: "ring",
      status: "skipped",
    });
  });

  it("maps terminal-family statuses to StatusIcon", () => {
    expect(statusVocabPresentation("done")).toEqual({ el: "icon", tone: "ok" });
    expect(statusVocabPresentation("failed")).toEqual({
      el: "icon",
      tone: "err",
    });
    expect(statusVocabPresentation("cancelled")).toEqual({
      el: "icon",
      tone: "mut",
    });
  });

  it("falls back to a pending ring for an unknown status rather than throwing", () => {
    expect(statusVocabPresentation("some-future-status")).toEqual({
      el: "ring",
      status: "pending",
    });
  });
});
