// F7 model registry unit tests (04 §7, SDLC-054):
//   T-F7-01 — a claude-* alias registered against a non-Claude weight is
//     rejected (alias-forbidden), with zero writes.
//   T-F7-02 — re-registering an existing alias against a DIFFERENT realName
//     ("alias drift") succeeds and writes a registry.alias-changed v3_event.
//   T-F7-06 — the reverse alias -> realName lookup used for spawn
//     attribution; an unregistered alias returns itself + suspect:true.
//
// `drizzle-orm`'s eq/and/desc are stubbed to plain marker objects (this
// module's mock `.where()`/`.orderBy()` below never inspects them — the
// canned `selectResults` queue IS the fake DB's "query result") so the test
// never depends on v3Schema's columns being real Drizzle Column objects.

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ __eq: [a, b] }),
  and: (...conds: unknown[]) => ({ __and: conds }),
  desc: (a: unknown) => ({ __desc: a }),
}));

const dbMocks = vi.hoisted(() => ({
  getV3Db: vi.fn(),
  resolveOwnerEmail: vi.fn(),
}));

vi.mock("./db/index.js", () => ({
  getV3Db: dbMocks.getV3Db,
  // Any property access returns a placeholder — fine, since the stubbed
  // eq/and/desc above never actually read column internals.
  v3Schema: new Proxy(
    {},
    {
      get: () => new Proxy({}, { get: (_t, p) => String(p) }),
    },
  ),
  resolveOwnerEmail: dbMocks.resolveOwnerEmail,
}));

import {
  upsertModel,
  resolveRealName,
  listRecentAliasChanges,
  assertAliasAllowed,
  AliasForbiddenError,
} from "./model-registry.js";

/** A fake DB whose `.select().from().where().limit()` returns queued results
 * in call order, and whose `.insert()`/`.update()` record every write so
 * tests can assert on them directly. Mirrors v3-dispatcher.spec.ts's
 * createMockDb — ignore the query shape, script the results. Also supports
 * the `.where().orderBy().limit()` chain listRecentAliasChanges uses
 * (`.where().orderBy` is additive alongside the pre-existing `.where().limit`
 * and sibling `.from().orderBy` shapes — neither prior caller is affected). */
function createMockDb(selectResults: unknown[][] = []) {
  let selectCall = 0;
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectResults[selectCall++] ?? [],
          orderBy: () => ({
            limit: async () => selectResults[selectCall++] ?? [],
          }),
        }),
        orderBy: async () => selectResults[selectCall++] ?? [],
      }),
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updated.push(set);
          return {};
        },
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return {};
      },
    }),
  };
  return { db: db as any, inserted, updated };
}

beforeEach(() => {
  dbMocks.getV3Db.mockReset();
  dbMocks.resolveOwnerEmail.mockReset();
  dbMocks.resolveOwnerEmail.mockReturnValue("local@localhost");
});

// ── T-F7-01: fake-name rejection ────────────────────────────────────────────

describe("assertAliasAllowed / upsertModel — fake-name rejection (T-F7-01)", () => {
  it("pure assertAliasAllowed: claude-* requires isClaudeWeight true", () => {
    expect(() => assertAliasAllowed("claude-opus-4-8", true)).not.toThrow();
    expect(() => assertAliasAllowed("claude-x", false)).toThrow(
      AliasForbiddenError,
    );
    expect(() => assertAliasAllowed("qwen3.6", false)).not.toThrow();
  });

  it("upsertModel rejects alias='claude-x' isClaudeWeight=false with ZERO writes", async () => {
    const { db, inserted, updated } = createMockDb([[]]);
    dbMocks.getV3Db.mockReturnValue(db);

    await expect(
      upsertModel({
        realName: "SomeLocalWeight",
        alias: "claude-x",
        isClaudeWeight: false,
      }),
    ).rejects.toThrow(AliasForbiddenError);

    expect(inserted).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it("a REAL claude weight may register a claude-* alias", async () => {
    const { db, inserted } = createMockDb([[]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await upsertModel({
      realName: "claude-opus-4-8",
      alias: "claude-opus-4-8",
      isClaudeWeight: true,
    });

    expect(result.aliasChanged).toBe(false);
    const registryRows = inserted.filter((r) => r.kind === undefined);
    expect(registryRows).toHaveLength(1); // registry row insert
    // A fresh insert returns the REAL generated id, not an opaque placeholder,
    // and it matches the row actually written.
    expect(result.id).toBe(registryRows[0].id);
    expect(result.id).not.toBe("(pending)");
    expect(typeof result.id).toBe("string");
  });
});

// ── T-F7-02: alias drift event ──────────────────────────────────────────────

describe("upsertModel — alias drift event (T-F7-02)", () => {
  it("same alias re-registered against a DIFFERENT realName writes registry.alias-changed", async () => {
    const prior = {
      id: "reg-1",
      alias: "qwen3.6",
      realName: "ThinkingCap-Qwen3.6-27B-v1",
    };
    const { db, inserted, updated } = createMockDb([[prior]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await upsertModel({
      realName: "ThinkingCap-Qwen3.6-27B-v2",
      alias: "qwen3.6",
      isClaudeWeight: false,
    });

    expect(result.aliasChanged).toBe(true);
    expect(result.previousRealName).toBe("ThinkingCap-Qwen3.6-27B-v1");
    // Updates the existing row rather than inserting a new one.
    expect(updated).toHaveLength(1);
    expect(updated[0].realName).toBe("ThinkingCap-Qwen3.6-27B-v2");

    const events = inserted.filter((r) => r.kind === "registry.alias-changed");
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({
      alias: "qwen3.6",
      previousRealName: "ThinkingCap-Qwen3.6-27B-v1",
      newRealName: "ThinkingCap-Qwen3.6-27B-v2",
    });
  });

  it("same alias re-registered against the SAME realName is a no-drift update (no event)", async () => {
    const prior = {
      id: "reg-1",
      alias: "qwen3.6",
      realName: "ThinkingCap-Qwen3.6-27B",
    };
    const { db, inserted } = createMockDb([[prior]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await upsertModel({
      realName: "ThinkingCap-Qwen3.6-27B",
      alias: "qwen3.6",
      isClaudeWeight: false,
    });

    expect(result.aliasChanged).toBe(false);
    expect(
      inserted.filter((r) => r.kind === "registry.alias-changed"),
    ).toHaveLength(0);
  });
});

// ── T-F7-06: real-name reverse-lookup for spawn attribution ────────────────

describe("resolveRealName — attribution reverse-lookup (T-F7-06)", () => {
  it("registered alias resolves to its real weight name, not suspect", async () => {
    const { db } = createMockDb([[{ realName: "ThinkingCap-Qwen3.6-27B" }]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await resolveRealName("qwen3.6", "local@localhost");
    expect(result.realName).toBe("ThinkingCap-Qwen3.6-27B");
    expect(result.suspect).toBe(false);
  });

  it("unregistered alias returns itself as a best-effort label AND suspect=true", async () => {
    const { db } = createMockDb([[]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await resolveRealName("mystery-model", "local@localhost");
    expect(result.realName).toBe("mystery-model");
    expect(result.suspect).toBe(true);
  });

  it("null/undefined modelRef resolves to null, not suspect (nothing to attribute)", async () => {
    const { db } = createMockDb([]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await resolveRealName(null, "local@localhost");
    expect(result.realName).toBeNull();
    expect(result.suspect).toBe(false);
  });
});

// ── S9 model-registry card's alias-drift banner (04 §7 "别名漂移可见") ──────

describe("listRecentAliasChanges — alias-drift banner (S9)", () => {
  it("empty when there are no alias-change events", async () => {
    const { db } = createMockDb([[]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await listRecentAliasChanges(7);
    expect(result).toEqual({ events: [], recentCount: 0 });
  });

  it("maps event rows to the alias/previousRealName/newRealName/ts shape", async () => {
    const row = {
      id: "ev-1",
      payload: {
        alias: "qwen3.6",
        previousRealName: "OldWeight",
        newRealName: "NewWeight",
      },
      ts: new Date(),
    };
    const { db } = createMockDb([[row]]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await listRecentAliasChanges(7);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      alias: "qwen3.6",
      previousRealName: "OldWeight",
      newRealName: "NewWeight",
    });
    expect(result.recentCount).toBe(1);
  });

  it("counts only events within the trailing windowDays as 'recent'", async () => {
    const now = Date.now();
    const rows = [
      {
        id: "ev-recent",
        payload: { alias: "qwen3.6", previousRealName: "a", newRealName: "b" },
        ts: new Date(now - 1 * 24 * 3600 * 1000),
      },
      {
        id: "ev-old",
        payload: { alias: "qwen3.6", previousRealName: "b", newRealName: "c" },
        ts: new Date(now - 30 * 24 * 3600 * 1000),
      },
    ];
    const { db } = createMockDb([rows]);
    dbMocks.getV3Db.mockReturnValue(db);

    const result = await listRecentAliasChanges(7);
    expect(result.events).toHaveLength(2); // full list still returned...
    expect(result.recentCount).toBe(1); // ...but only 1 counts as "recent"
  });
});
