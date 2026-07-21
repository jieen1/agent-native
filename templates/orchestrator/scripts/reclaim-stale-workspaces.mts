// One-off remediation for the 2026-07-20 disk-full production incident —
// task board #53 / SDLC-088-adjacent gap: `workspaceDestroy` never actually
// removed a workspace's checkout (fixed alongside this script; see
// destroyLocalWorkspace in ../server/v3-workspace-local.ts). Every workspace
// ever created — regardless of state — stayed on disk forever, which is the
// direct root cause: 174 real checkouts, ~48.5GB, filled /home to 100% and
// crash-looped an-postgres.
//
// Calls destroyLocalWorkspace() directly (the same function the now-fixed
// workspaceDestroy action calls) rather than going through the owner-scoped
// action, because this is a one-time ADMIN bulk remediation across every
// owner on the host, not a per-user operation — the owner-scope fail-closed
// filter that action-callers must respect has no bearing on an operator
// clearing genuinely-abandoned infrastructure state.
//
// Scope: state IN ('error','failed','destroying','ready') — every state that
// either never became usable, was already explicitly marked for destruction,
// or finished provisioning successfully. Deliberately EXCLUDES 'provisioning'
// (a workspace mid-creation is the one state where "still needed" is
// genuinely ambiguous without a live process to ask).
//
// Usage:
//   tsx scripts/reclaim-stale-workspaces.mts [--execute]
//
// Dry-run by default: prints the plan (id, state, owner, age) with no
// writes. --execute actually calls destroyLocalWorkspace for each row.
// Idempotent — a workspace whose directory is already gone is a no-op
// (destroyLocalWorkspace handles that itself).

function log(...args: unknown[]) {
  console.log("[reclaim-stale-workspaces]", ...args);
}

async function main() {
  const execute = process.argv.includes("--execute");

  const { getDbExec } = await import("@agent-native/core/db");
  const exec = getDbExec();

  const rowsRes = await exec.execute({
    sql: `SELECT id, state, owner_kind, owner_id, owner_email, created_at
          FROM v3_workspaces
          WHERE host_path IS NOT NULL
            AND state IN ('error', 'failed', 'destroying', 'ready')
          ORDER BY created_at`,
    args: [],
  });
  const rows = rowsRes.rows as Array<{
    id: string;
    state: string;
    owner_kind: string;
    owner_id: string;
    owner_email: string | null;
    created_at: string;
  }>;

  log(`mode=${execute ? "EXECUTE" : "DRY-RUN"} candidates=${rows.length}`);
  const byState = new Map<string, number>();
  for (const r of rows) byState.set(r.state, (byState.get(r.state) ?? 0) + 1);
  for (const [state, n] of byState) log(`  ${state}: ${n}`);

  if (!execute) {
    log("re-run with --execute to actually reclaim these workspaces.");
    for (const r of rows) {
      log(
        `  would destroy ${r.id} state=${r.state} owner=${r.owner_email ?? r.owner_kind + ":" + r.owner_id} created=${r.created_at}`,
      );
    }
    process.exit(0);
  }

  const { destroyLocalWorkspace } =
    await import("../server/v3-workspace-local.js");

  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await destroyLocalWorkspace(r.id);
      ok += 1;
      log(`  destroyed ${r.id} (was ${r.state})`);
    } catch (err) {
      failed += 1;
      log(
        `  FAILED ${r.id} (was ${r.state}):`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  log(`DONE: ${ok} destroyed, ${failed} failed, ${rows.length} total.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[reclaim-stale-workspaces] FATAL:", err);
  process.exit(1);
});
