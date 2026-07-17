// R4a.3 §4.2 point 7 — claude-code worker-node concurrency settings module.
// Mirrors the shape a brain-concurrency.spec.ts would take (none exists
// today) since this is directly modeled on brain-concurrency.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return { store };
});

vi.mock("@agent-native/core/settings", () => ({
  getSetting: vi.fn(async (key: string) => hoisted.store.get(key) ?? null),
  putSetting: vi.fn(async (key: string, value: unknown) => {
    hoisted.store.set(key, value);
  }),
}));

import { getSetting } from "@agent-native/core/settings";

import {
  getClaudeCodeNodeConcurrency,
  setClaudeCodeNodeConcurrency,
  DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY,
  MIN_CLAUDE_CODE_NODE_CONCURRENCY,
  MAX_CLAUDE_CODE_NODE_CONCURRENCY,
  CLAUDE_CODE_NODE_CONCURRENCY_KEY,
} from "./claude-code-concurrency.js";

describe("claude-code-node-concurrency", () => {
  beforeEach(() => {
    hoisted.store.clear();
    vi.clearAllMocks();
  });

  it("defaults to 1 (the design's recommendation) when nothing is saved", async () => {
    expect(DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY).toBe(1);
    expect(await getClaudeCodeNodeConcurrency()).toBe(1);
  });

  it("persists and reads back a saved degree", async () => {
    const stored = await setClaudeCodeNodeConcurrency(3);
    expect(stored).toBe(3);
    expect(await getClaudeCodeNodeConcurrency()).toBe(3);
  });

  it("clamps a degree above MAX down to MAX on save", async () => {
    const stored = await setClaudeCodeNodeConcurrency(
      MAX_CLAUDE_CODE_NODE_CONCURRENCY + 50,
    );
    expect(stored).toBe(MAX_CLAUDE_CODE_NODE_CONCURRENCY);
  });

  it("clamps a degree below MIN up to MIN on save", async () => {
    const stored = await setClaudeCodeNodeConcurrency(0);
    expect(stored).toBe(MIN_CLAUDE_CODE_NODE_CONCURRENCY);
  });

  it("clamps a negative degree up to MIN on save", async () => {
    const stored = await setClaudeCodeNodeConcurrency(-10);
    expect(stored).toBe(MIN_CLAUDE_CODE_NODE_CONCURRENCY);
  });

  it("truncates a fractional degree before clamping", async () => {
    const stored = await setClaudeCodeNodeConcurrency(4.9);
    expect(stored).toBe(4);
  });

  it("falls back to the default when the stored value is malformed (non-integer)", async () => {
    hoisted.store.set(CLAUDE_CODE_NODE_CONCURRENCY_KEY, {
      degree: "not-a-number",
    });
    expect(await getClaudeCodeNodeConcurrency()).toBe(
      DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY,
    );
  });

  it("clamps a stored value above MAX down to MAX on read", async () => {
    hoisted.store.set(CLAUDE_CODE_NODE_CONCURRENCY_KEY, { degree: 999 });
    expect(await getClaudeCodeNodeConcurrency()).toBe(
      MAX_CLAUDE_CODE_NODE_CONCURRENCY,
    );
  });

  it("falls back to the default when getSetting throws (never blocks admission)", async () => {
    vi.mocked(getSetting).mockRejectedValueOnce(new Error("db down"));
    expect(await getClaudeCodeNodeConcurrency()).toBe(
      DEFAULT_CLAUDE_CODE_NODE_CONCURRENCY,
    );
  });
});
