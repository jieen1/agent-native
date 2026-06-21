import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the row the action writes back, and what assertAccess was called with.
const updatedRow = {
  id: "brief_1",
  briefingDate: "2026-06-20",
  kind: "morning",
  title: "Updated title",
  summaryMd: "POLISHED-MARKER narrative",
  status: "complete",
  focus: null,
  createdAt: "2026-06-20T08:00:00.000Z",
  updatedAt: "2026-06-20T09:00:00.000Z",
  ownerEmail: "owner@example.com",
};

const setSpy = vi.fn(() => ({ where: vi.fn(async () => undefined) }));

const dbMock = vi.hoisted(() => ({
  getDb: () => ({
    update: vi.fn(() => ({ set: setSpyRef.current })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [updatedRowRef.current]),
        })),
      })),
    })),
  }),
}));

// Indirection so the hoisted mock can see the latest spy/row references.
const setSpyRef = { current: setSpy };
const updatedRowRef = { current: updatedRow };

const sharingMock = vi.hoisted(() => ({
  assertAccess: vi.fn(),
  // ForbiddenError stand-in so the action's import resolves.
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock("../server/db/index.js", async () => ({
  getDb: dbMock.getDb,
  schema: await vi.importActual("../server/db/schema.js"),
}));

vi.mock("@agent-native/core/sharing", () => sharingMock);

const { default: updateBriefing } = await import("./update-briefing.js");

describe("update-briefing action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setSpyRef.current = setSpy;
    updatedRowRef.current = updatedRow;
  });

  it("requires editor access before writing", async () => {
    sharingMock.assertAccess.mockResolvedValue({ role: "editor" });

    await updateBriefing.run({ id: "brief_1", summaryMd: "POLISHED-MARKER" });

    expect(sharingMock.assertAccess).toHaveBeenCalledWith(
      "briefing",
      "brief_1",
      "editor",
    );
  });

  it("propagates a ForbiddenError from assertAccess and never writes", async () => {
    const writeSet = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    setSpyRef.current = writeSet;
    sharingMock.assertAccess.mockRejectedValue(
      new sharingMock.ForbiddenError("forbidden"),
    );

    await expect(
      updateBriefing.run({ id: "brief_1", summaryMd: "x" }),
    ).rejects.toBeInstanceOf(sharingMock.ForbiddenError);

    expect(writeSet).not.toHaveBeenCalled();
  });

  it("writes summaryMd and bumps updatedAt", async () => {
    sharingMock.assertAccess.mockResolvedValue({ role: "editor" });

    await updateBriefing.run({
      id: "brief_1",
      summaryMd: "POLISHED-MARKER narrative",
    });

    expect(setSpy).toHaveBeenCalledTimes(1);
    const patch = setSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.summaryMd).toBe("POLISHED-MARKER narrative");
    expect(typeof patch.updatedAt).toBe("string");
    expect(patch).not.toHaveProperty("title");
  });

  it("rejects when neither summaryMd nor title is provided", async () => {
    sharingMock.assertAccess.mockResolvedValue({ role: "editor" });

    await expect(updateBriefing.run({ id: "brief_1" })).rejects.toThrow(
      /at least one of summaryMd or title/i,
    );
  });

  it("returns the updated row", async () => {
    sharingMock.assertAccess.mockResolvedValue({ role: "editor" });

    const result = await updateBriefing.run({
      id: "brief_1",
      title: "Updated title",
    });

    expect(result).toMatchObject({ id: "brief_1", title: "Updated title" });
  });
});
