// Append-only AUDIT helper (DESIGN §7.4.7). One small function the control
// actions, transition-work-item, and credential resolution call to record WHO
// did WHAT to WHICH target WHEN. The audit table is append-only — this writer
// only ever inserts; nothing in app code updates or deletes a row.
//
// Best-effort by design: an audit write must NEVER fail the action it records
// (a control verb that succeeded should not be reported as failed because the
// trail insert hit a transient error). `writeAudit` swallows its own errors and
// returns the row id (or null on failure) so callers stay simple.
//
// SECURITY: `detail` is a JSON bag for keys/booleans/ids ONLY — never a secret
// VALUE. The credential-resolution audit records the KEY name and a present
// boolean, never the decrypted secret (mirrors listRuntimeCredentials, §7.4.7).

import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { getDb, schema } from "../db/index.js";
import { newId, nowIso } from "../../actions/_util.js";

/** The audited action keys (a closed-ish set kept stable for querying). */
export type AuditAction =
  | "run.start"
  | "run.pause"
  | "run.resume"
  | "run.cancel"
  | "run.retry-node"
  | "run.override-node"
  | "run.resolve-human-gate"
  | "transition-work-item"
  | "credential.resolve"
  | "webhook.pr-merge"
  | "reconcile.startup";

/** The target kind an audit row points at. */
export type AuditTargetType =
  | "workflow_run"
  | "work_item"
  | "credential"
  | "node_run"
  | "system";

export interface WriteAuditArgs {
  action: AuditAction;
  /** What it targeted (run id / item id / credential key …). */
  targetType?: AuditTargetType | null;
  targetId?: string | null;
  /**
   * Explicit actor override. Defaults to the request user email; pass a run id
   * for an automation move, or a webhook source for an external caller.
   */
  actor?: string | null;
  /** A small JSON-able detail bag — keys/booleans/ids only, NEVER secret values. */
  detail?: Record<string, unknown> | null;
  /** Owner scoping override (defaults to the request owner / local user). */
  ownerEmail?: string | null;
  orgId?: string | null;
}

/**
 * Append one audit row. Best-effort: returns the new row id, or null when the
 * insert failed (swallowed so it never breaks the audited action). The actor
 * defaults to the request user; pass `actor` to attribute an automation/webhook.
 */
export async function writeAudit(args: WriteAuditArgs): Promise<string | null> {
  try {
    const db = getDb();
    const id = newId("audit");
    const actor =
      args.actor ?? getRequestUserEmail() ?? "local@localhost";
    const ownerEmail =
      args.ownerEmail ?? getRequestUserEmail() ?? "local@localhost";
    const orgId = args.orgId ?? getRequestOrgId() ?? null;
    await db.insert(schema.auditLog).values({
      id,
      actor,
      action: args.action,
      targetType: args.targetType ?? null,
      targetId: args.targetId ?? null,
      detail: args.detail ? JSON.stringify(args.detail) : null,
      at: nowIso(),
      ownerEmail,
      orgId,
    });
    return id;
  } catch {
    // Append-only trail is advisory; never fail the audited action on a write error.
    return null;
  }
}
