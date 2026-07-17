// R4a.3 §4.2 point 7 — claude-code worker-node admission gate.
//
// The core decision logic (countClaudeCodeNodesFromRows / canAdmitClaudeCodeNode)
// is pure and tested directly without a database, mirroring how this repo
// tests other *-gate.ts pure functions. admitClaudeCodeNode/
// countRunningClaudeCodeNodes are thin DB-backed wrappers around that logic,
// covered by mocking isPostgres + getDbExec + the concurrency setting.

import { describe, it, expect, vi, beforeEach } from "vitest";

const hoisted = vi.hoisted(() => {
  const runningRows: Array<{ nodeIdInDag: string; dag: unknown }> = [];
  let postgres = true;
  return {
    runningRows,
    getPostgres: () => postgres,
    setPostgres: (v: boolean) => {
      postgres = v;
    },
  };
});

vi.mock("@agent-native/core/db", () => ({
  isPostgres: vi.fn(() => hoisted.getPostgres()),
}));

vi.mock("../db/index.js", () => ({
  getDbExec: vi.fn(() => ({
    execute: vi.fn(async () => ({ rows: hoisted.runningRows })),
  })),
}));

vi.mock("./claude-code-concurrency.js", () => ({
  getClaudeCodeNodeConcurrency: vi.fn(async () => 1),
}));

import {
  countClaudeCodeNodesFromRows,
  canAdmitClaudeCodeNode,
  countRunningClaudeCodeNodes,
  admitClaudeCodeNode,
  type RunningAgentNodeRow,
} from "./claude-code-admit.js";
import { getClaudeCodeNodeConcurrency } from "./claude-code-concurrency.js";

const claudeCodeDag = {
  nodes: [
    { id: "review", type: "agent", agent: "claude-code", prompt: "review" },
  ],
};
const vllmDag = {
  nodes: [{ id: "dev", type: "agent", agent: "vllm", prompt: "dev" }],
};
const engineOverrideDag = {
  nodes: [
    {
      id: "x",
      type: "agent",
      agent: "custom",
      engine_override: "acp:claude-code",
      prompt: "p",
    },
  ],
};

describe("countClaudeCodeNodesFromRows (pure)", () => {
  it("counts a running node whose dag node has agent:'claude-code'", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "review", dag: claudeCodeDag },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(1);
  });

  it("counts a running node whose dag node has engine_override targeting claude-code", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "x", dag: engineOverrideDag },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(1);
  });

  it("does not count a non-claude-code worker node", () => {
    const rows: RunningAgentNodeRow[] = [{ nodeIdInDag: "dev", dag: vllmDag }];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(0);
  });

  it("sums across multiple rows/runs", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "review", dag: claudeCodeDag },
      { nodeIdInDag: "dev", dag: vllmDag },
      { nodeIdInDag: "x", dag: engineOverrideDag },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(2);
  });

  it("tolerates a JSON-string dag (defensive, mirrors validateDag's own tolerance)", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "review", dag: JSON.stringify(claudeCodeDag) },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(1);
  });

  it("skips a row whose node id is not found in its dag (no throw)", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "missing", dag: claudeCodeDag },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(0);
  });

  it("skips a row with malformed/unparseable dag (no throw)", () => {
    const rows: RunningAgentNodeRow[] = [
      { nodeIdInDag: "review", dag: "{not json" },
    ];
    expect(countClaudeCodeNodesFromRows(rows)).toBe(0);
  });
});

describe("canAdmitClaudeCodeNode (pure)", () => {
  it("admits when running count is below the limit", () => {
    expect(canAdmitClaudeCodeNode(0, 1)).toBe(true);
  });

  it("rejects when running count is AT the limit (default limit=1)", () => {
    expect(canAdmitClaudeCodeNode(1, 1)).toBe(false);
  });

  it("rejects when running count exceeds the limit", () => {
    expect(canAdmitClaudeCodeNode(5, 2)).toBe(false);
  });
});

describe("countRunningClaudeCodeNodes / admitClaudeCodeNode (DB-backed wrappers)", () => {
  beforeEach(() => {
    hoisted.runningRows.length = 0;
    hoisted.setPostgres(true);
    vi.clearAllMocks();
    vi.mocked(getClaudeCodeNodeConcurrency).mockResolvedValue(1);
  });

  it("returns 0 on non-Postgres (local dev) without querying", async () => {
    hoisted.setPostgres(false);
    expect(await countRunningClaudeCodeNodes()).toBe(0);
  });

  it("counts real rows fetched from the DB", async () => {
    hoisted.runningRows.push({ nodeIdInDag: "review", dag: claudeCodeDag });
    expect(await countRunningClaudeCodeNodes()).toBe(1);
  });

  it("admits when nothing is running", async () => {
    const result = await admitClaudeCodeNode();
    expect(result).toEqual({ admitted: true, running: 0, limit: 1 });
  });

  it("rejects when the configured limit (default 1) is already occupied", async () => {
    hoisted.runningRows.push({ nodeIdInDag: "review", dag: claudeCodeDag });
    const result = await admitClaudeCodeNode();
    expect(result).toEqual({ admitted: false, running: 1, limit: 1 });
  });

  it("always admits on non-Postgres regardless of configured limit", async () => {
    hoisted.setPostgres(false);
    const result = await admitClaudeCodeNode();
    expect(result.admitted).toBe(true);
  });

  it("admits again once the limit is raised", async () => {
    hoisted.runningRows.push({ nodeIdInDag: "review", dag: claudeCodeDag });
    vi.mocked(getClaudeCodeNodeConcurrency).mockResolvedValue(2);
    const result = await admitClaudeCodeNode();
    expect(result).toEqual({ admitted: true, running: 1, limit: 2 });
  });
});
