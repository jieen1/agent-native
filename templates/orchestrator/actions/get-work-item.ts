import { defineAction } from "@agent-native/core";
import { resolveAccess } from "@agent-native/core/sharing";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";

// Get a single work item with its links and transition trail (the status log),
// so the item page can render the "why is this 已上线 / did the AI skip a gate"
// history (DESIGN §6.2b). Owner-scoped.
export default defineAction({
  description:
    "Get a single work item with its links and full status-transition trail.",
  schema: z.object({ id: z.string() }),
  http: { method: "GET" },
  readOnly: true,
  run: async (args) => {
    const access = await resolveAccess("work_item", args.id);
    if (!access) throw new Error(`Work item ${args.id} not found`);
    const w = access.resource as Record<string, unknown>;

    const db = getDb();
    const log = await db
      .select()
      .from(schema.workItemStatusLog)
      .where(eq(schema.workItemStatusLog.workItemId, args.id))
      .orderBy(asc(schema.workItemStatusLog.at));
    const linksFrom = await db
      .select()
      .from(schema.workItemLinks)
      .where(eq(schema.workItemLinks.fromItem, args.id));
    const linksTo = await db
      .select()
      .from(schema.workItemLinks)
      .where(eq(schema.workItemLinks.toItem, args.id));

    return {
      id: String(w.id),
      projectId: String(w.projectId),
      type: String(w.type),
      title: String(w.title),
      description: String(w.description ?? ""),
      priority: Number(w.priority ?? 0),
      assignee: (w.assignee as string | null) ?? null,
      status: String(w.status ?? ""),
      statusCategory: String(w.statusCategory ?? "todo"),
      environment: (w.environment as string | null) ?? null,
      severity: (w.severity as string | null) ?? null,
      blocked: w.blocked === 1,
      blockedReason: (w.blockedReason as string | null) ?? null,
      blockedBy: (w.blockedBy as string | null) ?? null,
      resolution: (w.resolution as string | null) ?? null,
      statusStale: w.statusStale === 1,
      execState: String(w.execState ?? "idle"),
      claimedAt: (w.claimedAt as string | null) ?? null,
      claimedBy: (w.claimedBy as string | null) ?? null,
      workflowId: (w.workflowId as string | null) ?? null,
      workflowRunId: (w.workflowRunId as string | null) ?? null,
      deliverable: w.deliverable ? JSON.parse(String(w.deliverable)) : null,
      role: access.role,
      createdAt: String(w.createdAt ?? ""),
      updatedAt: String(w.updatedAt ?? ""),
      statusLog: log.map((r) => ({
        id: r.id,
        runId: r.runId,
        actor: r.actor,
        fromStatus: r.fromStatus,
        toStatus: r.toStatus,
        blocked: r.blocked === 1,
        resolution: r.resolution,
        at: r.at,
      })),
      links: [
        ...linksFrom.map((l) => ({
          id: l.id,
          direction: "from" as const,
          kind: l.kind,
          otherItem: l.toItem,
        })),
        ...linksTo.map((l) => ({
          id: l.id,
          direction: "to" as const,
          kind: l.kind,
          otherItem: l.fromItem,
        })),
      ],
    };
  },
});
