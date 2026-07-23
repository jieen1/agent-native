// Unit tests for the V3 lifecycle cleanup sweep
// (server/queue/v3-lifecycle-sweep.ts).
//
// Root cause under test: runLifecycleCleanup() (server/lib/v3-lifecycle.ts)
// is fully correct — its own doc comment even calls it the "daily cron entry
// point" — but nothing in the running app ever called it (confirmed via a
// full repo-wide reference scan, 2026-07-23 SDLC audit). These tests assert
// only this module's OWN decision logic: when to call the already-correct
// cleanup function, and that a failure never escapes the timer tick.

import { beforeEach, describe, expect, it, vi } from "vitest";

let mockIsConfigured = true;
const runLifecycleCleanupMock = vi.fn();

vi.mock("@agent-native/core/db", () => ({
  isPostgres: () => mockIsConfigured,
}));

vi.mock("../../lib/v3-lifecycle.js", () => ({
  runLifecycleCleanup: () => runLifecycleCleanupMock(),
}));

import {
  lifecycleSweepOnce,
  defaultLifecycleSweepIntervalMs,
} from "../v3-lifecycle-sweep.js";

describe("lifecycleSweepOnce", () => {
  beforeEach(() => {
    mockIsConfigured = true;
    runLifecycleCleanupMock.mockReset();
  });

  it("no-ops when V3 Postgres isn't configured", async () => {
    mockIsConfigured = false;
    const result = await lifecycleSweepOnce();
    expect(result).toBeNull();
    expect(runLifecycleCleanupMock).not.toHaveBeenCalled();
  });

  it("calls the existing runLifecycleCleanup and returns its result unchanged", async () => {
    runLifecycleCleanupMock.mockResolvedValue({
      artifactsDeleted: 12,
      eventsDeleted: 340,
      expiredRuns: 3,
    });
    const result = await lifecycleSweepOnce();
    expect(runLifecycleCleanupMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      artifactsDeleted: 12,
      eventsDeleted: 340,
      expiredRuns: 3,
    });
  });

  it("degrades to null (never throws) when the cleanup call fails", async () => {
    runLifecycleCleanupMock.mockRejectedValue(new Error("db down"));
    const result = await lifecycleSweepOnce();
    expect(result).toBeNull();
  });
});

describe("defaultLifecycleSweepIntervalMs", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.V3_LIFECYCLE_SWEEP_INTERVAL_MS;
  });

  it("defaults to 6 hours when unset", () => {
    expect(defaultLifecycleSweepIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });

  it("parses a valid env override", () => {
    process.env.V3_LIFECYCLE_SWEEP_INTERVAL_MS = "60000";
    expect(defaultLifecycleSweepIntervalMs()).toBe(60_000);
  });

  it("falls back to the default on an invalid/non-positive env value", () => {
    process.env.V3_LIFECYCLE_SWEEP_INTERVAL_MS = "-5";
    expect(defaultLifecycleSweepIntervalMs()).toBe(6 * 60 * 60 * 1000);
  });
});
