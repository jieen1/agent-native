/**
 * fork → real scheduler tick (Phase A5 acceptance, plan §1.5.20 / 验收 line 367):
 * "fork a scheduled routine → it triggers → a success/run row appears, all
 * without opening the agent chat."
 *
 * This is the deterministic, hard-acceptance path: the scheduler's 60s
 * `setInterval` is hardcoded and not adjustable from a template (no core
 * change), so we cannot drive the real wall-clock loop. Instead we drive the
 * REAL engine entrypoint `processRecurringJobs` directly and make the forked
 * routine due by writing its `nextRun` into the past — exactly how
 * scheduler-tick.spec proves the gate. This exercises the genuine scheduler
 * code path (not a shadow), end-to-end from a real `fork-routine` write.
 *
 * Flow:
 *   1. `fork-routine` writes the preset into the owner via the mocked store.
 *   2. We capture that written content, mark it due (`nextRun: PAST`), and feed
 *      it back through `resourceListAllOwners` for the real `processRecurringJobs`.
 *   3. The tick reaching `executeJob` is observable as a `resourcePut` writing
 *      `lastStatus: running` for the forked routine's path — proof the forked
 *      routine fires on the real scheduler without any agent-chat involvement.
 *
 * Only `@agent-native/core/resources/store` is mocked (the same built module the
 * scheduler imports), so the mock intercepts both the fork's write and the
 * scheduler's own reads/writes. The downstream agent work after the running-mark
 * throws in isolation (no DB / key) but is caught inside the scheduler's
 * request-context callback, so the assertion stays deterministic.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  resourcePut: vi.fn(),
  resourceGetByPath: vi.fn(),
  resourceListAllOwners: vi.fn(),
  resourceGet: vi.fn(),
  resourceDelete: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
  orgId: undefined as string | undefined,
}));

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => ctx.orgId,
}));

const { default: forkRoutine } = await import("./fork-routine.js");
const { processRecurringJobs } = await import("@agent-native/core/jobs");

const OWNER = "owner@example.com";
const PAST = "1970-01-01T00:00:00.000Z"; // <= now → due

const deps = {
  getActions: () => ({}),
  getSystemPrompt: async () => "system",
  engine: { defaultModel: "test-model", name: "test" } as never,
  model: "test-model",
};

/** Did the tick mark `path` as running (= reached executeJob for it)? */
function markedRunning(path: string): boolean {
  return store.resourcePut.mock.calls.some(
    ([, p, content]: [string, string, string]) =>
      p === path && /lastStatus:\s*running/.test(content),
  );
}

describe("fork → real scheduler tick", () => {
  beforeEach(() => {
    store.resourcePut.mockReset();
    store.resourceGetByPath.mockReset();
    store.resourceListAllOwners.mockReset();
    store.resourcePut.mockResolvedValue(undefined);
    store.resourceGetByPath.mockResolvedValue(null);
    ctx.email = OWNER;
    ctx.orgId = undefined;
  });

  it("a forked schedule routine fires on the real scheduler (reaches executeJob)", async () => {
    // 1. Fork the schedule preset; capture the exact content the fork wrote.
    let writtenPath = "";
    let writtenContent = "";
    store.resourcePut.mockImplementation(
      async (_owner: string, path: string, content: string) => {
        writtenPath = path;
        writtenContent = content;
        return {
          id: "res_fork",
          owner: OWNER,
          path,
          content,
          updatedAt: new Date("2026-06-21T00:00:00.000Z"),
        };
      },
    );

    await forkRoutine.run({ presetId: "unread-mail-triage" });
    expect(writtenPath).toBe("jobs/unread-mail-triage.md");
    expect(writtenContent).toContain("triggerType: schedule");

    // 2. Make the forked routine due by injecting a past nextRun, then feed it
    //    to the real scheduler. (No nextRun → the engine seeds it and skips the
    //    tick; an explicit past nextRun exercises the due gate.)
    const dueContent = writtenContent.replace(
      /\n---\n/,
      `\nnextRun: ${PAST}\n---\n`,
    );
    store.resourceListAllOwners.mockResolvedValue([
      { id: "res_fork", owner: OWNER, path: writtenPath, content: dueContent },
    ]);

    // 3. Drive the real engine tick. The forked routine must reach executeJob.
    await processRecurringJobs(deps);

    expect(markedRunning("jobs/unread-mail-triage.md")).toBe(true);
  });
});
