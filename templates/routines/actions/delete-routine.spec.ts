/**
 * delete-routine — owner-scoped delete + subscription teardown.
 *
 *  - Deletes by the resolved resource id and returns { deleted: true }.
 *  - A missing routine (or another owner's) returns { deleted: false } and never
 *    calls resourceDelete (owner scoping via getOwnerRoutineResource).
 *  - After a successful delete, refreshEventSubscriptions tears down any bus
 *    subscription; a refresh failure must NOT mask the successful delete.
 *  - An empty/invalid slug throws before any delete.
 *
 * `resources/store`, `request-context`, and `triggers.refreshEventSubscriptions`
 * are mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  resourceGetByPath: vi.fn(),
  resourceDelete: vi.fn(),
}));
const ctx = vi.hoisted(() => ({
  email: "owner@example.com" as string | undefined,
}));
const refreshEventSubscriptions = vi.hoisted(() => vi.fn());

vi.mock("@agent-native/core/resources/store", () => store);
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => undefined,
}));
vi.mock("@agent-native/core/triggers", async (importActual) => {
  const actual =
    await importActual<typeof import("@agent-native/core/triggers")>();
  return { ...actual, refreshEventSubscriptions };
});

const { default: deleteRoutine } = await import("./delete-routine.js");

const RESOURCE = {
  id: "res_1",
  owner: "owner@example.com",
  path: "jobs/morning.md",
  content: "---\ntriggerType: schedule\n---\n\nbody",
  updatedAt: new Date(),
};

describe("delete-routine", () => {
  beforeEach(() => {
    store.resourceGetByPath.mockReset();
    store.resourceDelete.mockReset();
    refreshEventSubscriptions.mockReset();
    refreshEventSubscriptions.mockResolvedValue(undefined);
    ctx.email = "owner@example.com";
  });

  it("deletes an owned routine by id and refreshes subscriptions", async () => {
    store.resourceGetByPath.mockResolvedValue(RESOURCE);
    store.resourceDelete.mockResolvedValue(true);

    const result = await deleteRoutine.run({ name: "morning" });

    expect(store.resourceDelete).toHaveBeenCalledWith("res_1");
    expect(result).toEqual({ deleted: true, name: "morning" });
    expect(refreshEventSubscriptions).toHaveBeenCalledTimes(1);
  });

  it("returns deleted:false and never deletes when the routine is not found", async () => {
    store.resourceGetByPath.mockResolvedValue(null);

    const result = await deleteRoutine.run({ name: "ghost" });

    expect(result).toEqual({ deleted: false, name: "ghost" });
    expect(store.resourceDelete).not.toHaveBeenCalled();
    expect(refreshEventSubscriptions).not.toHaveBeenCalled();
  });

  it("does not mask a successful delete when subscription refresh fails", async () => {
    store.resourceGetByPath.mockResolvedValue(RESOURCE);
    store.resourceDelete.mockResolvedValue(true);
    refreshEventSubscriptions.mockRejectedValue(new Error("bus down"));

    const result = await deleteRoutine.run({ name: "morning" });

    expect(result).toEqual({ deleted: true, name: "morning" });
  });

  it("throws on an empty/invalid slug before any delete", async () => {
    await expect(deleteRoutine.run({ name: "!!!" })).rejects.toThrow(
      /invalid routine name/i,
    );
    expect(store.resourceDelete).not.toHaveBeenCalled();
  });
});
