/**
 * Unit tests for deep-link extraction (docs/IMPLEMENTATION_PLAN.md §1.5.12).
 *
 * Rules under test:
 *   - markdown links ∪ bare URLs are both collected,
 *   - de-duplicated (preserving first-seen order),
 *   - scoped to the source app's own origin (off-origin links dropped),
 *   - rooted relative paths completed against the app base URL,
 *   - no links → [] (panel then shows plain text, no dead button).
 */
import { describe, expect, it } from "vitest";
import { extractDeepLinks } from "./deep-links.js";

const MAIL = "http://localhost:8110";

describe("extractDeepLinks — collection", () => {
  it("pulls a markdown-link target on the source origin", () => {
    const text =
      "Reply to Dana: [open thread](http://localhost:8110/threads/abc).";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/abc",
    ]);
  });

  it("pulls a bare URL on the source origin", () => {
    const text = "See http://localhost:8110/threads/xyz for the latest.";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/xyz",
    ]);
  });

  it("collects both markdown and bare URLs in one reply", () => {
    const text =
      "[thread a](http://localhost:8110/threads/a) and bare " +
      "http://localhost:8110/threads/b need replies.";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/a",
      "http://localhost:8110/threads/b",
    ]);
  });
});

describe("extractDeepLinks — de-duplication", () => {
  it("returns each distinct URL once, first-seen order", () => {
    const text =
      "[thread a](http://localhost:8110/threads/a), again " +
      "http://localhost:8110/threads/a, then " +
      "http://localhost:8110/threads/c.";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/a",
      "http://localhost:8110/threads/c",
    ]);
  });
});

describe("extractDeepLinks — origin scoping", () => {
  it("drops links that point at a different host", () => {
    const text =
      "Mine: http://localhost:8110/threads/a — not mine: " +
      "http://localhost:8111/events/9 — external: https://evil.example.com/x";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/a",
    ]);
  });

  it("drops a different port on the same host (origin includes the port)", () => {
    const text = "http://localhost:9999/threads/a";
    expect(extractDeepLinks(text, MAIL)).toEqual([]);
  });
});

describe("extractDeepLinks — relative completion", () => {
  it("completes a rooted relative markdown link against the app base URL", () => {
    const text = "Standup notes: [open](/threads/rel-1).";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/rel-1",
    ]);
  });

  it("does not double-list a relative link and its absolute equivalent", () => {
    const text =
      "[open](/threads/rel-2) is the same as " +
      "http://localhost:8110/threads/rel-2.";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/rel-2",
    ]);
  });
});

describe("extractDeepLinks — empty / degraded", () => {
  it("returns [] when there are no links (panel shows plain text)", () => {
    expect(extractDeepLinks("Nothing needs you today.", MAIL)).toEqual([]);
  });

  it("returns [] for empty reply text", () => {
    expect(extractDeepLinks("", MAIL)).toEqual([]);
  });

  it("returns [] when the app base URL is unparseable", () => {
    expect(
      extractDeepLinks("http://localhost:8110/threads/a", "not-a-url"),
    ).toEqual([]);
  });

  it("strips trailing sentence punctuation off a bare URL", () => {
    const text = "Open http://localhost:8110/threads/z.";
    expect(extractDeepLinks(text, MAIL)).toEqual([
      "http://localhost:8110/threads/z",
    ]);
  });
});
