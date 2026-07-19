// Pins the orchestrator's MCP `connectorCatalog` — the curated tool
// allow-list that keeps the brain (and any other non-full-catalog MCP caller)
// off the full ~187-tool catalog. See `server/brain/brain-mcp-config.ts` for
// why: the brain used to mint its token with `catalog_scope: "full"`, which
// bypasses this catalog entirely and caused a real production failure (an
// Aliyun endpoint's schema validator rejected one of the 187 tools' JSON
// schema and killed the whole turn). This spec doesn't re-test the framework
// connector-catalog MECHANISM (see packages/core/src/mcp/connector-catalog.spec.ts
// for that) — it pins that THIS app's `createAgentChatPlugin` call actually
// declares the intended curated list, so a future edit can't silently widen or
// shrink it without a failing test.
//
// `.generated/actions-registry.js` doesn't exist on disk (it's a build-time
// codegen artifact), and `createAgentChatPlugin` does heavy framework
// composition — both are mocked so this stays a fast, isolated unit test.

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  capturedOptions: null as Record<string, unknown> | null,
}));

vi.mock("@agent-native/core/server", () => ({
  createAgentChatPlugin: vi.fn((options: Record<string, unknown>) => {
    hoisted.capturedOptions = options;
    return () => {};
  }),
  loadActionsFromStaticRegistry: vi.fn(() => ({})),
}));

vi.mock("@agent-native/core/org", () => ({
  getOrgContext: vi.fn(async () => ({ orgId: null })),
}));

vi.mock("../../.generated/actions-registry.js", () => ({ default: {} }));

describe("orchestrator agent-chat plugin — MCP connectorCatalog", () => {
  const OLD_OPENAI_BASE_URL = process.env.OPENAI_BASE_URL;

  beforeEach(async () => {
    // Keep registerVllmEngine()/getVllmEngine() as no-ops (real, unmocked
    // module) — both early-return when OPENAI_BASE_URL is unset.
    delete process.env.OPENAI_BASE_URL;
    vi.resetModules();
    await import("./agent-chat.js");
  });

  afterAll(() => {
    if (OLD_OPENAI_BASE_URL === undefined) {
      delete process.env.OPENAI_BASE_URL;
    } else {
      process.env.OPENAI_BASE_URL = OLD_OPENAI_BASE_URL;
    }
  });

  it("does not request the full MCP catalog and declares a curated connectorCatalog", () => {
    const options = hoisted.capturedOptions;
    expect(options).not.toBeNull();
    expect(Array.isArray(options!.connectorCatalog)).toBe(true);
    const catalog = options!.connectorCatalog as string[];

    // Curated, not the full ~187-tool surface.
    expect(catalog.length).toBeGreaterThan(0);
    expect(catalog.length).toBeLessThan(40);
  });

  it("includes navigate/view-screen plus the brain's real V3 tool surface", () => {
    const catalog = hoisted.capturedOptions!.connectorCatalog as string[];
    const expectedPresent = [
      // Navigation/context.
      "navigate",
      "view-screen",
      // Author + run a DAG.
      "workflowRun",
      "workflowList",
      "workflowSave",
      "workflowPatch",
      // One-shot / iterate.
      "spawnOnce",
      "runFork",
      // Monitor.
      "runState",
      "v3RunEvents",
      "v3RunNodes",
      "runSummary",
      "nodeSummary",
      // Inspect.
      "runsList",
      "workspaceList",
      "workspaceDiff",
      "workspaceFiles",
      "workspaceRead",
      // Review verdict — the run-level evidence trail (brain-prompt.ts
      // "# Your tools" + review-thread.ts's wake message both call this).
      "runVerdict",
      // Deliver.
      "workspaceCreate",
      "workspaceCommitPush",
      "workspaceCommit",
      "workspaceCiWatch",
      "workspaceMergePr",
      // Independent pre-merge review gate.
      "mergeReviewStart",
      "mergeReviewGet",
    ];
    for (const name of expectedPresent) {
      expect(catalog).toContain(name);
    }
  });

  it("never includes the human-only mergeReviewOverride action", () => {
    const catalog = hoisted.capturedOptions!.connectorCatalog as string[];
    expect(catalog).not.toContain("mergeReviewOverride");
  });

  it("never includes raw DB tools or other connector-tier footguns", () => {
    const catalog = hoisted.capturedOptions!.connectorCatalog as string[];
    for (const name of ["db-query", "db-exec", "db-patch", "db-schema"]) {
      expect(catalog).not.toContain(name);
    }
  });

  it("does not need tool-search / list_apps / ask_app declared explicitly — they are always-on builtins", () => {
    // COMPACT_MCP_APP_CATALOG_BUILTINS (packages/core/src/mcp/build-server.ts)
    // always includes tool-search + the cross-app builtins regardless of
    // connectorCatalog, so the curated list intentionally omits them.
    const catalog = hoisted.capturedOptions!.connectorCatalog as string[];
    expect(catalog).not.toContain("tool-search");
    expect(catalog).not.toContain("list_apps");
    expect(catalog).not.toContain("ask_app");
  });
});
