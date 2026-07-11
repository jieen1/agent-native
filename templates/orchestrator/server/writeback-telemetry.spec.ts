// F9 (orchestrator half) — writeback-telemetry.ts unit tests.
//
// T-F9-06 requires "S10 计数+1" once a writeback.failed event lands — this
// file verifies `computeWritebackTelemetry` reads that event kind correctly
// (the live end-to-end chain — reconciler retries exhaust, writes the event,
// health-telemetry action reflects it — is covered by v3-reconciler.spec.ts's
// T-F9-06 test at the "event got written" layer; this file covers the
// "counting query reads it back correctly" layer).

import { describe, it, expect, vi, beforeEach } from "vitest";

interface MockEventRow {
  id: string;
  runId: string | null;
  spawnId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  seqNum: number | null;
  ts: Date;
  ownerEmail: string;
  orgId: string | null;
}

const hoisted = vi.hoisted(() => {
  const events: MockEventRow[] = [];
  return { events };
});

// Real `v3Schema` (unmocked) so `like(v3Events.kind, ...)` / `gte(v3Events.ts,
// ...)` in the module under test build against genuine Drizzle Column objects
// — only `getV3Db` is replaced with an in-memory stand-in. Mirrors the
// duck-typing approach `v3-reconciler.spec.ts` uses (real table objects,
// checked by a unique column name) rather than faking the schema module.
vi.mock("./db/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db/index.js")>();
  function isEventsTable(table: unknown): boolean {
    return (
      table !== null &&
      typeof table === "object" &&
      "seqNum" in (table as object)
    );
  }
  return {
    ...actual,
    getV3Db: vi.fn(() => ({
      select: () => ({
        from: (table: unknown) => ({
          where: (_filter: unknown) => ({
            limit: (n: number) =>
              isEventsTable(table) ? hoisted.events.slice(0, n) : [],
          }),
        }),
      }),
    })),
  };
});

import { computeWritebackTelemetry } from "./writeback-telemetry.js";

function makeEvent(overrides: Partial<MockEventRow> = {}): MockEventRow {
  return {
    id: "ev-1",
    runId: "run-1",
    spawnId: null,
    kind: "writeback.run-meta",
    payload: {},
    seqNum: 1,
    ts: new Date(),
    ownerEmail: "local@localhost",
    orgId: null,
    ...overrides,
  };
}

describe("computeWritebackTelemetry", () => {
  beforeEach(() => {
    hoisted.events.length = 0;
  });

  it("all-zero when there are no writeback events", async () => {
    const result = await computeWritebackTelemetry(24);
    expect(result).toEqual({
      writebackFailed: 0,
      writebackStageMismatch: 0,
      writebackOther: 0,
      windowHours: 24,
    });
  });

  it("counts writeback.failed distinctly (T-F9-06: S10 计数+1)", async () => {
    hoisted.events.push(makeEvent({ kind: "writeback.failed" }));
    const result = await computeWritebackTelemetry(24);
    expect(result.writebackFailed).toBe(1);
  });

  it("counts writeback.stage-mismatch distinctly from failures", async () => {
    hoisted.events.push(makeEvent({ kind: "writeback.stage-mismatch" }));
    const result = await computeWritebackTelemetry(24);
    expect(result.writebackStageMismatch).toBe(1);
    expect(result.writebackFailed).toBe(0);
  });

  it("buckets other writeback.* kinds (run-meta/exec-state) as 'other'", async () => {
    hoisted.events.push(
      makeEvent({ kind: "writeback.run-meta" }),
      makeEvent({ kind: "writeback.exec-state" }),
    );
    const result = await computeWritebackTelemetry(24);
    expect(result.writebackOther).toBe(2);
  });

  it("mixed window: failed + mismatch + other counted independently", async () => {
    hoisted.events.push(
      makeEvent({ kind: "writeback.failed" }),
      makeEvent({ kind: "writeback.failed" }),
      makeEvent({ kind: "writeback.stage-mismatch" }),
      makeEvent({ kind: "writeback.run-meta" }),
    );
    const result = await computeWritebackTelemetry(24);
    expect(result).toEqual({
      writebackFailed: 2,
      writebackStageMismatch: 1,
      writebackOther: 1,
      windowHours: 24,
    });
  });
});
