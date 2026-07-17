// Real-Postgres test for the §4.1 collision-detection fix (task board #77) in
// workflow-templates-seed.ts's boot plugin. A mock DB would not exercise
// genuine jsonb round-trip semantics — Postgres does not preserve object-key
// order for jsonb (documented behavior), which is exactly the risk
// `jsonDeepEqual` (see workflow-templates-seed.ts) has to be robust against;
// a naive `JSON.stringify` comparison could false-negative purely on key
// order and misclassify a genuine seed-owned row as "foreign".
//
// Recipe: same one-shot postgres:16 Docker container + real migrations
// technique as server/queue/v3-writeback-outbox-sweep.pg.spec.ts. Skips (does
// not fail) when docker is unavailable.
//
// Covers the two real scenarios r4-workflow-families-planning-skills.md §1.2
// discovered: a name whose latest version's dag matches the seed's own
// definition (should still get builtin:true — e.g. re-running boot after a
// prior fresh insert), and a name whose latest version's dag does NOT match
// (the real sdlc-promote/sdlc-issue-pipeline shape: a pre-existing
// brain-authored row) — should get metaTaggedOnly instead, with a populated
// changeNote and the dag/version left untouched. Also covers the unrelated
// "brand new name" insert path (regression) and idempotency of a second boot.

import { execSync } from "node:child_process";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let dockerAvailable = false;
try {
  execSync("docker version --format '{{.Server.Version}}'", {
    stdio: "ignore",
  });
  dockerAvailable = true;
} catch {
  dockerAvailable = false;
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8" }).trim();
}

async function waitForPostgresReady(
  cid: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      execSync(`docker exec ${cid} pg_isready -U postgres`, {
        stdio: "ignore",
      });
      return;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("postgres:16 container did not become ready in time");
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

describe.skipIf(!dockerAvailable)(
  "task board #77 — workflow-templates-seed collision detection (real Postgres)",
  () => {
    let containerId: string | null = null;

    beforeAll(async () => {
      const cid = sh(
        "docker run -d --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=wf_seed_collision_test " +
          "-p 127.0.0.1:0:5432 postgres:16",
      );
      containerId = cid;
      await waitForPostgresReady(cid);

      const portLine = sh(`docker port ${cid} 5432`); // "127.0.0.1:NNNNN"
      const port = portLine.split(":").pop();
      // Set DATABASE_URL BEFORE any orchestrator DB module is imported
      // anywhere in this process — @agent-native/core/db's getDialect()
      // memoizes on first call. This file has no other top-level imports of
      // orchestrator DB code — every one is a dynamic `await import()` below,
      // deliberately deferred until after this line runs (mirrors
      // v3-writeback-outbox-sweep.pg.spec.ts).
      process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/wf_seed_collision_test`;

      // Run the REAL migrations (migrateV2 + migrateV3, including the
      // s8-workflow-library `meta` column) against the fresh DB.
      const dbPlugin = (await import("./db.js")).default;
      await dbPlugin(undefined as never);
    }, 60_000);

    afterAll(() => {
      if (containerId) {
        try {
          execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
        } catch {
          // best-effort cleanup
        }
      }
    });

    it("classifies a matching-dag collision as builtin, a foreign-dag collision as metaTaggedOnly, and still inserts brand-new names", async () => {
      const { getV3Db, v3Schema } = await import("../db/index.js");
      const { WORKFLOW_LIBRARY_SEED } =
        await import("../engine/workflow-library-seed.js");
      const seedRun = (await import("./workflow-templates-seed.js")).default;

      const db = getV3Db();

      const matchEntry = WORKFLOW_LIBRARY_SEED.find(
        (e) => e.name === "sdlc-verify",
      );
      const foreignEntry = WORKFLOW_LIBRARY_SEED.find(
        (e) => e.name === "sdlc-promote",
      );
      if (!matchEntry || !foreignEntry) {
        throw new Error(
          "fixture entries sdlc-verify/sdlc-promote missing from WORKFLOW_LIBRARY_SEED",
        );
      }

      // Scenario 1: a pre-existing row whose dag content IS the seed's own
      // (e.g. a re-boot after a prior fresh insert). Round-tripped through
      // REAL jsonb, so Postgres's own key-order handling is genuinely
      // exercised, not simulated.
      await db.insert(v3Schema.v3WorkflowTemplates).values({
        id: "v3wf_fixture_match",
        name: matchEntry.name,
        version: 1,
        description: matchEntry.description,
        dag: matchEntry.dag,
        inputSchema: matchEntry.inputSchema,
        meta: null,
        ownerEmail: "local@localhost",
        orgId: null,
      });

      // Scenario 2: a pre-existing row modeled on the real sdlc-promote
      // collision shape (r4 doc §1.2) — a dag this seed never wrote.
      const foreignDag = {
        nodes: [
          {
            type: "agent",
            id: "legacy",
            agent: "vllm",
            deps: [],
            prompt: "pre-existing brain-authored dag this seed never wrote",
          },
        ],
      };
      await db.insert(v3Schema.v3WorkflowTemplates).values({
        id: "v3wf_fixture_foreign",
        name: foreignEntry.name,
        version: 1,
        description: "brain-authored, pre-existing",
        dag: foreignDag,
        inputSchema: { type: "object", properties: {} },
        meta: null,
        ownerEmail: "local@localhost",
        orgId: null,
      });

      await seedRun();

      // ── Scenario 1 assertions: matching dag → builtin:true ──────────────
      const matchRows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.name, matchEntry.name));
      expect(matchRows).toHaveLength(1); // no new version inserted
      const matchMeta = matchRows[0]!.meta as Record<string, unknown>;
      expect(matchRows[0]!.version).toBe(1);
      expect(matchMeta.builtin).toBe(true);
      expect(matchMeta.metaTaggedOnly).toBeUndefined();
      expect(matchMeta.family).toBe(matchEntry.family);

      // ── Scenario 2 assertions: foreign dag → metaTaggedOnly, not builtin,
      //    dag/version untouched ───────────────────────────────────────────
      const foreignRows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.name, foreignEntry.name));
      expect(foreignRows).toHaveLength(1); // version history is immutable
      const foreignRow = foreignRows[0]!;
      expect(foreignRow.version).toBe(1);
      expect(foreignRow.dag).toEqual(foreignDag); // dag column never touched
      const foreignMeta = foreignRow.meta as Record<string, unknown>;
      expect(foreignMeta.metaTaggedOnly).toBe(true);
      expect(foreignMeta.builtin).not.toBe(true);
      expect(typeof foreignMeta.changeNote).toBe("string");
      expect((foreignMeta.changeNote as string).length).toBeGreaterThan(0);
      expect(foreignMeta.family).toBe(foreignEntry.family);

      // ── Regression: an untouched, brand-new name still inserts a fresh v1
      //    row with builtin:true (the original, pre-fix insert path) ────────
      const freshEntry = WORKFLOW_LIBRARY_SEED.find(
        (e) => e.name === "quick-task",
      )!;
      const freshRows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.name, freshEntry.name));
      expect(freshRows).toHaveLength(1);
      expect(freshRows[0]!.version).toBe(1);
      const freshMeta = freshRows[0]!.meta as Record<string, unknown>;
      expect(freshMeta.builtin).toBe(true);
      expect(freshRows[0]!.dag).toEqual(freshEntry.dag);
    });

    it("a second boot run is idempotent — no duplicate rows, no re-patch", async () => {
      const { getV3Db, v3Schema } = await import("../db/index.js");
      const { WORKFLOW_LIBRARY_SEED } =
        await import("../engine/workflow-library-seed.js");
      const seedRun = (await import("./workflow-templates-seed.js")).default;

      const db = getV3Db();

      const beforeRows = await db.select().from(v3Schema.v3WorkflowTemplates);
      const beforeCount = beforeRows.length;

      await seedRun(); // second boot on the already-seeded DB from the prior test

      const afterRows = await db.select().from(v3Schema.v3WorkflowTemplates);
      expect(afterRows).toHaveLength(beforeCount); // no duplicates inserted

      // Every WORKFLOW_LIBRARY_SEED name now has exactly one row, and it is
      // classified as either builtin or metaTaggedOnly (never neither).
      for (const entry of WORKFLOW_LIBRARY_SEED) {
        const rows = afterRows.filter((r) => r.name === entry.name);
        expect(rows).toHaveLength(1);
        const meta = (rows[0]!.meta ?? {}) as Record<string, unknown>;
        expect(meta.builtin === true || meta.metaTaggedOnly === true).toBe(
          true,
        );
      }
    });
  },
);
