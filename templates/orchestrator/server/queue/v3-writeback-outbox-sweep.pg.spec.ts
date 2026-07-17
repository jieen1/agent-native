// Real-Postgres crash-simulation test for the persistent writeback outbox
// (task board #38 follow-up: "回写通道 fire-and-forget 无持久补偿(改持久
// outbox)", deferred from the earlier F9-B review).
//
// The bug this closes: the original F9 terminal hook
// (v3-reconciler.ts's finalizeRun -> writebackOnTerminal) fired the tracker
// writeback fire-and-forget, with retry/backoff running fully detached from
// the tick loop. If the process crashed or was redeployed DURING that
// detached backoff window, the writeback was lost permanently — nothing
// persisted the fact that one was owed, so nothing ever retried it.
//
// This file proves, against REAL Postgres (not a mock — v3_runs.writeback_*
// are genuine columns with real WHERE-filtered SQL, which a filter-blind
// mock DB cannot exercise; see the mock suite's own note in
// v3-reconciler.spec.ts), the task's explicit "部署窗口先验证重启打断不静默
// 滞留" requirement: enqueue an outbox row, simulate a crash BEFORE the
// fire-and-forget delivery attempt ever ran, then hand it to a FRESH
// V3Reconciler instance (standing in for "the process restarted") and
// confirm the row is picked up and completed — not silently stranded.
//
// Recipe: same one-shot `postgres:16` Docker container + real migrations
// technique as server/queue/v3-spawn-reconcile.pg.spec.ts (F10). Skips (does
// not fail) when docker is unavailable.

import { execSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

// Mock ONLY the tracker network call (onRunTerminal) — everything else
// (parseRunTags, extractDeliveryFromArtifactTexts, attemptWithBackoff) stays
// real, and every DB read/write in this file goes through the genuine
// Postgres container, not a mock.
vi.mock("../tracker-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tracker-client.js")>();
  return { ...actual, onRunTerminal: vi.fn() };
});

describe.skipIf(!dockerAvailable)(
  "task board #38 — persistent writeback outbox survives a crash mid-backoff (real Postgres)",
  () => {
    let containerId: string | null = null;

    beforeAll(async () => {
      const cid = sh(
        "docker run -d --rm -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=writeback_outbox_test " +
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
      // deliberately deferred until after this line runs.
      process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/writeback_outbox_test`;

      // Run the REAL migrations (migrateV2 + migrateV3, including the new
      // f9-writeback-outbox entry) against the fresh DB.
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

    async function insertRun(
      getDbExec: typeof import("../db/index.js").getDbExec,
      runId: string,
      opts: {
        status: "running" | "done" | "failed" | "cancelled";
        itemId: string;
        orgId: string;
        writebackStatus?: "pending" | "done" | null;
        writebackOutcome?: unknown;
        writebackAttempts?: number;
      },
    ): Promise<void> {
      const completedAt = opts.status === "running" ? null : new Date();
      await getDbExec().execute({
        sql: `INSERT INTO v3_runs
                (id, inputs, dag, status, tags, completed_at,
                 writeback_status, writeback_outcome, writeback_attempts, owner_email)
              VALUES ($1, '{}'::jsonb, '{"nodes":[]}'::jsonb, $2::v3_run_status, $3::jsonb,
                      $4, $5, $6::jsonb, $7, 'local@localhost')`,
        args: [
          runId,
          opts.status,
          JSON.stringify({ item_id: opts.itemId, org_id: opts.orgId }),
          completedAt,
          opts.writebackStatus ?? null,
          opts.writebackOutcome ? JSON.stringify(opts.writebackOutcome) : null,
          opts.writebackAttempts ?? 0,
        ],
      });
    }

    it("normal path (no regression): a terminal tracker-dispatched run's outbox row is enqueued durably, then delivered and marked done by the fast path", async () => {
      const { onRunTerminal } = await import("../tracker-client.js");
      vi.mocked(onRunTerminal).mockReset();
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);

      const { getDbExec, getV3Db } = await import("../db/index.js");
      const { V3Reconciler } = await import("../engine/v3-reconciler.js");

      const runId = "outbox-run-normal";
      await insertRun(getDbExec, runId, {
        status: "running",
        itemId: "wi-normal",
        orgId: "org-normal",
      });

      const db = getV3Db();
      const dispatcher = { spawn: async () => "unused" };
      const reconciler = new V3Reconciler(
        db as any,
        dispatcher as any,
        undefined,
        [1, 1, 1],
      );

      // Empty DAG → tick() finalizes the run to 'done' synchronously.
      await reconciler.tick(runId);

      // The enqueue write inside finalizeRun is AWAITED (unlike the old
      // fire-and-forget delivery attempt) — the row must be durably
      // 'pending' (or already 'done', if delivery raced ahead) the instant
      // tick() returns; it can never be NULL/un-enqueued at this point.
      const justAfterTick = await getDbExec().execute({
        sql: `SELECT writeback_status FROM v3_runs WHERE id = $1`,
        args: [runId],
      });
      expect(["pending", "done"]).toContain(
        (justAfterTick.rows[0] as any).writeback_status,
      );

      await vi.waitFor(async () => {
        const row = await getDbExec().execute({
          sql: `SELECT writeback_status FROM v3_runs WHERE id = $1`,
          args: [runId],
        });
        expect((row.rows[0] as any).writeback_status).toBe("done");
      });

      expect(onRunTerminal).toHaveBeenCalledTimes(1);
      expect(onRunTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "zero-delivery",
          workItemId: "wi-normal",
        }),
      );
    }, 20_000);

    it("crash simulation (部署窗口重启打断验证): an outbox row enqueued but NEVER delivered (process died before the fire-and-forget attempt ran — the exact mid-backoff-crash shape) is picked up and completed by a FRESH V3Reconciler's drainWritebackOutbox(), not silently stranded", async () => {
      const { onRunTerminal } = await import("../tracker-client.js");
      vi.mocked(onRunTerminal).mockReset();
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);

      const { getDbExec, getV3Db } = await import("../db/index.js");
      const { V3Reconciler } = await import("../engine/v3-reconciler.js");

      const runId = "outbox-run-crash";
      const outcome = {
        kind: "zero-delivery",
        workItemId: "wi-crash",
        orgId: "org-crash",
        runId,
        reason: "run-done-no-delivery",
      };

      // Simulate EXACTLY the state a real crash leaves: finalizeRun's
      // AWAITED enqueue step ran and committed (the row is durably present
      // in Postgres), but the process died before the fire-and-forget
      // delivery attempt ever started (or mid-backoff — indistinguishable
      // from the outside: writeback_status is 'pending', zero attempts
      // recorded either way).
      await insertRun(getDbExec, runId, {
        status: "done",
        itemId: "wi-crash",
        orgId: "org-crash",
        writebackStatus: "pending",
        writebackOutcome: outcome,
        writebackAttempts: 0,
      });

      expect(onRunTerminal).not.toHaveBeenCalled(); // sanity: nothing ran yet

      // "Process restarted": a BRAND NEW reconciler instance with no
      // in-memory state from before the simulated crash — the real recovery
      // path is a fresh boot's periodic sweep calling this same method.
      const db = getV3Db();
      const dispatcher = { spawn: async () => "unused" };
      const freshReconciler = new V3Reconciler(db as any, dispatcher as any);

      const drainResult = await freshReconciler.drainWritebackOutbox();
      expect(drainResult.processed).toBeGreaterThanOrEqual(1);
      expect(drainResult.succeeded).toBeGreaterThanOrEqual(1);

      expect(onRunTerminal).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "zero-delivery",
          workItemId: "wi-crash",
        }),
      );

      const row = await getDbExec().execute({
        sql: `SELECT writeback_status, writeback_last_error FROM v3_runs WHERE id = $1`,
        args: [runId],
      });
      expect((row.rows[0] as any).writeback_status).toBe("done");
    }, 20_000);

    it("real WHERE filter: drainWritebackOutbox only touches rows that are actually writeback_status='pending' — an already-done row is left untouched and never re-delivered", async () => {
      const { onRunTerminal } = await import("../tracker-client.js");
      vi.mocked(onRunTerminal).mockReset();
      vi.mocked(onRunTerminal).mockResolvedValue(undefined);

      const { getDbExec, getV3Db } = await import("../db/index.js");
      const { V3Reconciler } = await import("../engine/v3-reconciler.js");

      const alreadyDoneRunId = "outbox-run-already-done";
      await insertRun(getDbExec, alreadyDoneRunId, {
        status: "done",
        itemId: "wi-already-done",
        orgId: "org-x",
        writebackStatus: "done",
        writebackOutcome: {
          kind: "zero-delivery",
          workItemId: "wi-already-done",
          orgId: "org-x",
          runId: alreadyDoneRunId,
          reason: "run-done-no-delivery",
        },
        writebackAttempts: 1,
      });

      const db = getV3Db();
      const dispatcher = { spawn: async () => "unused" };
      const reconciler = new V3Reconciler(db as any, dispatcher as any);

      await reconciler.drainWritebackOutbox();

      // The already-'done' row must never be re-delivered by the real SQL
      // WHERE writeback_status='pending' filter.
      expect(onRunTerminal).not.toHaveBeenCalledWith(
        expect.objectContaining({ workItemId: "wi-already-done" }),
      );
    }, 20_000);

    it("keeps retrying on repeated failure (never gives up) and succeeds once the tracker recovers, across two independent drain calls", async () => {
      const { onRunTerminal } = await import("../tracker-client.js");
      vi.mocked(onRunTerminal).mockReset();
      vi.mocked(onRunTerminal).mockRejectedValueOnce(
        new Error("tracker still down"),
      );
      vi.mocked(onRunTerminal).mockResolvedValueOnce(undefined);

      const { getDbExec, getV3Db } = await import("../db/index.js");
      const { V3Reconciler } = await import("../engine/v3-reconciler.js");

      const runId = "outbox-run-retry";
      const outcome = {
        kind: "zero-delivery",
        workItemId: "wi-retry",
        orgId: "org-retry",
        runId,
        reason: "run-failed",
      };
      await insertRun(getDbExec, runId, {
        status: "failed",
        itemId: "wi-retry",
        orgId: "org-retry",
        writebackStatus: "pending",
        writebackOutcome: outcome,
        writebackAttempts: 0,
      });

      const db = getV3Db();
      const dispatcher = { spawn: async () => "unused" };
      // Single-attempt backoff schedule (no delay list) so each drain call
      // makes exactly one onRunTerminal call.
      const reconciler = new V3Reconciler(
        db as any,
        dispatcher as any,
        undefined,
        [],
      );

      const firstDrain = await reconciler.drainWritebackOutbox();
      expect(firstDrain.succeeded).toBe(0);

      const afterFirst = await getDbExec().execute({
        sql: `SELECT writeback_status, writeback_attempts FROM v3_runs WHERE id = $1`,
        args: [runId],
      });
      expect((afterFirst.rows[0] as any).writeback_status).toBe("pending");
      expect(
        Number((afterFirst.rows[0] as any).writeback_attempts),
      ).toBeGreaterThan(0);

      const secondDrain = await reconciler.drainWritebackOutbox();
      expect(secondDrain.succeeded).toBe(1);

      const afterSecond = await getDbExec().execute({
        sql: `SELECT writeback_status FROM v3_runs WHERE id = $1`,
        args: [runId],
      });
      expect((afterSecond.rows[0] as any).writeback_status).toBe("done");
    }, 20_000);
  },
);
