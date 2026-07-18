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
//    test achieves the same OBSERVABLE effect directly at the data level: a
//    REAL `spawn_events` row (the exact table + `created_at` column
//    v3-dispatcher.ts's appendSpawnEvent writes per step — the production
//    live-heartbeat source) whose timestamp is older than the stall
//    threshold, with no newer step. The reconcile only ever looks at
//    `MAX(spawn_events.created_at)`, so this faithfully triggers the exact
//    code path, not a substitute assertion. (An earlier revision injected a
//    v3_events row with a non-null spawn_id instead — a shape production never
//    writes, since every v3_events insert hardcodes spawn_id=NULL — which
//    masked a real bug where the reconcile read v3_events, always got NULL,
//    and fell back to started_at, resetting every healthy long-running spawn.
//    The heartbeat source is now spawn_events, and the REVEALING REGRESSION
//    test below pins that a healthy long-running live-VM spawn is NOT reset.)
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

    it("T-F10-04 analogue: a REAL spawn_events heartbeat gone stale settles a live-looking microVM spawn AND drives its node; nodeRetry then revives the survivor", async () => {
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
      // thing wrong is its live transcript went silent 5 minutes ago — longer
      // than ORCH_SPAWN_STALL_MS (default 120s) — which is exactly what
      // T-F10-04 means by "断流可检" (a silent stream is detectable).
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, vm_name, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'microvm', 'vm-f10-test', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      // The heartbeat is a REAL `spawn_events` row (the SAME table + column
      // v3-dispatcher.ts's appendSpawnEvent writes per step). The earlier
      // revision of this test injected a v3_events row with a non-null
      // spawn_id — a shape production NEVER writes (all v3_events inserts
      // hardcode spawn_id=NULL) — which masked the real bug (the reconcile
      // read v3_events, always got NULL, and fell back to started_at). Using
      // spawn_events here exercises the actual production heartbeat path.
      await getDbExec().execute({
        sql: `INSERT INTO spawn_events (id, spawn_id, seq, type, created_at, owner_email)
            VALUES ($1, $2, 0, 'text', now() - interval '5 minutes', 'local@localhost')`,
        args: [`${spawnId}-step0`, spawnId],
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

    it("REVEALING REGRESSION (fix guard): a healthy long-running live-VM spawn (>120s, no stale heartbeat) is NOT reset — RED before the spawn_events fix, GREEN after", async () => {
      // This is the test that exposes the blocking bug the reviewer caught.
      // Pre-fix, the reconcile read `MAX(v3_events.ts) WHERE spawn_id = s.id`
      // — always NULL in production — and fell back to `started_at`, so ANY
      // live-VM spawn older than 120s was judged "stalled" and reset to failed
      // (then migrated by conduction), killing every healthy spawn running >2
      // minutes. This fixture is exactly that healthy shape: a live microVM
      // (vm_name set), started 6 minutes ago, run + node both still running,
      // and NO stale heartbeat (either no spawn_events row at all, or a fresh
      // one). It MUST be left running.
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce } = await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-healthy";
      const nodeId = "f10-node-healthy";
      const spawnId = "f10-spawn-healthy";

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
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, vm_name, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'microvm', 'vm-f10-healthy', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      // A FRESH heartbeat (10s ago) — the spawn is demonstrably alive. Even a
      // spawn with NO spawn_events row at all must survive (hasHeartbeat=false
      // → never judged stalled), but a fresh row is the stronger positive
      // case: MAX(created_at) is recent, so eventStalled is false regardless.
      await getDbExec().execute({
        sql: `INSERT INTO spawn_events (id, spawn_id, seq, type, created_at, owner_email)
            VALUES ($1, $2, 0, 'text', now() - interval '10 seconds', 'local@localhost')`,
        args: [`${spawnId}-step0`, spawnId],
      });

      const reconciled = await reconcileV3SpawnsOnce();

      // The healthy spawn must NOT appear in the reconciled set.
      expect(reconciled.some((r) => r.id === spawnId)).toBe(false);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("running");

      const nodeRow = await getDbExec().execute({
        sql: `SELECT status, current_spawn_id FROM v3_nodes WHERE id = $1`,
        args: [nodeId],
      });
      expect((nodeRow.rows[0] as any).status).toBe("running");
      expect((nodeRow.rows[0] as any).current_spawn_id).toBe(spawnId);
    }, 20_000);

    it("HOST-NATIVE liveness fix guard (production incident 2026-07-18, sdlc-merge-review): a healthy long-running acp:claude-code spawn past the 2-minute no-VM grace, with a fresh spawn_events heartbeat, is NOT reset", async () => {
      // Reproduces the EXACT production shape that broke task board #95's
      // `sdlc-merge-review` gate: an `agent:"claude-code"` node runs host-
      // native (runtime='acp:claude-code', vm_name NULL — there is never a
      // microVM for this runtime, see server/runtime/claude-code-worker.ts).
      // Pre-fix, `liveVm` (runtime==='microvm') was the ONLY liveness signal,
      // so `noVmAndAged` fired on ANY non-microvm spawn older than
      // V3_SPAWN_NOVM_GRACE_MS (2 min) regardless of activity — confirmed in
      // production: 3/3 real mergeReviewStart dispatches were reset as "no
      // live microVM" at ~2 minutes while each had 90+ live spawn_events rows
      // continuing for several more minutes. This fixture is that exact
      // shape: started 6 minutes ago (past the 2-min grace), a FRESH
      // heartbeat (10s ago) proving it is still genuinely working. It MUST be
      // left running.
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce } = await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-hostnative-healthy";
      const nodeId = "f10-node-hostnative-healthy";
      const spawnId = "f10-spawn-hostnative-healthy";

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
      // runtime='acp:claude-code', vm_name NULL — host-native, never a VM.
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'acp:claude-code', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      await getDbExec().execute({
        sql: `INSERT INTO spawn_events (id, spawn_id, seq, type, created_at, owner_email)
            VALUES ($1, $2, 0, 'text', now() - interval '10 seconds', 'local@localhost')`,
        args: [`${spawnId}-step0`, spawnId],
      });

      const reconciled = await reconcileV3SpawnsOnce();

      // The healthy host-native spawn must NOT appear in the reconciled set.
      expect(reconciled.some((r) => r.id === spawnId)).toBe(false);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("running");

      const nodeRow = await getDbExec().execute({
        sql: `SELECT status, current_spawn_id FROM v3_nodes WHERE id = $1`,
        args: [nodeId],
      });
      expect((nodeRow.rows[0] as any).status).toBe("running");
      expect((nodeRow.rows[0] as any).current_spawn_id).toBe(spawnId);
    }, 20_000);

    it("host-native spawn with NO heartbeat at all is still reset past the no-VM grace (unchanged crash-recovery behavior)", async () => {
      // The fix must not regress the ORIGINAL crash-recovery case: a
      // host-native spawn that never emitted a single spawn_events row (e.g.
      // the orchestrator process was killed before the child process ever
      // streamed anything) has no liveness signal at all and must still be
      // reconciled once past the no-VM grace — exactly the pre-fix behavior,
      // just now reached via `!anyLiveSignal` instead of `!liveVm`.
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce } = await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-hostnative-orphan";
      const nodeId = "f10-node-hostnative-orphan";
      const spawnId = "f10-spawn-hostnative-orphan";

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
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'acp:claude-code', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });

      const reconciled = await reconcileV3SpawnsOnce();
      expect(
        reconciled.some((r) => r.id === spawnId && r.to === "failed"),
      ).toBe(true);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status, error FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("failed");
      expect((spawnRow.rows[0] as any).error).toContain("no live microVM");
    }, 20_000);

    it("HOST-NATIVE stall threshold fix guard (same production incident, follow-up): a real single-tool-call gap of >120s but <8min on a host-native spawn is NOT reset", async () => {
      // Re-verifying the hostNativeAlive fix live on production 101 exposed a
      // SECOND, related bug: a genuinely-healthy sdlc-merge-review
      // acp:claude-code spawn was reset via the eventStalled path (not the
      // no-VM-grace path) because a single real `git diff`/`gh pr diff` Bash
      // tool call blocked for 126s with zero intermediate spawn_events — the
      // CLI only emits a step at each stream-json line, so there is no
      // "still working" heartbeat WHILE a single tool call executes. More
      // spawn_events kept arriving for minutes after the reset, proving the
      // process was still alive. ORCH_SPAWN_STALL_MS (120s) was tuned for a
      // live microVM's finer-grained heartbeat, not a host-native CLI's
      // real multi-minute tool-call gaps. This fixture reproduces exactly
      // that shape: a host-native spawn whose last heartbeat is 3 minutes
      // stale (comfortably past the old 120s threshold, comfortably under
      // the new 8-minute ORCH_SPAWN_HOST_NATIVE_STALL_MS). It MUST be left
      // running.
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce } = await import("./v3-spawn-reconcile.js");

      const runId = "f10-run-hostnative-slowtool";
      const nodeId = "f10-node-hostnative-slowtool";
      const spawnId = "f10-spawn-hostnative-slowtool";

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
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'acp:claude-code', now() - interval '6 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      // The heartbeat is genuinely 3 minutes stale (well past the OLD 120s
      // ORCH_SPAWN_STALL_MS, well within the NEW 8-min
      // ORCH_SPAWN_HOST_NATIVE_STALL_MS) — exactly a real slow-tool-call gap,
      // not a dead process.
      await getDbExec().execute({
        sql: `INSERT INTO spawn_events (id, spawn_id, seq, type, created_at, owner_email)
            VALUES ($1, $2, 0, 'text', now() - interval '3 minutes', 'local@localhost')`,
        args: [`${spawnId}-step0`, spawnId],
      });

      const reconciled = await reconcileV3SpawnsOnce();

      expect(reconciled.some((r) => r.id === spawnId)).toBe(false);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("running");
    }, 20_000);

    it("host-native spawn IS reset once its heartbeat is stale past the host-native threshold too (upper bound still enforced)", async () => {
      // The more generous host-native threshold must still have a ceiling —
      // a spawn whose heartbeat genuinely went silent for longer than
      // ORCH_SPAWN_HOST_NATIVE_STALL_MS is still a real dead-process signal,
      // not an infinite grace period.
      const { getDbExec } = await import("../db/index.js");
      const { reconcileV3SpawnsOnce, ORCH_SPAWN_HOST_NATIVE_STALL_MS } =
        await import("./v3-spawn-reconcile.js");

      expect(ORCH_SPAWN_HOST_NATIVE_STALL_MS).toBeGreaterThan(0);

      const runId = "f10-run-hostnative-truestall";
      const nodeId = "f10-node-hostnative-truestall";
      const spawnId = "f10-spawn-hostnative-truestall";

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
      await getDbExec().execute({
        sql: `INSERT INTO v3_spawns (id, node_id, rendered_prompt, status, runtime, started_at, owner_email)
            VALUES ($1, $2, 'test prompt', 'running', 'acp:claude-code', now() - interval '20 minutes', 'local@localhost')`,
        args: [spawnId, nodeId],
      });
      // Heartbeat 12 minutes stale — past the 8-minute host-native threshold,
      // well within the 20-minute spawn age (so this is NOT the hard-stale
      // 30-min backstop firing instead; it must be the stall path).
      await getDbExec().execute({
        sql: `INSERT INTO spawn_events (id, spawn_id, seq, type, created_at, owner_email)
            VALUES ($1, $2, 0, 'text', now() - interval '12 minutes', 'local@localhost')`,
        args: [`${spawnId}-step0`, spawnId],
      });

      const reconciled = await reconcileV3SpawnsOnce();
      expect(
        reconciled.some((r) => r.id === spawnId && r.to === "failed"),
      ).toBe(true);

      const spawnRow = await getDbExec().execute({
        sql: `SELECT status, error FROM v3_spawns WHERE id = $1`,
        args: [spawnId],
      });
      expect((spawnRow.rows[0] as any).status).toBe("failed");
      expect((spawnRow.rows[0] as any).error).toContain("host-native stall");
    }, 20_000);
  },
);
