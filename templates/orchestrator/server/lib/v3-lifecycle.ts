// V3 Data Lifecycle (P4-A)
// Cleanup helpers for artifacts TTL, events TTL, and run archival.
//
// Default retention:
//   artifact_ttl_days  = 30  (configurable via env V3_ARTIFACT_TTL_DAYS)
//   event_ttl_days     = 7   (configurable via env V3_EVENT_TTL_DAYS)
//   archive_after_days = 90  (configurable via env V3_ARCHIVE_AFTER_DAYS)

import { sql, eq, and, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { getV3Db, v3Schema } from "../db/v3.js";

/* ─── Config ─────────────────────────────────────────────────────────────── */

function getArtifactTtlDays(): number {
  return Number(process.env.V3_ARTIFACT_TTL_DAYS ?? 30);
}

function getEventTtlDays(): number {
  return Number(process.env.V3_EVENT_TTL_DAYS ?? 7);
}

function getArchiveAfterDays(): number {
  return Number(process.env.V3_ARCHIVE_AFTER_DAYS ?? 90);
}

/* ─── Artifact TTL cleanup ──────────────────────────────────────────────── */

export async function cleanupArtifacts(
  db: PostgresJsDatabase<typeof v3Schema> = getV3Db(),
  ttlDays: number = getArtifactTtlDays(),
): Promise<{ deletedCount: number }> {
  // Set expires_at on artifacts that still have NULL but belong to a completed run.
  await db.execute(sql.raw(`
    UPDATE v3_artifacts a
    SET expires_at = r.completed_at + INTERVAL '${ttlDays} days'
    FROM v3_runs r
    WHERE a.expires_at IS NULL
      AND a.keep_after_run != 1
      AND r.id IN (
        SELECT DISTINCT nr.run_id FROM v3_nodes nr
        JOIN v3_spawns sp ON sp.node_id = nr.id
        WHERE sp.id = a.spawn_id
      )
      AND r.completed_at IS NOT NULL
      AND r.status IN ('done', 'failed', 'cancelled')
  `));

  // Delete expired artifacts that are not kept.
  const result = await db.execute(sql.raw(`
    DELETE FROM v3_artifacts
    WHERE expires_at IS NOT NULL
      AND expires_at < NOW()
      AND keep_after_run != 1
  `));

  return { deletedCount: (result as any).rowCount ?? 0 };
}

/* ─── Events cleanup ────────────────────────────────────────────────────── */

export async function cleanupEvents(
  db: PostgresJsDatabase<typeof v3Schema> = getV3Db(),
  ttlDays: number = getEventTtlDays(),
): Promise<{ deletedCount: number }> {
  const result = await db.execute(sql.raw(`
    DELETE FROM v3_events
    WHERE ts < NOW() - INTERVAL '${ttlDays} days'
  `));

  return { deletedCount: (result as any).rowCount ?? 0 };
}

/* ─── Expired runs listing ──────────────────────────────────────────────── */

export interface ExpiredRun {
  id: string;
  status: string;
  completedAt: Date | null;
  nodeCount: number;
  eventCount: number;
  artifactCount: number;
}

export async function listExpiredRuns(
  db: PostgresJsDatabase<typeof v3Schema> = getV3Db(),
  archiveAfterDays: number = getArchiveAfterDays(),
): Promise<ExpiredRun[]> {
  const runs = await db.execute(sql.raw(`
    SELECT id, status, completed_at
    FROM v3_runs
    WHERE status IN ('done', 'failed', 'cancelled')
      AND archived != 1
      AND completed_at IS NOT NULL
      AND completed_at < NOW() - INTERVAL '${archiveAfterDays} days'
  `));

  const rows = (runs as any).rows ?? [];
  const ids = rows.map((r: any) => r.id);
  if (ids.length === 0) return [];

  // Gather counts per run.
  const nodeRows = await db.execute(sql.raw(`
    SELECT run_id, count(*)::int AS c FROM v3_nodes
    WHERE run_id = ANY(${ids})
    GROUP BY run_id
  `));

  const eventRows = await db.execute(sql.raw(`
    SELECT run_id, count(*)::int AS c FROM v3_events
    WHERE run_id = ANY(${ids})
    GROUP BY run_id
  `));

  const artifactRows = await db.execute(sql.raw(`
    SELECT nr.run_id, count(DISTINCT a.id)::int AS c
    FROM v3_artifacts a
    JOIN v3_spawns sp ON sp.id = a.spawn_id
    JOIN v3_nodes nr ON nr.id = sp.node_id
    WHERE nr.run_id = ANY(${ids})
    GROUP BY nr.run_id
  `));

  const nodeMap = new Map((nodeRows as any).rows.map((r: any) => [r.run_id, r.c]));
  const eventMap = new Map((eventRows as any).rows.map((r: any) => [r.run_id, r.c]));
  const artifactMap = new Map((artifactRows as any).rows.map((r: any) => [r.run_id, r.c]));

  return rows.map((r: any) => ({
    id: r.id,
    status: r.status,
    completedAt: r.completed_at,
    nodeCount: nodeMap.get(r.id) ?? 0,
    eventCount: eventMap.get(r.id) ?? 0,
    artifactCount: artifactMap.get(r.id) ?? 0,
  }));
}

/* ─── Full lifecycle cleanup (daily cron entry point) ───────────────────── */

export async function runLifecycleCleanup(): Promise<{
  artifactsDeleted: number;
  eventsDeleted: number;
  expiredRuns: number;
}> {
  const artifacts = await cleanupArtifacts();
  const events = await cleanupEvents();
  const expiredRuns = await listExpiredRuns();

  return {
    artifactsDeleted: artifacts.deletedCount,
    eventsDeleted: events.deletedCount,
    expiredRuns: expiredRuns.length,
  };
}
