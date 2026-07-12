// Server-side dependency-aware dispatch gate.
// Queries the database for upstream dependencies (blocked-by links) and
// evaluates the gate using the shared evaluateDispatchGate function.

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { ownerScope } from "./access.js";
import { computeItemKeyDisplays } from "./item-key-display.js";
import {
  evaluateDispatchGate,
  type DependencyStatusInput,
  type DispatchGateResult,
} from "../../shared/dispatch-gate.js";

// Resolve the dispatch gate for a single work item: look up all blocked-by
// links, join with the upstream work items and their 实施 stage status,
// then evaluate the gate.
export async function resolveDispatchGate(
  db: ReturnType<typeof getDb>,
  workItemId: string,
  ownerEmail: string,
  orgId: string | null,
): Promise<DispatchGateResult> {
  // Find all links where this item is the "from" side (blocked BY upstream items).
  const links = await db
    .select()
    .from(schema.links)
    .where(
      and(
        eq(schema.links.fromItemId, workItemId),
        eq(schema.links.linkType, "blocked-by"),
      ),
    );

  if (links.length === 0) {
    // No dependencies — gate is cleared.
    return { ready: true, blockedBy: [], chainedBranch: null };
  }

  const upstreamIds = links.map((l) => l.toItemId);

  const upstreamItems = await db
    .select()
    .from(schema.workItems)
    .where(
      and(
        inArray(schema.workItems.id, upstreamIds),
        ownerScope(schema.workItems),
      ),
    );

  // Look up 实施 stage status for each upstream item.
  const implStages = await db
    .select({
      workItemId: schema.stages.workItemId,
      stageStatus: schema.stages.stageStatus,
    })
    .from(schema.stages)
    .where(
      and(
        inArray(schema.stages.workItemId, upstreamIds),
        eq(schema.stages.stageName, "实施"),
      ),
    );
  const implStageByWorkItem = new Map(
    implStages.map((s) => [s.workItemId, s.stageStatus]),
  );

  const itemById = new Map(upstreamItems.map((it) => [it.id, it]));

  // F8: itemKey 消歧(读路径) — "blockedBy" messages (dispatch-to-orchestrator,
  // bulk-dispatch-to-orchestrator, enqueue-work-item all forward
  // `blockedBy[].itemKey` verbatim) show an upstream item's itemKey to a
  // human/agent; disambiguate historical duplicates here so downstream
  // consumers get it automatically without each reimplementing the lookup.
  const displays = await computeItemKeyDisplays(
    db,
    upstreamItems.map((it) => ({ id: it.id, projectId: it.projectId, itemKey: it.itemKey })),
  );

  const deps: DependencyStatusInput[] = links.map((link) => {
    const upstream = itemById.get(link.toItemId);
    if (!upstream) {
      // Item not found — treat as pending (conservative).
      return {
        id: link.toItemId,
        itemKey: "",
        status: "unknown",
        currentStageName: "",
        implStageStatus: null,
        branch: null,
      };
    }
    return {
      id: upstream.id,
      itemKey: displays.get(upstream.id) ?? upstream.itemKey ?? "",
      status: upstream.status ?? "open",
      currentStageName: upstream.currentStageName ?? "",
      implStageStatus:
        (implStageByWorkItem.get(upstream.id) as string | null) ?? null,
      branch: upstream.branch ?? null,
    };
  });

  return evaluateDispatchGate(deps);
}

// After a work item completes (its 实施 stage finishes), re-evaluate all
// downstream items that were blocked by it.
export async function reevaluateBlockedQueue(
  db: ReturnType<typeof getDb>,
  ownerEmail: string,
  orgId: string | null,
  completedItemId: string,
): Promise<void> {
  try {
    // Find all links where the completed item is the "to" side
    // (i.e., other items are blocked BY this one).
    const links = await db
      .select()
      .from(schema.links)
      .where(
        and(
          eq(schema.links.toItemId, completedItemId),
          eq(schema.links.linkType, "blocked-by"),
        ),
      );

    if (links.length === 0) return;

    const now = new Date().toISOString();

    for (const link of links) {
      const fromItemId = link.fromItemId; // the downstream item that was blocked

      // Resolve the gate for this downstream item.
      const gate = await resolveDispatchGate(db, fromItemId, ownerEmail, orgId);

      // Find the exec_queue row for this item.
      const queueRows = await db
        .select()
        .from(schema.execQueue)
        .where(eq(schema.execQueue.workItemId, fromItemId))
        .limit(1);

      if (queueRows.length === 0) continue;

      const queueRow = queueRows[0]!;

      if (queueRow.status === "blocked" && gate.ready) {
        // Gate cleared — unblock the item.
        await db
          .update(schema.execQueue)
          .set({
            status: "queued",
            blockedBy: "[]",
          })
          .where(eq(schema.execQueue.id, queueRow.id));

        // Also update work_items.status from blocked to queued.
        await db
          .update(schema.workItems)
          .set({ status: "queued", updatedAt: now })
          .where(eq(schema.workItems.id, fromItemId));

        // Write an activity log entry.
        await db.insert(schema.activities).values({
          id: `act_unblock_${fromItemId.slice(0, 6)}_${now.replace(/\D/g, "").slice(0, 14)}`,
          workItemId: fromItemId,
          actorKind: "agent",
          actorName: "智能体",
          eventType: "解除阻塞",
          payload: JSON.stringify({ triggeredBy: completedItemId }),
          createdAt: now,
          ownerEmail,
          orgId,
        });
      } else if (queueRow.status === "blocked") {
        // Still blocked — update the blockedBy JSON.
        await db
          .update(schema.execQueue)
          .set({
            blockedBy: JSON.stringify(
              gate.blockedBy.map((d) => ({ id: d.id, itemKey: d.itemKey })),
            ),
          })
          .where(eq(schema.execQueue.id, queueRow.id));
      }
    }
  } catch (err) {
    // Non-fatal — swallow errors so the caller's main flow is unaffected.
    console.error("[reevaluateBlockedQueue] non-fatal error:", err);
  }
}
