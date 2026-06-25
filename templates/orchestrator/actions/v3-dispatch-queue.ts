/**
 * dispatch.queue — list queued/pending nodes waiting for dispatch (design §8.7).
 *
 * Returns nodes that are ready or pending (not yet dispatched to a worker),
 * with their waiting_for classification:
 *   - "deps"     : pending, deps not yet satisfied
 *   - "vm"       : ready, waiting for a free pool slot
 *   - "approval" : awaiting human gate resolution
 *   - "acp"      : ready, agent runtime is acp (waiting for ACP connection)
 *
 * G21: new action file for missing dispatch.queue tool.
 */

import { defineAction } from "@agent-native/core";
import { eq, and, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";

type WaitingFor = "deps" | "vm" | "approval" | "acp";

export const dispatchQueue = defineAction({
  description:
    "List queued nodes waiting for dispatch. Optionally filter by runId. " +
    "Returns node id, run id, queued_at, and waiting_for classification " +
    "(deps|vm|approval|acp) per design §8.7.",
  schema: z.object({
    /** Filter to a specific run. Omit for all active runs. */
    runId: z.string().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Load non-terminal nodes for inspection
    const statusCondition = sql`${v3Schema.v3Nodes.status} IN ('pending', 'ready', 'awaiting-approval')`;
    const whereCondition = args.runId
      ? and(statusCondition, eq(v3Schema.v3Nodes.runId, args.runId))
      : statusCondition;

    const nodeRows = await db
      .select({
        id: v3Schema.v3Nodes.id,
        runId: v3Schema.v3Nodes.runId,
        nodeIdInDag: v3Schema.v3Nodes.nodeIdInDag,
        type: v3Schema.v3Nodes.type,
        status: v3Schema.v3Nodes.status,
        iteration: v3Schema.v3Nodes.iteration,
        fanoutIndex: v3Schema.v3Nodes.fanoutIndex,
        startedAt: v3Schema.v3Nodes.startedAt,
      })
      .from(v3Schema.v3Nodes)
      .where(whereCondition)
      .orderBy(v3Schema.v3Nodes.startedAt);

    if (!nodeRows.length) {
      return { queue: [], total: 0 };
    }

    // Resolve run priorities for ordering context
    const runIds = [...new Set(nodeRows.map((n) => n.runId))];
    const runRows = await db
      .select({
        id: v3Schema.v3Runs.id,
        priority: v3Schema.v3Runs.priority,
        status: v3Schema.v3Runs.status,
      })
      .from(v3Schema.v3Runs)
      .where(inArray(v3Schema.v3Runs.id, runIds));

    const runPriorityMap = new Map<string, number>(
      runRows.map((r) => [r.id, r.priority]),
    );

    // Resolve agent names from DAG to detect acp runtime — load DAGs lazily
    const dagCache = new Map<string, Array<{ id: string; agent?: string }>>();

    async function getRunDag(runId: string): Promise<Array<{ id: string; agent?: string }>> {
      if (dagCache.has(runId)) return dagCache.get(runId)!;
      const rows = await db
        .select({ dag: v3Schema.v3Runs.dag })
        .from(v3Schema.v3Runs)
        .where(eq(v3Schema.v3Runs.id, runId))
        .limit(1);
      const dag = rows[0]?.dag as { nodes?: Array<{ id: string; agent?: string }> } | null;
      const nodes = dag?.nodes ?? [];
      dagCache.set(runId, nodes);
      return nodes;
    }

    const queue: Array<{
      nodeId: string;
      runId: string;
      nodeIdInDag: string;
      type: string;
      status: string;
      iteration: number;
      fanoutIndex: number;
      runPriority: number;
      queuedAt: string | null;
      waiting_for: WaitingFor;
    }> = [];

    for (const node of nodeRows) {
      let waitingFor: WaitingFor;

      if (node.status === "awaiting-approval") {
        waitingFor = "approval";
      } else if (node.status === "pending") {
        waitingFor = "deps";
      } else {
        // ready — determine if waiting for vm or acp
        // Check if the agent uses acp runtime by looking up the DAG node
        const dagNodes = await getRunDag(node.runId);
        const dagNode = dagNodes.find((n) => n.id === node.nodeIdInDag);
        // Full acp detection requires loading the agent .md frontmatter (runtime field).
        // The DAG node records the agent name but not the runtime; that lives in the
        // agent file. We approximate: if the DAG node id or agent field contains "acp"
        // we classify as acp, otherwise vm.
        const agentField = (dagNode as any)?.agent ?? "";
        waitingFor = agentField.startsWith("acp:") ? "acp" : "vm";
      }

      queue.push({
        nodeId: node.id,
        runId: node.runId,
        nodeIdInDag: node.nodeIdInDag,
        type: node.type,
        status: node.status,
        iteration: node.iteration,
        fanoutIndex: node.fanoutIndex,
        runPriority: runPriorityMap.get(node.runId) ?? 0,
        queuedAt: node.startedAt?.toISOString() ?? null,
        waiting_for: waitingFor,
      });
    }

    // Sort by run priority DESC, then queuedAt ASC (matches reconciler order)
    queue.sort((a, b) => {
      if (b.runPriority !== a.runPriority) return b.runPriority - a.runPriority;
      return (a.queuedAt ?? "").localeCompare(b.queuedAt ?? "");
    });

    return { queue, total: queue.length };
  },
});

