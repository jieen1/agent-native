// F4 runVerdict — verdict 落 run 级证据轨(docs/sdlc-impl-f1-f4.md §6.4
// T-F4-05 / T-F4-10 的可单测半:tags.verdict 写入 + review.verdict 事件 +
// CHANGES_REQUESTED 必须携带 findings;"tracker 评审卡可读取/出口唯一" 的
// 运行期验证属 101 集成)。

import { describe, it, expect } from "vitest";
import { v3Events, v3Runs } from "../../db/v3-schema.js";
import { recordRunVerdict } from "../run-verdict.js";

interface MockRunRow {
  id: string;
  status: string;
  tags: Record<string, unknown> | null;
}

function createMockDb(runRow: MockRunRow | null) {
  const updates: Array<{ table: unknown; vals: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; vals: Record<string, unknown> }> = [];

  const db = {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => {
          if (table === v3Runs) {
            return {
              limit: async (_n: number) => (runRow ? [runRow] : []),
            };
          }
          // v3Events seq query — awaited directly (no .limit()).
          return Promise.resolve([{ nextSeq: 7 }]);
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: async (_cond: unknown) => {
          updates.push({ table, vals });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (vals: Record<string, unknown>) => {
        inserts.push({ table, vals });
      },
    }),
  };

  return { db: db as never, updates, inserts };
}

const OWNER = "owner@example.test";

describe("T-F4-05 (unit) — PASSED verdict 落 tags + review.verdict 事件", () => {
  it("writes tags.verdict/verdictAt and appends the run event", async () => {
    const { db, updates, inserts } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { specThreadId: "bt_spec", reviewThreadId: "bt_review" },
    });

    const res = await recordRunVerdict(db, {
      runId: "r-1",
      verdict: "PASSED",
      findings: [],
      reviewThreadId: "bt_review",
      ownerEmail: OWNER,
    });

    expect(res.ok).toBe(true);
    expect(res.verdict).toBe("PASSED");
    expect(res.findingsCount).toBe(0);
    expect(res.runStatus).toBe("done");

    // tags merge kept prior keys and added the verdict trio.
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe(v3Runs);
    const tags = updates[0].vals.tags as Record<string, unknown>;
    expect(tags.specThreadId).toBe("bt_spec");
    expect(tags.reviewThreadId).toBe("bt_review");
    expect(tags.verdict).toBe("PASSED");
    expect(typeof tags.verdictAt).toBe("string");
    expect(tags.verdictBy).toBe("bt_review");

    // review.verdict event row with seq continuation.
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(v3Events);
    expect(inserts[0].vals.kind).toBe("review.verdict");
    expect(inserts[0].vals.runId).toBe("r-1");
    expect(inserts[0].vals.seqNum).toBe(7);
    const payload = inserts[0].vals.payload as Record<string, unknown>;
    expect(payload.verdict).toBe("PASSED");
    expect(payload.reviewThreadId).toBe("bt_review");
  });

  it("reports reviewSeparated=true when spec/review thread ids differ", async () => {
    const { db } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { specThreadId: "bt_spec", reviewThreadId: "bt_review" },
    });
    const res = await recordRunVerdict(db, {
      runId: "r-1",
      verdict: "PASSED",
      ownerEmail: OWNER,
    });
    expect(res.reviewSeparated).toBe(true);
  });

  it("reports reviewSeparated=false when review==spec (评审未分离信号,S7 徽标数据源)", async () => {
    const { db } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { brainThreadId: "bt_same" },
    });
    const res = await recordRunVerdict(db, {
      runId: "r-1",
      verdict: "PASSED",
      reviewThreadId: "bt_same",
      ownerEmail: OWNER,
    });
    expect(res.reviewSeparated).toBe(false);
  });

  it("backfills tags.reviewThreadId when absent, never overwrites an existing one", async () => {
    const { db, updates } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { brainThreadId: "bt_spec" },
    });
    await recordRunVerdict(db, {
      runId: "r-1",
      verdict: "PASSED",
      reviewThreadId: "bt_review-new",
      ownerEmail: OWNER,
    });
    const tags = updates[0].vals.tags as Record<string, unknown>;
    expect(tags.reviewThreadId).toBe("bt_review-new");

    const { db: db2, updates: updates2 } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { brainThreadId: "bt_spec", reviewThreadId: "bt_review-orig" },
    });
    await recordRunVerdict(db2, {
      runId: "r-1",
      verdict: "PASSED",
      reviewThreadId: "bt_review-late",
      ownerEmail: OWNER,
    });
    const tags2 = updates2[0].vals.tags as Record<string, unknown>;
    expect(tags2.reviewThreadId).toBe("bt_review-orig");
    expect(tags2.verdictBy).toBe("bt_review-late");
  });
});

describe("T-F4-10 (unit) — CHANGES_REQUESTED:findings 强制 + 唯一出口指向 workflowRun fix", () => {
  it("rejects CHANGES_REQUESTED without findings", async () => {
    const { db, updates, inserts } = createMockDb({
      id: "r-1",
      status: "done",
      tags: {},
    });
    await expect(
      recordRunVerdict(db, {
        runId: "r-1",
        verdict: "CHANGES_REQUESTED",
        findings: [],
        ownerEmail: OWNER,
      }),
    ).rejects.toThrow(/finding/);
    expect(updates).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("records findings into the event payload and points the next step at workflowRun fix mode", async () => {
    const { db, updates, inserts } = createMockDb({
      id: "r-1",
      status: "done",
      tags: { specThreadId: "bt_spec", reviewThreadId: "bt_review" },
    });
    const res = await recordRunVerdict(db, {
      runId: "r-1",
      verdict: "CHANGES_REQUESTED",
      findings: ["B2: 三连写无事务", "N+1 in list-work-items"],
      reviewThreadId: "bt_review",
      ownerEmail: OWNER,
    });
    expect(res.verdict).toBe("CHANGES_REQUESTED");
    expect(res.findingsCount).toBe(2);
    expect(res.nextStep).toContain("workflowRun");
    expect(res.nextStep).toContain("fix mode");

    const tags = updates[0].vals.tags as Record<string, unknown>;
    expect(tags.verdict).toBe("CHANGES_REQUESTED");
    const payload = inserts[0].vals.payload as Record<string, unknown>;
    expect(payload.findings).toEqual([
      "B2: 三连写无事务",
      "N+1 in list-work-items",
    ]);
  });
});

describe("边界 — 找不到 run / 越权", () => {
  it("throws when the run does not exist under the caller's owner scope", async () => {
    const { db } = createMockDb(null);
    await expect(
      recordRunVerdict(db, {
        runId: "r-missing",
        verdict: "PASSED",
        ownerEmail: OWNER,
      }),
    ).rejects.toThrow(/not found/);
  });
});
