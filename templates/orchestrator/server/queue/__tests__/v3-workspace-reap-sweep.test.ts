// Unit tests for the V3 workspace reap sweep
// (server/queue/v3-workspace-reap-sweep.ts).
//
// Root cause under test: destroyLocalWorkspace() correctly rm -rf's a
// workspace's checkout when called, but nothing ever called it automatically
// once a workspace's work concluded — every workspace piled up on disk
// forever (the exact 2026-07-20 disk-full incident, recurring). These tests
// mock the DB layer (getV3Db().execute + isPostgres) and destroyLocalWorkspace
// itself, asserting only on this module's OWN decision logic:
//   - no-ops when V3 Postgres isn't configured (no query attempted)
//   - a workspace with an active (non-terminal) run is left alone
//   - a workspace whose runs are all terminal but within the grace period is
//     left alone
//   - a workspace whose runs are all terminal AND past the grace period gets
//     destroyLocalWorkspace() called exactly once
//   - a workspace with ZERO runs ever recorded is reclaimed once its own
//     createdAt is past the grace period (vacuously "all terminal")
//   - one workspace's destroy failure never blocks the rest of the sweep
//   - env-driven interval/grace getters parse overrides and fall back to
//     their documented defaults

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockIsConfigured = true;
let mockRows: Array<Record<string, unknown>> = [];
let mockExecuteImpl: (() => Promise<unknown>) | null = null;
let lastExecutedQuery: unknown = null;
const destroyLocalWorkspaceMock = vi.fn(async (_id: string) => {});

vi.mock("@agent-native/core/db", () => ({
  isPostgres: () => mockIsConfigured,
}));

vi.mock("../../db/index.js", () => ({
  getV3Db: () => ({
    execute: (query: unknown) => {
      lastExecutedQuery = query;
      return mockExecuteImpl ? mockExecuteImpl() : Promise.resolve(mockRows);
    },
  }),
}));

vi.mock("../../v3-workspace-local.js", () => ({
  destroyLocalWorkspace: (id: string) => destroyLocalWorkspaceMock(id),
}));

import {
  reapStaleWorkspacesOnce,
  defaultWorkspaceReapIntervalMs,
  defaultWorkspaceReapGraceMs,
  RECLAIMABLE_WORKSPACE_STATES,
} from "../v3-workspace-reap-sweep.js";

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();

function isoAgo(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe("reapStaleWorkspacesOnce", () => {
  beforeEach(() => {
    mockIsConfigured = true;
    mockRows = [];
    mockExecuteImpl = null;
    lastExecutedQuery = null;
    destroyLocalWorkspaceMock.mockClear();
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  // Codex review 2026-07-23: this sweep's automatic rm -rf introduced a new
  // risk — a workspace held by an active brain THREAD (no v3_spawns row yet,
  // e.g. analysis phase, or a slow post-run review/commit turn) could be
  // reclaimed out from under a live session because the v3_spawns join alone
  // never sees it. The real exclusion lives in the SQL itself (a real
  // Postgres query, mocked here), so this asserts the query text actually
  // carries the brain_threads guard rather than re-deriving it in JS.
  it("candidate query excludes workspaces referenced by a non-terminal brain_threads row", async () => {
    await reapStaleWorkspacesOnce();
    const queryText = JSON.stringify(
      (lastExecutedQuery as { queryChunks?: unknown })?.queryChunks ??
        lastExecutedQuery,
    );
    expect(queryText).toContain("brain_threads");
    expect(queryText).toContain("bt.workspace_id = w.id");
    expect(queryText).toMatch(/bt\.status NOT IN \('done', ?'error'\)/);
  });

  it("no-ops when V3 Postgres isn't configured", async () => {
    mockIsConfigured = false;
    mockExecuteImpl = () => {
      throw new Error("must not query when unconfigured");
    };
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual([]);
    expect(destroyLocalWorkspaceMock).not.toHaveBeenCalled();
  });

  it("leaves a workspace alone when it still has an active (non-terminal) run", async () => {
    mockRows = [
      {
        id: "ws-active",
        created_at: isoAgo(10 * HOUR_MS),
        active_run_count: 1,
        last_run_completed_at: null,
      },
    ];
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual([]);
    expect(destroyLocalWorkspaceMock).not.toHaveBeenCalled();
  });

  it("leaves a workspace alone when all runs are terminal but still within the grace period", async () => {
    mockRows = [
      {
        id: "ws-recent",
        created_at: isoAgo(10 * HOUR_MS),
        active_run_count: 0,
        last_run_completed_at: isoAgo(30 * 60 * 1000), // 30 minutes ago
      },
    ];
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual([]);
    expect(destroyLocalWorkspaceMock).not.toHaveBeenCalled();
  });

  it("reclaims a workspace whose runs are all terminal and past the grace period", async () => {
    mockRows = [
      {
        id: "ws-stale",
        created_at: isoAgo(10 * HOUR_MS),
        active_run_count: 0,
        last_run_completed_at: isoAgo(3 * HOUR_MS), // past the 2h default grace
      },
    ];
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual(["ws-stale"]);
    expect(destroyLocalWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(destroyLocalWorkspaceMock).toHaveBeenCalledWith("ws-stale");
  });

  it("reclaims a workspace with ZERO runs ever recorded once its own createdAt is past the grace period", async () => {
    mockRows = [
      {
        id: "ws-never-used",
        created_at: isoAgo(3 * HOUR_MS),
        active_run_count: 0,
        last_run_completed_at: null,
      },
    ];
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual(["ws-never-used"]);
    expect(destroyLocalWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(destroyLocalWorkspaceMock).toHaveBeenCalledWith("ws-never-used");
  });

  it("a never-used workspace still within its own grace period is left alone", async () => {
    mockRows = [
      {
        id: "ws-brand-new",
        created_at: isoAgo(5 * 60 * 1000),
        active_run_count: 0,
        last_run_completed_at: null,
      },
    ];
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual([]);
    expect(destroyLocalWorkspaceMock).not.toHaveBeenCalled();
  });

  it("one workspace's destroy failure never blocks the rest of the sweep", async () => {
    mockRows = [
      {
        id: "ws-fails",
        created_at: isoAgo(10 * HOUR_MS),
        active_run_count: 0,
        last_run_completed_at: isoAgo(3 * HOUR_MS),
      },
      {
        id: "ws-ok",
        created_at: isoAgo(10 * HOUR_MS),
        active_run_count: 0,
        last_run_completed_at: isoAgo(3 * HOUR_MS),
      },
    ];
    destroyLocalWorkspaceMock.mockImplementationOnce(async () => {
      throw new Error("disk error");
    });
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual(["ws-ok"]);
    expect(destroyLocalWorkspaceMock).toHaveBeenCalledTimes(2);
  });

  it("degrades to an empty sweep (never throws) when the candidate query fails", async () => {
    mockExecuteImpl = () => Promise.reject(new Error("db down"));
    const result = await reapStaleWorkspacesOnce();
    expect(result).toEqual([]);
    expect(destroyLocalWorkspaceMock).not.toHaveBeenCalled();
  });
});

describe("defaultWorkspaceReapIntervalMs / defaultWorkspaceReapGraceMs", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.V3_WORKSPACE_REAP_INTERVAL_MS;
    delete process.env.V3_WORKSPACE_REAP_GRACE_MS;
  });

  it("defaults to 5 minutes / 2 hours when unset", () => {
    expect(defaultWorkspaceReapIntervalMs()).toBe(300_000);
    expect(defaultWorkspaceReapGraceMs()).toBe(2 * HOUR_MS);
  });

  it("parses valid env overrides", () => {
    process.env.V3_WORKSPACE_REAP_INTERVAL_MS = "60000";
    process.env.V3_WORKSPACE_REAP_GRACE_MS = "600000";
    expect(defaultWorkspaceReapIntervalMs()).toBe(60_000);
    expect(defaultWorkspaceReapGraceMs()).toBe(600_000);
  });

  it("falls back to defaults on invalid/non-positive env values", () => {
    process.env.V3_WORKSPACE_REAP_INTERVAL_MS = "not-a-number";
    process.env.V3_WORKSPACE_REAP_GRACE_MS = "-5";
    expect(defaultWorkspaceReapIntervalMs()).toBe(300_000);
    expect(defaultWorkspaceReapGraceMs()).toBe(2 * HOUR_MS);
  });
});

describe("RECLAIMABLE_WORKSPACE_STATES", () => {
  it("is exactly the one-off remediation script's candidate state set", () => {
    expect([...RECLAIMABLE_WORKSPACE_STATES].sort()).toEqual(
      ["destroying", "error", "failed", "ready"].sort(),
    );
  });
});
