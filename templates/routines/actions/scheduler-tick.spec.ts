/**
 * Scheduler tick → executeJob gating (§ acceptance lines 256 & 258).
 *
 * This drives the REAL engine scheduler `processRecurringJobs`
 * (`@agent-native/core/jobs`) and mocks only `@agent-native/core/resources/store`
 * — which resolves to the exact same built file the scheduler imports
 * internally (`packages/core/dist/resources/store.js`), so the mock intercepts
 * the scheduler's own `resourceListAllOwners` / `resourcePut` calls.
 *
 * Observable signal — "did the tick reach executeJob for this routine?":
 *   `executeJob` marks the job `lastStatus: "running"` by calling
 *   `resourcePut(owner, path, content-with-"lastStatus: running")` BEFORE any
 *   engine / thread / DB work (scheduler.ts marks running, then runs the agent
 *   inside `runWithRequestContext`). So a due+enabled routine produces a
 *   running-mark write; a disabled or not-yet-due routine never does.
 *
 *   The downstream agent work after the running-mark throws in this isolated
 *   test (no DB / no API key), but that error is caught inside the scheduler's
 *   request-context callback and not rethrown, so `processRecurringJobs`
 *   resolves cleanly and the running-mark assertion is deterministic.
 *
 * Notes on engine behavior verified against scheduler.ts:
 *   - a job with no `nextRun` is SEEDED (nextRun written) and skipped this tick,
 *     so we always provide an explicit `nextRun` to exercise the due/not-due gate.
 *   - the running-mark write content is produced by `buildJobContent`, hence the
 *     `lastStatus: running` substring (no `triggerType` line — scheduler-native).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  resourceListAllOwners: vi.fn(),
  resourcePut: vi.fn(),
  resourceGet: vi.fn(),
}));

vi.mock("@agent-native/core/resources/store", () => store);

const { processRecurringJobs } = await import("@agent-native/core/jobs");

const OWNER = "owner@example.com";
const PAST = "1970-01-01T00:00:00.000Z"; // always <= now -> due
const FAR_FUTURE = "2999-01-01T00:00:00.000Z"; // never due

function jobResource(opts: {
  name: string;
  enabled: boolean;
  schedule?: string;
  nextRun?: string;
  body?: string;
}) {
  const {
    name,
    enabled,
    schedule = "* * * * *",
    nextRun,
    body = "Do the work.",
  } = opts;
  const lines = [
    "---",
    `schedule: "${schedule}"`,
    `enabled: ${enabled}`,
    "triggerType: schedule",
    "mode: agentic",
    `createdBy: ${OWNER}`,
  ];
  if (nextRun) lines.push(`nextRun: ${nextRun}`);
  lines.push("---", "", body);
  return {
    id: `res_${name}`,
    owner: OWNER,
    path: `jobs/${name}.md`,
    content: lines.join("\n"),
  };
}

/** Did the tick mark `path` as running (i.e. reach executeJob for it)? */
function markedRunning(path: string): boolean {
  return store.resourcePut.mock.calls.some(
    ([, p, content]: [string, string, string]) =>
      p === path && /lastStatus:\s*running/.test(content),
  );
}

const deps = {
  getActions: () => ({}),
  getSystemPrompt: async () => "system",
  // Provide an engine + model so resolveEngine/getStoredModelForEngine are not
  // reached; if executeJob still throws later (no DB createThread), it is caught.
  engine: {
    defaultModel: "test-model",
    name: "test",
  } as never,
  model: "test-model",
};

describe("scheduler tick gating", () => {
  beforeEach(() => {
    store.resourceListAllOwners.mockReset();
    store.resourcePut.mockReset();
    store.resourcePut.mockResolvedValue(undefined);
  });

  it("reaches executeJob for a due, enabled routine (marks it running)", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      jobResource({ name: "due-enabled", enabled: true, nextRun: PAST }),
    ]);

    await processRecurringJobs(deps);

    expect(markedRunning("jobs/due-enabled.md")).toBe(true);
  });

  it("skips a disabled routine even when it is due (never marked running)", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      jobResource({ name: "due-disabled", enabled: false, nextRun: PAST }),
    ]);

    await processRecurringJobs(deps);

    expect(markedRunning("jobs/due-disabled.md")).toBe(false);
    // A disabled job is skipped outright — no resource write at all this tick.
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("skips a routine that is not yet due (nextRun in the future)", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      jobResource({
        name: "not-due",
        enabled: true,
        nextRun: FAR_FUTURE,
      }),
    ]);

    await processRecurringJobs(deps);

    expect(markedRunning("jobs/not-due.md")).toBe(false);
  });

  it("runs only the due+enabled routine when both are present", async () => {
    store.resourceListAllOwners.mockResolvedValue([
      jobResource({ name: "fire-me", enabled: true, nextRun: PAST }),
      jobResource({ name: "leave-me", enabled: false, nextRun: PAST }),
    ]);

    await processRecurringJobs(deps);

    expect(markedRunning("jobs/fire-me.md")).toBe(true);
    expect(markedRunning("jobs/leave-me.md")).toBe(false);
  });

  it("does not throw on empty state (no job resources)", async () => {
    store.resourceListAllOwners.mockResolvedValue([]);
    await expect(processRecurringJobs(deps)).resolves.toBeUndefined();
    expect(store.resourcePut).not.toHaveBeenCalled();
  });
});
