// F4 越界工具尝试留痕 — spawn_events `tool.denied` 持久 sink(docs/
// sdlc-impl-f1-f4.md §6.4 T-F4-02/T-F4-06 的可单测半:拒绝判定 + 落库行
// 形状;"评审会话实测文件内容+mtime 逐一不变" 属 101 集成)。框架 audit-log
// 只覆盖 defineAction 面,harness 工具拒绝原本无处落——此 sink 补上缺口。

import { describe, it, expect } from "vitest";
import { spawnEvents, v3Events } from "../../db/v3-schema.js";
import {
  BRAIN_SPAWN_KEY_PREFIX,
  brainSpawnKey,
  maybeLogToolDenied,
} from "../tool-denied.js";

function createMockDb(opts?: { failInsert?: boolean }) {
  const inserts: Array<{ table: unknown; vals: Record<string, unknown> }> = [];

  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) =>
          Promise.resolve(
            table === spawnEvents ? [{ next: 3 }] : [{ nextSeq: 12 }],
          ),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        if (opts?.failInsert) throw new Error("insert failed");
        inserts.push({ table, vals });
      },
    }),
  };

  return { db: db as never, inserts };
}

const BASE = {
  threadId: "bt_review-1",
  ownerEmail: "owner@example.test",
  orgId: null,
  phase: "review" as const,
  allowedTools: ["mcp__orchestrator", "Read", "Grep", "Glob"],
};

describe("T-F4-06 (unit) — 被拒工具尝试落 spawn_events tool.denied", () => {
  it("an allowed tool_use writes nothing and returns false", async () => {
    const { db, inserts } = createMockDb();
    for (const name of ["Read", "mcp__orchestrator__workflowRun", "Glob"]) {
      expect(await maybeLogToolDenied(db, { ...BASE, toolName: name })).toBe(
        false,
      );
    }
    expect(inserts).toHaveLength(0);
  });

  it("a write-tool attempt in the review phase lands as a tool.denied spawn_events row", async () => {
    const { db, inserts } = createMockDb();
    const denied = await maybeLogToolDenied(db, {
      ...BASE,
      toolName: "Bash",
      toolUseId: "tu_1",
      toolInput: { command: "printf x >> file.ts" },
    });
    expect(denied).toBe(true);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(spawnEvents);
    const row = inserts[0].vals;
    expect(row.type).toBe("tool.denied");
    expect(row.name).toBe("Bash");
    expect(row.spawnId).toBe(`${BRAIN_SPAWN_KEY_PREFIX}bt_review-1`);
    expect(row.seq).toBe(3);
    expect(String(row.text)).toContain("phase=review");
    expect(String(row.text)).toContain("bt_review-1");
    expect(row.input).toEqual({ command: "printf x >> file.ts" });
  });

  it("with reviewOfRunId, mirrors a run-scoped v3_events tool.denied row (S7 可见)", async () => {
    const { db, inserts } = createMockDb();
    const denied = await maybeLogToolDenied(db, {
      ...BASE,
      toolName: "Write",
      toolUseId: "tu_2",
      reviewOfRunId: "r-9",
    });
    expect(denied).toBe(true);
    expect(inserts).toHaveLength(2);
    expect(inserts[1].table).toBe(v3Events);
    const ev = inserts[1].vals;
    expect(ev.kind).toBe("tool.denied");
    expect(ev.runId).toBe("r-9");
    expect(ev.seqNum).toBe(12);
    const payload = ev.payload as Record<string, unknown>;
    expect(payload.toolName).toBe("Write");
    expect(payload.phase).toBe("review");
    expect(payload.threadId).toBe("bt_review-1");
    expect(payload.allowedTools).toEqual(BASE.allowedTools);
  });

  it("Edit is denied in the dispatch phase too (双相位无写工具)", async () => {
    const { db, inserts } = createMockDb();
    const denied = await maybeLogToolDenied(db, {
      ...BASE,
      phase: "dispatch",
      toolName: "Edit",
    });
    expect(denied).toBe(true);
    expect(String(inserts[0].vals.text)).toContain("phase=dispatch");
  });

  it("is best-effort: a failed write returns false, never throws (不阻断回合)", async () => {
    const { db } = createMockDb({ failInsert: true });
    await expect(
      maybeLogToolDenied(db, { ...BASE, toolName: "Bash" }),
    ).resolves.toBe(false);
  });

  it("brainSpawnKey namespaces brain rows apart from real worker spawns", () => {
    expect(brainSpawnKey("bt_x")).toBe("brain:bt_x");
  });
});
