// Shared business-status transition helper (DESIGN §6.2b). The ONE place that
// validates a from→to move against the project scheme, derives statusCategory,
// enforces the resolution rules, appends the status-log trail row, AND writes
// the audit row. Both the `transition-work-item` action (agent + board) and the
// PR-merge / deploy webhook (§6.2b terminal closure) call this — same gate, no
// back door, one audit trail.
//
// ACCESS: this helper assumes the caller has already resolved access to the work
// item (the action does `resolveAccess`; the webhook resolves the item by id +
// validates the webhook secret). It does NOT itself enforce sharing — that is
// the caller's boundary — so it can run under an automation/webhook context that
// has no logged-in user.

import { and, eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { newId, nowIso } from "../../actions/_util.js";
import { schemeForType } from "./schemes.js";
import { evaluateTransition, type Resolution } from "../../shared/status-schemes.js";
import { writeAudit } from "../audit/write-audit.js";

/** The overlay + stage inputs a transition may carry (mirrors the action args). */
export interface TransitionInput {
  toStatus: string;
  environment?: string | null;
  resolution?: Resolution | null;
  blocked?: boolean;
  blockedReason?: string | null;
  blockedBy?: string | null;
  severity?: string | null;
  /** The automation run making this move (for the trail + watchdog), if any. */
  runId?: string | null;
}

/** A successful transition's result (overlay-only or a real stage move). */
export interface TransitionOutcome {
  id: string;
  from: string;
  to: string;
  kind: "overlay" | "forward" | "rework" | "cancel" | "reopen";
  statusCategory: string;
  resolution: string | null;
}

/**
 * Apply a business-status transition to a work item (the §6.2b single writer
 * logic). `actor` is who is making the move — a user email, a run id, or a
 * webhook source string. Throws on an illegal transition or a missing project.
 *
 * The item row + project scheme are read here; the caller passes the already-
 * loaded item (so it can do its own access check first) and the actor.
 */
export async function applyTransition(args: {
  item: Record<string, unknown>;
  input: TransitionInput;
  actor: string;
  /** The audited action key (default the standard one; the webhook overrides). */
  auditAction?: "transition-work-item" | "webhook.pr-merge";
  /** Extra audit detail (e.g. the webhook event id). */
  auditDetail?: Record<string, unknown>;
}): Promise<TransitionOutcome> {
  const { item, input, actor } = args;
  const id = String(item.id);
  const db = getDb();

  // Load the project's scheme for this item's type.
  const projRows = await db
    .select({ statusSchemes: schema.projects.statusSchemes })
    .from(schema.projects)
    .where(eq(schema.projects.id, String(item.projectId)))
    .limit(1);
  if (projRows.length === 0) {
    throw new Error(`Project ${item.projectId} not found`);
  }
  const scheme = schemeForType(projRows[0].statusSchemes, String(item.type));
  const fromStatus = String(item.status ?? "");
  const now = nowIso();

  // Confirm a duplicate-of link exists when resolution=duplicate (validator gate).
  let hasDuplicateLink = false;
  if (input.resolution === "duplicate") {
    const dup = await db
      .select({ id: schema.workItemLinks.id })
      .from(schema.workItemLinks)
      .where(
        and(
          eq(schema.workItemLinks.fromItem, id),
          eq(schema.workItemLinks.kind, "duplicate-of"),
        ),
      )
      .limit(1);
    hasDuplicateLink = dup.length > 0;
  }

  // ── overlay-only path (no stage move) ──────────────────────────────────────
  if (input.toStatus === fromStatus) {
    const overlayPatch: Record<string, unknown> = { updatedAt: now };
    if (input.environment !== undefined)
      overlayPatch.environment = input.environment;
    if (input.severity !== undefined) overlayPatch.severity = input.severity;
    if (input.blocked !== undefined) {
      overlayPatch.blocked = input.blocked ? 1 : 0;
      if (!input.blocked) {
        overlayPatch.blockedReason = input.blockedReason ?? null;
        overlayPatch.blockedBy = input.blockedBy ?? null;
      }
    }
    if (input.blockedReason !== undefined)
      overlayPatch.blockedReason = input.blockedReason;
    if (input.blockedBy !== undefined) overlayPatch.blockedBy = input.blockedBy;

    await db
      .update(schema.workItems)
      .set(overlayPatch)
      .where(eq(schema.workItems.id, id));

    await db.insert(schema.workItemStatusLog).values({
      id: newId("wisl"),
      workItemId: id,
      runId: input.runId ?? null,
      actor,
      fromStatus,
      toStatus: fromStatus,
      blocked: input.blocked ? 1 : 0,
      resolution: String(item.resolution ?? "") || null,
      at: now,
    });

    await writeAudit({
      action: args.auditAction ?? "transition-work-item",
      targetType: "work_item",
      targetId: id,
      actor,
      detail: {
        from: fromStatus,
        to: fromStatus,
        kind: "overlay",
        blocked: input.blocked ?? null,
        ...(args.auditDetail ?? {}),
      },
    });

    return {
      id,
      from: fromStatus,
      to: fromStatus,
      kind: "overlay",
      statusCategory: String(item.statusCategory ?? "todo"),
      resolution: (item.resolution as string | null) ?? null,
    };
  }

  const decision = evaluateTransition(scheme, fromStatus, input.toStatus, {
    resolution: input.resolution ?? null,
    hasDuplicateLink,
  });
  if (!decision.ok) {
    throw new Error(`Illegal transition: ${decision.error}`);
  }

  const patch: Record<string, unknown> = {
    status: decision.toStatus,
    statusCategory: decision.statusCategory,
    resolution: decision.resolution,
    updatedAt: now,
  };
  if (input.environment !== undefined) patch.environment = input.environment;
  if (input.severity !== undefined) patch.severity = input.severity;
  if (input.blocked !== undefined) {
    patch.blocked = input.blocked ? 1 : 0;
    if (!input.blocked) {
      patch.blockedReason = input.blockedReason ?? null;
      patch.blockedBy = input.blockedBy ?? null;
    }
  }
  if (input.blockedReason !== undefined)
    patch.blockedReason = input.blockedReason;
  if (input.blockedBy !== undefined) patch.blockedBy = input.blockedBy;

  await db.update(schema.workItems).set(patch).where(eq(schema.workItems.id, id));

  await db.insert(schema.workItemStatusLog).values({
    id: newId("wisl"),
    workItemId: id,
    runId: input.runId ?? null,
    actor,
    fromStatus,
    toStatus: decision.toStatus,
    blocked: input.blocked ? 1 : 0,
    resolution: decision.resolution,
    at: now,
  });

  await writeAudit({
    action: args.auditAction ?? "transition-work-item",
    targetType: "work_item",
    targetId: id,
    actor,
    detail: {
      from: fromStatus,
      to: decision.toStatus,
      kind: decision.kind,
      resolution: decision.resolution,
      ...(args.auditDetail ?? {}),
    },
  });

  return {
    id,
    from: fromStatus,
    to: decision.toStatus,
    kind: decision.kind,
    statusCategory: decision.statusCategory,
    resolution: decision.resolution,
  };
}
