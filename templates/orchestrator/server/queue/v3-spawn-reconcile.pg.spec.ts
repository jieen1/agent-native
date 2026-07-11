// Real-Postgres integration test for the F10 R9 conduction chain
// (docs/sdlc-impl-f5-f10.md §6A/§6E T-F10-03, T-F10-04;
// docs/sdlc-product-design/02-workflows.md §4 R9, SDLC-050).
//
// v3-spawn-reconcile.ts's stranded/stalled-spawn detection is genuine
// Postgres-specific raw SQL (joins, `now()`, `RETURNING id`) gated behind
// `isPostgres()` — it is a documented no-op under the SQLite/local-file dev
// default (`if (!isPostgres()) return [];`), so a mock-DB unit test would
// prove nothing about the actual detection SQL. This file spins up a
// one-shot `postgres:16` Docker container (same recipe documented for F8's
// T-F8-01/T-F8-06 in docs/sdlc-impl-f5-f10.md — no testcontainers dependency
// added), runs the REAL orchestrator migrations against it, and exercises the
// REAL `reconcileV3SpawnsOnce()` + the REAL `V3Reconciler.tick()` conduction
// rule end-to-end against real rows.
//
// Honesty notes (do not remove — required by the F10 task brief):
//  - T-F10-03 asks to "start the orchestrator" and observe self-healing after
//    a restart. Actually spawning a second orchestrator server process is out
//    of scope for a fast, hermetic test — this instead calls the EXACT
//    function boot uses (`reconcileV3SpawnsOnce()`, which
//    server/queue/brain-driver.ts's `startBrainDriver()` also fires
//    immediately on startup) directly against a pre-populated non-terminal
//    spawn row. That is a REAL exercise of the boot-scan mechanism, just
//    without the surrounding HTTP server.
//  - T-F10-04 asks to "block :9000" to silence a spawn's event stream. This
//    test achieves the same OBSERVABLE effect directly at the data level (a
//    v3_events row whose timestamp is older than the stall threshold, with no
//    newer event) rather than actually running a network proxy — the
//    reconcile function only ever looks at `MAX(v3_events.ts)`, so this is a
//    faithful trigger of the exact code path, not a substitute assertion.
//  - Every fixture is deliberately built so the conduction rule's decision is
//    "retries exhausted → fail" (no retry policy on the DAG node, exactly one
//    spawn attempt made) — this guarantees `triggerTickSafe()`'s real
//    reconciler NEVER calls the real `RemoteApiExecutor` dispatcher (which
//    would try to reach an actual runtime endpoint). Only the DB-mutation
//    half of tick() is exercised; the "retry within policy" half is already
//    covered by the mock-based tests in server/engine/v3-reconciler.spec.ts
//    (T-F10-01/02), which do not need real Postgres.
//  - Both tests skip (not fail) if `docker` is unavailable in the sandbox —
//    this is a real integration test, not a text-locked placeholder; the
//    skip path only exists for environments without Docker.

import { execSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Synchronous docker-availability probe AT COLLECTION TIME — describe.skipIf
// needs a plain boolean right now, not a value produced by an async
// beforeAll (which runs after collection). This sandbox has docker +
// postgres:16 cached locally (verified manually before writing this file);
// the skip path exists only for environments without Docker so this suite
// degrades to `it.skip`-equivalent rather than a false failure — never a
// silent text-lock pretending to be a real assertion.
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
  "F10 R9 conduction — real Postgres (T-F10-03, T-F10-04)",
  () => {
    let containerId: string | null = null;

    beforeAll(async () => {
      const cid = sh(
        "docker run -d --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=f10_test " +
          "-p 127.0.0.1:0:5432 postgres:16",
      );
      containerId = cid;
      await waitForPostgresReady(cid);

      const portLine = sh(`docker port ${cid} 5432`); // "127.0.0.1:NNNNN"
      const port = portLine.split(":").pop();
      // Set DATABASE_URL BEFORE any orchestrator DB module is imported anywhere
      // in this process — @agent-native/core/db's getDialect() memoizes on
      // first call, so importing (even transitively) before this line would
      // wrongly cache the local-file/sqlite dialect. This file has no other
      // top-level imports of orchestrator DB code — every one of them is a
      // dynamic `await import()` below, deliberately deferred until after this
      // line runs.
      process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/f10_test`;

      // Run the REAL migrations (migrateV2 + migrateV3) against the fresh DB —
      // same "tsx script imports the real db plugin" recipe documented for F8.
      const dbPlugin = (await import("../plugins/db.js")).default;
      await dbPlugin(undefined as never);
    }, 60_000);

    afterAll(() => {
      if (containerId) {
        try {
          execSync(`docker rm -f ${containerId}`, { stdio: "ignore" });
        } catch {
          // Best-effort cleanup.
        }
      }
    });

    it("T-F10-03 analogue: boot-scan settles an orphaned non-terminal spawn AND drives its stuck node (not just the spawn)", async () => {
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce } = await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-boot";
      const nodeId = "f10-node-boot";
      const spawnId = "f10-spawn-boot";

      await getDbExec().execute({
        sql: `INSERT INTO v3_runs (id, inputs, dag, status, owner_email)
            VALUES ($1, '{}'::jsonb, $2::jsonb, 'running', 'local@localhost')`,
        args: [
          runId,
          JSON.stringify({ nodes: [{ id: "a", type: "agent", deps: [] }] }),
        ],
      });
      await getDbExec().execute({
        sql: `INSERT INTO v3_nodes (id, run_id, node_id_in_dag, type, status, current_spawn_id, owner_email)
            VALUES ($1, $2, 'a', 'agent', 'running', $3, 'local@localhost')`,
        args: [nodeId, runId, spawnId],
      });
      // "Orphaned after restart": no live handle exists (in-process registry is
      // gone), runtime is not a microVM, and it started well past the no-VM
      // grace (default 2 min) — the same shape reconcileV3SpawnsOnce already
      // treated as stranded pre-F10, now paired with node-side migration.
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', now() - interval '10 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });

      const reconciled = await reconcileV3SpawnsOnce();
      expect(
        reconciled.some((r) => r.id === spawnId && r.to === "failed"),
      ).toBe(true);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status, error_class FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("failed");
      expect((spawnRow.rows[0] as any).error_class).toBe("reconciled-stranded");

      // The conduction-critical assertion: the NODE must not be left dangling
      // 'running' — triggerTickSafe (called internally by reconcileV3SpawnsOnce
      // for exactly this shape) must have driven the real reconciler's
      // conduction rule to migrate it. No retry policy on this DAG node and
      // exactly one spawn attempt made → retries exhausted → node fails.
      const nodeRow = await getDbExec().execute({
        sql: `SELECT status, current_spawn_id FROM v3_nodes WHERE id = $1`,
        args: [nodeId],
      });
      expect((nodeRow.rows[0] as any).status).toBe("failed");
      expect((nodeRow.rows[0] as any).current_spawn_id).toBeNull();

      const eventRow = await getDbExec().execute({
        sql: `SELECT kind, payload FROM v3_events WHERE run_id = $1 AND kind = 'conduction.fixed'`,
        args: [runId],
      });
      expect(eventRow.rows.length).toBeGreaterThan(0);
      expect((eventRow.rows[0] as any).payload?.disposition).toBe("failed");
    }, 20_000);

    it("T-F10-04 analogue: an event-stream stall (no v3_events heartbeat) settles a live-looking microVM spawn AND drives its node; nodeRetry then revives the survivor", async () => {
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce, ORCH_SPAWN_STALL_MS } =
        await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-stall";
      const nodeId = "f10-node-stall";
      const spawnId = "f10-spawn-stall";

      await getDbExec().execute({
        sql: `INSERT INTO v3_runs (id, inputs, dag, status, owner_email)
            VALUES ($1, '{}'::jsonb, $2::jsonb, 'running', 'local@localhost')`,
        args: [
          runId,
          JSON.stringify({ nodes: [{ id: "a", type: "agent", deps: [] }] }),
        ],
      });
      await getDbExec().execute({
        sql: `INSERT INTO v3_nodes (id, run_id, node_id_in_dag, type, status, current_spawn_id, owner_email)
            VALUES ($1, $2, 'a', 'agent', 'running', $3, 'local@localhost')`,
        args: [nodeId, runId, spawnId],
      });
      // Looks alive by every OTHER signal: microVM runtime with a real vm_name
      // (liveVm=true → the no-VM-grace backstop never fires), started only 6
      // minutes ago (well inside the 30-min hard-stale backstop). The ONLY
      // thing wrong is its event stream went silent 5 minutes ago — longer than
      // ORCH_SPAWN_STALL_MS (default 120s) — which is exactly what T-F10-04
      // means by "断流可检" (a silent stream is detectable) and is the ONLY of
      // the three disposition checks that can catch this shape.
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, vm_name, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'microvm', 'vm-f10-test', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      await getDbExec().execute({
        sql: `INSERT INTO v3_events (id, run_id, spawn_id, kind, ts, owner_email)
            VALUES ($1, $2, $3, 'spawn.step', now() - interval '5 minutes', 'local@localhost')`,
        args: [`${spawnId}-ev1`, runId, spawnId],
      });

      expect(ORCH_SPAWN_STALL_MS).toBeGreaterThan(0);
      const reconciled = await reconcileV3SpawnsOnce();
      expect(
        reconciled.some((r) => r.id === spawnId && r.to === "failed"),
      ).toBe(true);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status, error FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("failed");
      expect((spawnRow.rows[0] as any).error).toContain("heartbeat");

      const nodeRow = await getDbExec().execute({
        sql: `SELECT status FROM v3_nodes WHERE id = $1`,
        args: [nodeId],
      });
      expect((nodeRow.rows[0] as any).status).toBe("failed");

      // "恢复网络后 nodeRetry 复活成功" — once failed, the (unmodified) baseline
      // nodeRetry admission path (node.status ∈ {failed, cancelled}) revives it
      // — exercised here as a REAL action call against the REAL DB, not mocked.
      const { nodeRetry } = await import("../../actions/v3-run-detail.js");
      const retryResult = await nodeRetry.run({ runId, nodeId });
      expect(retryResult.status).toBe("ready");

      const revived = await getDbExec().execute({
        sql: `SELECT status, current_spawn_id FROM v3_nodes WHERE id = $1`,
        args: [nodeId],
      });
      expect((revived.rows[0] as any).status).toBe("ready");
      expect((revived.rows[0] as any).current_spawn_id).toBeNull();
    }, 20_000);
  },
);
