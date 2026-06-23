/**
 * P4-E: Multi-user isolation helpers for V3 actions.
 */

import { sql } from "drizzle-orm";
import { getV3Db, v3Schema } from "../db/v3.js";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface V3AccessContext {
  userId: string;
  workspaceId?: string;
  tenantId?: string;
}

export type V3ResourceKind =
  | "run"
  | "spawn"
  | "workspace"
  | "template"
  | "artifact"
  | "node";

/* ------------------------------------------------------------------ */
/*  Resolve access context from request                                 */
/* ------------------------------------------------------------------ */

export function resolveV3Access(
  req: { session?: { userId?: string; workspaceId?: string; tenantId?: string } },
  _resourceKind?: V3ResourceKind,
): V3AccessContext {
  const session = req.session ?? {};
  return {
    userId: session.userId ?? "anonymous",
    workspaceId: session.workspaceId,
    tenantId: session.tenantId,
  };
}

/* ------------------------------------------------------------------ */
/*  Query scoping (raw SQL — safe for dynamic WHERE)                    */
/* ------------------------------------------------------------------ */

/**
 * Filter V3 runs by owner_email (existing v3_runs column).
 */
export function filterByOwner(ownerEmail: string): import("drizzle-orm").SQL {
  return sql`${v3Schema.v3Runs.ownerEmail} = ${ownerEmail}`;
}

/**
 * Filter spawns by workspace.
 */
export function filterByWorkspace(workspaceId: string): import("drizzle-orm").SQL {
  return sql`${v3Schema.v3Spawns.workspaceId} = ${workspaceId}`;
}

/* ------------------------------------------------------------------ */
/*  Access assertions                                                   */
/* ------------------------------------------------------------------ */

export function assertWorkspaceAccess(
  _action: "read" | "write" | "destroy",
  resourceWorkspaceId: string,
  userWorkspaceId: string,
): void {
  if (resourceWorkspaceId !== userWorkspaceId) {
    throw new Error("Access denied: workspace mismatch");
  }
}

export function assertRunOwnership(
  runOwnerEmail: string,
  userEmailAddress: string,
): void {
  if (runOwnerEmail !== userEmailAddress) {
    throw new Error("Access denied: run owned by another user");
  }
}

/* ------------------------------------------------------------------ */
/*  Per-tenant pool cap                                                 */
/* ------------------------------------------------------------------ */

export function getTenantPoolCap(workspaceId?: string): number {
  if (!workspaceId) return 2;
  return Number(process.env.V3_POOL_CAP_PER_WORKSPACE ?? 4);
}

export function checkTenantPoolCap(
  currentCount: number,
  workspaceId?: string,
): { allowed: boolean; cap: number } {
  const cap = getTenantPoolCap(workspaceId);
  return { allowed: currentCount < cap, cap };
}

/* ------------------------------------------------------------------ */
/*  Count helpers                                                       */
/* ------------------------------------------------------------------ */

export async function countActiveWorkspacesForOwner(
  ownerEmail: string,
): Promise<number> {
  const db = getV3Db();
  const result = await db.execute(sql.raw(`
    SELECT count(*)::int AS c FROM v3_workspaces
    WHERE owner_email = ${ownerEmail}
      AND state NOT IN ('destroying', 'destroyed')
  `));
  return ((result as any).rows?.[0]?.c ?? 0) as number;
}
