// One-off remediation for the 2026-07-18-onward F9 writeback org-mismatch
// incident. `dispatch-to-orchestrator.ts`/`bulk-dispatch-to-orchestrator.ts`
// tagged a dispatched run's `tags.org_id` with the DISPATCHING SESSION's
// ambient org (`getRequestOrgId()`) instead of the work item's OWN real org
// (`tracker_work_items.org_id`) — `ownerScope()` (tracker/server/lib/access.ts)
// admits a SELECT via an OR of ownerEmail-match OR org-match, so a caller
// whose live session org differs from the item's own org can still dispatch
// it (matched via ownerEmail); the writeback channel's sentinel JWT, though,
// authenticates as a fixed service identity that never equals a real user's
// ownerEmail, so it can ONLY be admitted via the org branch. A wrong org
// therefore permanently 404s every writeback callback for that run — and
// because the outbox sweep retried forever (fixed alongside this script; see
// v3-reconciler.ts's new permanent-failure classification), this produced an
// unbounded retry storm: 136 runs stuck, one reaching 28,812 attempts,
// ~172k `writeback.failed` events (98%+ of the whole v3_events table).
//
// This script re-derives each stuck run's correct org directly from
// `tracker_work_items` — safe because both apps share the SAME Postgres
// database (`agentnative`) even though neither app imports the other's ORM
// schema; this is a one-time ADMIN repair query against the shared database,
// not a standing application code path (see "multi-app-workspace" doc — the
// no-cross-app-SQL boundary governs the running APPLICATIONS, not a one-off
// human-triggered repair script).
//
// Usage:
//   tsx scripts/backfill-writeback-org-mismatch.mts [--execute]
//
// Dry-run by default: prints the plan (run id, work item, recorded vs real
// org) with no writes. --execute actually updates v3_runs.writeback_outcome
// and resets writeback_attempts/writeback_status/writeback_last_error so the
// corrected row gets a fresh, immediate retry on the next sweep tick.
// Idempotent — a run already fixed (recorded org already matches) is simply
// not selected as a mismatch on a re-run.

function log(...args: unknown[]) {
  console.log("[backfill-writeback-org-mismatch]", ...args);
}

async function main() {
  const execute = process.argv.includes("--execute");

  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();

  const rowsRes = await exec.execute({
    sql: `
      SELECT
        r.id AS run_id,
        r.writeback_outcome->>'workItemId' AS work_item_id,
        r.writeback_outcome->>'orgId' AS recorded_org,
        w.org_id AS real_org,
        w.item_key AS item_key
      FROM v3_runs r
      LEFT JOIN tracker_work_items w
        ON w.id = r.writeback_outcome->>'workItemId'
      WHERE r.writeback_status = 'pending'
        AND r.status IN ('done', 'failed', 'cancelled')
    `,
    args: [],
  });
  const rows = rowsRes.rows as Array<{
    run_id: string;
    work_item_id: string | null;
    recorded_org: string | null;
    real_org: string | null;
    item_key: string | null;
  }>;

  const mismatched = rows.filter(
    (r) => r.real_org && r.real_org !== r.recorded_org,
  );
  const orphaned = rows.filter((r) => !r.real_org);

  log(
    `mode=${execute ? "EXECUTE" : "DRY-RUN"} total_pending=${rows.length} ` +
      `org_mismatch=${mismatched.length} orphaned(no matching work item)=${orphaned.length}`,
  );

  for (const r of mismatched) {
    log(
      `  ${execute ? "fixing" : "would fix"} run ${r.run_id} item=${
        r.item_key ?? r.work_item_id
      }: ${r.recorded_org ?? "(none)"} -> ${r.real_org}`,
    );
  }
  for (const r of orphaned) {
    log(
      `  SKIP (no matching tracker_work_items row) run ${r.run_id} item=${r.work_item_id} — ` +
        `will be classified permanently-failed on its next retry instead of retrying forever`,
    );
  }

  if (!execute) {
    log("re-run with --execute to actually apply the fix.");
    process.exit(0);
  }

  let ok = 0;
  let failed = 0;
  for (const r of mismatched) {
    try {
      await exec.execute({
        sql: `
          UPDATE v3_runs
          SET writeback_outcome = jsonb_set(writeback_outcome, '{orgId}', to_jsonb($1::text)),
              writeback_attempts = 0,
              writeback_status = 'pending',
              writeback_last_error = NULL
          WHERE id = $2
        `,
        args: [r.real_org, r.run_id],
      });
      ok += 1;
      log(`  fixed ${r.run_id}`);
    } catch (err) {
      failed += 1;
      log(
        `  FAILED ${r.run_id}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  log(
    `DONE: ${ok} fixed, ${failed} failed, ${mismatched.length} total mismatched.`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-writeback-org-mismatch] FATAL:", err);
  process.exit(1);
});
