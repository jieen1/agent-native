// resolveBrainRunbookPrompt — the missing link that makes the Skills page's
// pinned "大脑运行手册" (Brain Runbook) editor actually affect a live brain
// turn. Before this, get-skill/save-skill/revert-skill only read/wrote
// orchestrator_skill_overrides; nothing at turn-build time ever consulted it.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  return {
    row: null as { content: string } | null,
    shouldThrow: false,
  };
});

vi.mock("../db/index.js", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (hoisted.shouldThrow) throw new Error("db down");
            return hoisted.row ? [hoisted.row] : [];
          },
        }),
      }),
    }),
  }),
  schema: {
    skillOverrides: { path: "path", content: "content" },
  },
}));

import { resolveBrainRunbookPrompt } from "./brain-prompt.js";

describe("resolveBrainRunbookPrompt", () => {
  beforeEach(() => {
    hoisted.row = null;
    hoisted.shouldThrow = false;
  });

  it("returns the default when no override row exists", async () => {
    expect(await resolveBrainRunbookPrompt("DEFAULT TEXT")).toBe(
      "DEFAULT TEXT",
    );
  });

  it("returns the saved override content when one exists", async () => {
    hoisted.row = { content: "# Custom runbook\n\n1. Do the thing." };
    expect(await resolveBrainRunbookPrompt("DEFAULT TEXT")).toBe(
      "# Custom runbook\n\n1. Do the thing.",
    );
  });

  it("falls back to the default when the saved override is empty/whitespace-only", async () => {
    hoisted.row = { content: "   \n  " };
    expect(await resolveBrainRunbookPrompt("DEFAULT TEXT")).toBe(
      "DEFAULT TEXT",
    );
  });

  it("degrades to the default when the DB lookup throws (never blocks a turn)", async () => {
    hoisted.shouldThrow = true;
    expect(await resolveBrainRunbookPrompt("DEFAULT TEXT")).toBe(
      "DEFAULT TEXT",
    );
  });
});
