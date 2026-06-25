import { defineAction } from "@agent-native/core";
import { getDbExec } from "@agent-native/core/db";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { callOrchestratorTool } from "../server/lib/orchestrator-client.js";

// Read activity for a dispatched work item back from the orchestrator: the
// brain transcript (via the stored threadId) plus any tagged runs/spawns
// (via tagMatch on the tracker tags) and their DAG node statuses, and the
// final delivery (PR / branch / commit) parsed from the transcript + tags.
// All over MCP tools/call.
//
// The orchestrator MCP renders a CONCISE (truncated) text for chat hosts, but
// read-only actions now also carry the full payload via `structuredContent`,
// which `callOrchestratorTool` reads first. We still tolerate a truncated
// string (older orchestrator builds) and surface it as a soft error rather
// than silently showing an empty transcript.

type BrainEventRow = {
  id?: string;
  seq?: number;
  type?: string;
  text?: string | null;
  toolName?: string | null;
  createdAt?: string;
};

// Pull the first GitHub PR URL out of any transcript text.
const PR_URL_RE = /https?:\/\/[^\s)]+\/pull\/\d+/i;
const BRANCH_RE = /\b(orchestrator\/[A-Za-z0-9._\-/]+)\b/;
const COMMIT_RE = /\b([0-9a-f]{7,40})\b/;

function extractDelivery(events: BrainEventRow[]): {
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  commit?: string | null;
} | null {
  // Scan newest-first so a later, more authoritative delivery wins.
  let prUrl: string | null = null;
  let branch: string | null = null;
  let commit: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.text;
    if (typeof t !== "string" || !t) continue;
    if (!prUrl) {
      const m = t.match(PR_URL_RE);
      if (m) prUrl = m[0];
    }
    if (!branch) {
      const m = t.match(BRANCH_RE);
      if (m) branch = m[1] ?? null;
    }
    if (!commit && /commit|sha|pushed/i.test(t)) {
      const m = t.match(COMMIT_RE);
      if (m) commit = m[1] ?? null;
    }
    if (prUrl && branch) break;
  }
  if (!prUrl && !branch && !commit) return null;
  const prNumber = prUrl ? Number(prUrl.match(/\/pull\/(\d+)/)?.[1]) : null;
  return {
    prUrl,
    prNumber: Number.isFinite(prNumber) ? prNumber : null,
    branch,
    commit,
  };
}

// The orchestrator's brain_task slot state for this item's brain thread. The
// tracker shares the orchestrator's Postgres, so we read the admission-gate row
// directly (keyed by thread_id) to learn whether the item is queued, running,
// done, failed, or cancelled — and the bound run id once it starts executing.
// This is the live slot gate the board reflects. Best-effort: returns null if
// the table isn't present (e.g. non-Postgres dev) so activity still renders.
async function readBrainTaskSlot(threadId: string): Promise<{
  status: string;
  runId: string | null;
} | null> {
  try {
    const { rows } = await getDbExec().execute({
      sql: `SELECT status, run_id FROM brain_tasks WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      args: [threadId],
    });
    if (!rows.length) return null;
    const row = rows[0] as { status?: string; run_id?: string | null };
    return {
      status: String(row.status ?? ""),
      runId: (row.run_id as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

// Map the orchestrator slot state onto the work-item lifecycle so the board
// reflects queued → running → done.
//
// CRITICAL: the brain_TASK lifecycle is authoritative, NOT the brain thread and
// NOT a parsed "delivery". The brain's first turn dispatches work then ENDS (a
// token-saving pattern), so the brain thread flips idle/done immediately while
// the bound DAG run is still executing — and a delivery regex can false-match
// the requirement text (e.g. a path like `orchestrator/app/routes/...`). The
// brain_task row is released to `done`/`failed` ONLY when the bound run reaches
// terminal (releaseBrainTaskForThread) or the reaper confirms real completion.
// So:
//   - slot running/queued  → item is still in flight; NEVER mark it done, even
//     if a "delivery" was parsed from the transcript.
//   - slot done            → mark done; a parsed delivery is corroboration only.
//   - slot failed/cancelled → mark failed.
//   - no slot row at all   → fall back to delivery (legacy / non-Postgres).
function deriveItemStatus(
  slotStatus: string | null,
  hasDelivery: boolean,
): string | null {
  // While the slot is live, the work is ongoing regardless of transcript text.
  if (slotStatus === "running") return "running";
  if (slotStatus === "queued") return "queued";
  // Terminal slot is the source of truth for done/failed.
  if (slotStatus === "done") return "done";
  if (slotStatus === "failed" || slotStatus === "cancelled") return "failed";
  // No brain_task row found: only then trust a parsed delivery as a done signal.
  if (slotStatus === null && hasDelivery) return "done";
  return null; // unknown → leave the stored status untouched
}

export default defineAction({
  description:
    "Read live activity for a work item from the orchestrator: the brain " +
    "transcript, any runs/spawns tagged for this item with their DAG node " +
    "statuses, and the final delivery (PR / branch / commit).",
  schema: z.object({
    workItemId: z.string().min(1).describe("Work item to read activity for"),
  }),
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");

    const db = getDb();
    const item = (
      await db
        .select()
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found or not accessible");

    if (!item.orchestratorThreadId) {
      return {
        dispatched: false,
        thread: null,
        events: [],
        runs: [],
        spawns: [],
        delivery: null,
      };
    }

    const tagMatch = { source: "tracker", item_id: item.id };

    // Fan out: brain transcript + tagged runs + tagged spawns + the global
    // brain queue snapshot (the live concurrency gate). Plus the per-item
    // brain_task slot read straight from the shared DB. Tolerate partial
    // failures so a transient orchestrator hiccup still shows what it can.
    const [threadRes, runsRes, spawnsRes, queueRes, slot] = await Promise.all([
      Promise.allSettled([
        callOrchestratorTool(ownerEmail, "brain-thread", {
          threadId: item.orchestratorThreadId,
        }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(ownerEmail, "runsList", { tagMatch, limit: 50 }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(ownerEmail, "spawnList", { tagMatch, limit: 100 }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(ownerEmail, "brain-queue-status", {}),
      ]).then((r) => r[0]!),
      // Per-item slot state, read directly from the shared brain_tasks table.
      readBrainTaskSlot(item.orchestratorThreadId),
    ]);

    const errors: Record<string, string> = {};

    // The brain-thread payload may arrive as the full object (structuredContent)
    // or — on an older orchestrator that only returns concise truncated text —
    // as a raw string. Guard for both so we never crash and surface a clear
    // hint when the payload was truncated.
    let threadData: { thread?: unknown; events?: unknown[] } | null = null;
    if (threadRes.status === "fulfilled") {
      const data = threadRes.value.data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        threadData = data as { thread?: unknown; events?: unknown[] };
      } else if (typeof data === "string") {
        errors.thread =
          "Orchestrator returned a truncated transcript (no structuredContent); " +
          "update the orchestrator to surface read-only results in full.";
      }
    } else {
      errors.thread = String(threadRes.reason?.message ?? threadRes.reason);
    }

    const runs =
      runsRes.status === "fulfilled" && Array.isArray(runsRes.value.data)
        ? (runsRes.value.data as Array<Record<string, unknown>>)
        : [];
    const spawns =
      spawnsRes.status === "fulfilled" && Array.isArray(spawnsRes.value.data)
        ? (spawnsRes.value.data as unknown[])
        : [];

    if (runsRes.status === "rejected")
      errors.runs = String(runsRes.reason?.message ?? runsRes.reason);
    if (spawnsRes.status === "rejected")
      errors.spawns = String(spawnsRes.reason?.message ?? spawnsRes.reason);

    // For each run, pull its DAG node statuses (design / develop / review / …)
    // so the panel can show node-level progress. Best-effort + bounded.
    const runsWithNodes = await Promise.all(
      runs.slice(0, 5).map(async (run) => {
        const runId = typeof run.id === "string" ? run.id : null;
        let nodes: Array<{
          nodeIdInDag: string;
          type?: string | null;
          status: string;
          error?: string | null;
        }> = [];
        if (runId) {
          try {
            const nodeRes = await callOrchestratorTool(
              ownerEmail,
              "v3RunNodes",
              {
                runId,
              },
            );
            if (Array.isArray(nodeRes.data)) {
              nodes = (nodeRes.data as Array<Record<string, unknown>>)
                .map((n) => ({
                  nodeIdInDag: String(n.nodeIdInDag ?? ""),
                  type: (n.type as string | null) ?? null,
                  status: String(n.status ?? ""),
                  error: (n.error as string | null) ?? null,
                }))
                .filter((n) => n.nodeIdInDag);
            }
          } catch {
            // node fetch is best-effort
          }
        }
        return { ...run, nodes };
      }),
    );

    const events: BrainEventRow[] = Array.isArray(threadData?.events)
      ? (threadData!.events as BrainEventRow[])
      : [];

    const delivery = extractDelivery(events);

    // Global concurrency gate snapshot (counts + driver health).
    const queue =
      queueRes.status === "fulfilled" &&
      queueRes.value.data &&
      typeof queueRes.value.data === "object"
        ? (queueRes.value.data as Record<string, unknown>)
        : null;
    if (queueRes.status === "rejected")
      errors.queue = String(queueRes.reason?.message ?? queueRes.reason);

    // ── Status writeback ──────────────────────────────────────────────────────
    // Reflect the live slot gate (queued → running → done) onto the work item so
    // the board updates without a human touching it. The bound run id (once the
    // brain starts executing) is also captured for display/proof. A delivered PR
    // forces `done`. We only write when something actually changed.
    const runIdFromSlot = slot?.runId ?? null;
    const runIdFromRuns =
      runsWithNodes.length && typeof runsWithNodes[0]?.id === "string"
        ? (runsWithNodes[0]!.id as string)
        : null;
    const orchestratorRunId = runIdFromSlot ?? runIdFromRuns ?? null;

    const nextStatus = deriveItemStatus(slot?.status ?? null, !!delivery);
    const patch: Record<string, unknown> = {};
    if (nextStatus && nextStatus !== item.status) patch.status = nextStatus;
    if (orchestratorRunId && orchestratorRunId !== item.orchestratorRunId)
      patch.orchestratorRunId = orchestratorRunId;
    if (Object.keys(patch).length) {
      patch.updatedAt = new Date().toISOString();
      await db
        .update(schema.workItems)
        .set(patch)
        .where(eq(schema.workItems.id, item.id))
        .catch(() => {
          // writeback is best-effort; never fail the read
        });
    }

    return {
      dispatched: true,
      threadId: item.orchestratorThreadId,
      thread: threadData?.thread ?? null,
      events,
      runs: runsWithNodes,
      spawns,
      delivery,
      // The live slot state for THIS item + the global gate snapshot.
      slot: slot ?? null,
      itemStatus: nextStatus ?? item.status,
      orchestratorRunId,
      queue,
      errors: Object.keys(errors).length ? errors : undefined,
    };
  },
});
