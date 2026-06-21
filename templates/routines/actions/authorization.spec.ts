/**
 * Owner-scope authorization (§ acceptance line 260: 越权 — 他人 routine 改不动).
 *
 * Phase A1 cannot use the engine's `authorizeJobMutation` (it is private and
 * unexported), so cross-user isolation is enforced structurally by owner-scoped
 * reads: every mutate/read action resolves the routine through
 * `resourceGetByPath(currentOwner, path)`. When the routine belongs to another
 * owner, that scoped read returns `null`, so:
 *   - get-routine        -> { notFound: true }
 *   - set-routine-enabled-> { notFound: true }, no write
 *   - delete-routine     -> { deleted: false }, no delete
 *   - save-routine update -> throws "no routine named", no write
 *
 * The mock for `resourceGetByPath` models the real owner scoping: it returns the
 * resource ONLY when the requested owner matches the resource's owner. Bob (the
 * caller) therefore can never see Alice's routine.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";

const store = vi.hoisted(() => {
  const alice = "alice@example.com";
  const aliceRoutine = {
    id: "res_alice_1",
    owner: alice,
    path: "jobs/alices-secret.md",
    content:
      '---\nschedule: "0 9 * * *"\nenabled: true\ntriggerType: schedule\nmode: agentic\ncreatedBy: alice@example.com\n---\n\nAlice private instructions',
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
  return {
    aliceRoutine,
    resourcePut: vi.fn(),
    resourceDelete: vi.fn(),
    // Owner-scoped read: only returns the resource when the owner matches.
    resourceGetByPath: vi.fn(async (owner: string, path: string) =>
      owner === alice && path === "jobs/alices-secret.md" ? aliceRoutine : null,
    ),
    resourceListAllOwners: vi.fn(),
  };
});
const ctx = vi.hoisted(() => ({
  email: "bob@example.com" as string | undefined,
  orgId: undefined as string | undefined,
}));

const aliceRoutine = store.aliceRoutine;

vi.mock("@agent-native/core/resources/store", () => ({
  resourcePut: store.resourcePut,
  resourceDelete: store.resourceDelete,
  resourceGetByPath: store.resourceGetByPath,
  resourceListAllOwners: store.resourceListAllOwners,
}));
vi.mock("@agent-native/core/server/request-context", () => ({
  getRequestUserEmail: () => ctx.email,
  getRequestOrgId: () => ctx.orgId,
}));

const { default: getRoutine } = await import("./get-routine.js");
const { default: setRoutineEnabled } = await import("./set-routine-enabled.js");
const { default: deleteRoutine } = await import("./delete-routine.js");
const { default: saveRoutine } = await import("./save-routine.js");

describe("owner-scope authorization — Bob cannot touch Alice's routine", () => {
  beforeEach(() => {
    store.resourcePut.mockReset();
    store.resourceDelete.mockReset();
    store.resourcePut.mockResolvedValue({
      ...aliceRoutine,
      updatedAt: new Date(),
    });
    store.resourceDelete.mockResolvedValue(true);
    ctx.email = BOB;
    ctx.orgId = undefined;
  });

  it("get-routine: another user's routine is reported notFound", async () => {
    const result = await getRoutine.run({ name: "alices-secret" });
    expect(result).toEqual({ notFound: true, name: "alices-secret" });
    // Bob's scoped read was attempted; Alice's content was never returned.
    expect(store.resourceGetByPath).toHaveBeenCalledWith(
      BOB,
      "jobs/alices-secret.md",
    );
  });

  it("set-routine-enabled: cannot disable another user's routine (no write)", async () => {
    const result = await setRoutineEnabled.run({
      name: "alices-secret",
      enabled: false,
    });
    expect(result).toEqual({ notFound: true, name: "alices-secret" });
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("delete-routine: cannot delete another user's routine (no delete)", async () => {
    const result = await deleteRoutine.run({ name: "alices-secret" });
    expect(result).toEqual({ deleted: false, name: "alices-secret" });
    expect(store.resourceDelete).not.toHaveBeenCalled();
  });

  it("save-routine update: cannot modify another user's routine (no write)", async () => {
    await expect(
      saveRoutine.run({
        mode: "update",
        name: "alices-secret",
        schedule: "0 0 * * *",
        instructions: "hijack",
        enabled: true,
      }),
    ).rejects.toThrow(/no routine named/i);
    expect(store.resourcePut).not.toHaveBeenCalled();
  });

  it("the owner herself CAN read her routine (sanity: scoping, not a blanket block)", async () => {
    ctx.email = ALICE;
    const result = await getRoutine.run({ name: "alices-secret" });
    expect("notFound" in result).toBe(false);
    if (!("notFound" in result)) {
      expect(result.routine.name).toBe("alices-secret");
      expect(result.instructions).toBe("Alice private instructions");
    }
    expect(store.resourceGetByPath).toHaveBeenCalledWith(
      ALICE,
      "jobs/alices-secret.md",
    );
  });
});
