import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { reevaluateBlockedQueue } from "../server/lib/dispatch-gate.js";
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

export function extractDelivery(events: BrainEventRow[]): {
  prUrl?: string | null;
  prNumber?: number | null;
  branch?: string | null;
  commit?: string | null;
  // Strong = hard to false-positive on (a real PR URL, or a branch+commit
  // pair). A single bare branch-looking or commit-looking string is common
  // false-positive bait (e.g. a file path under "orchestrator/", or a hash
  // mentioned while the thread reads its own `git log` output mid-debug) and
  // must never alone be trusted as proof of a genuine delivery.
  isStrong?: boolean;
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
    isStrong: !!prUrl || (!!branch && !!commit),
  };
}

// The orchestrator's brain_task slot state for this item's brain thread.
//
// F9 (SDLC-034b): this used to be a raw SQL SELECT straight against the
// orchestrator's shared brain-task-slot table (the framework's raw db-exec
// helper, called with a literal table name in the query text) — a cross-app
// schema-coupling shortcut that broke the moment the two apps' migrations
// drifted out of step (the exact "F8 leftover transition-period
// inconsistency" this cleanup resolves). It's now a
// STRUCTURED MCP `tools/call` to the orchestrator's own `brain-task-slot`
// action (F9, orchestrator side — exposes the admission-gate row through its
// own action surface instead of the tracker reaching into its tables), over
// the same `callOrchestratorTool` client every other cross-app read in this
// file already uses. Still best-effort: any failure (older orchestrator build
// without this tool yet, orchestrator down, network hiccup) degrades to null
// so activity still renders (T-F9-07's functional half) — none of the
// exceptions here ever propagate to the caller.
async function readBrainTaskSlot(
  ownerEmail: string,
  threadId: string,
): Promise<{
  status: string;
  runId: string | null;
  updatedAt: string | null;
} | null> {
  try {
    const { data } = await callOrchestratorTool(ownerEmail, "brain-task-slot", {
      threadId,
    });
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const row = data as {
      status?: string | null;
      runId?: string | null;
      updatedAt?: string | null;
    };
    if (!row.status) return null;
    return {
      status: String(row.status),
      runId: row.runId ?? null,
      updatedAt: row.updatedAt ?? null,
    };
  } catch {
    return null;
  }
}

// Map the orchestrator slot state onto the work-item lifecycle so the board
// reflects queued → running → returned.
//
// CRITICAL: the brain_TASK lifecycle is authoritative, NOT the brain thread and
// NOT a parsed "delivery". The brain's first turn dispatches work then ENDS (a
// token-saving pattern), so the brain thread flips idle/done immediately while
// the bound DAG run is still executing — and a delivery regex can false-match
// the requirement text (e.g. a path like `orchestrator/app/routes/...`). The
// brain_task row is released to `done`/`failed` ONLY when the bound run reaches
// terminal (releaseBrainTaskForThread) or the reaper confirms real completion.
//
// F3 (T-F3-17, SDLC-058): this writeback channel NEVER derives `done`. A
// terminal-success slot (and/or a delivered PR) means the run CAME BACK —
// status `returned`, awaiting human review. `done` is exclusively written by
// the guarded transition-work-item action (human + PASSED verdict + merge
// commit, from 待人工评审). So:
//   - slot running/queued  → item is still in flight; never terminal, even
//     if a "delivery" was parsed from the transcript.
//   - slot done            → mark `returned` (run finished; review pending);
//     a parsed delivery is corroboration only.
//   - slot failed/cancelled → mark failed, UNLESS the thread was demonstrably
//     resumed and produced real new activity afterward with a STRONG delivery
//     (see below) — a transient interruption (e.g. an orchestrator container
//     restart killing the brain child mid-turn) marks the slot failed even
//     though the thread is later resumed and genuinely finishes; without this
//     override that failed mark is a one-way door the item can never recover
//     from, even after a real commit lands and is deployed. Recovery also
//     lands at `returned`, never `done`.
//   - no slot row at all   → fall back to delivery (legacy / non-Postgres),
//     also capped at `returned`.
export function deriveItemStatus(
  slotStatus: string | null,
  hasDelivery: boolean,
  recovery?: {
    isStrongDelivery: boolean;
    slotUpdatedAt: string | null;
    latestEventAt: string | null;
  },
): string | null {
  // While the slot is live, the work is ongoing regardless of transcript text.
  if (slotStatus === "running") return "running";
  if (slotStatus === "queued") return "queued";
  // Terminal slot is the source of truth for returned/failed.
  if (slotStatus === "done") return "returned";
  if (slotStatus === "failed" || slotStatus === "cancelled") {
    if (
      recovery?.isStrongDelivery &&
      recovery.slotUpdatedAt &&
      recovery.latestEventAt &&
      new Date(recovery.latestEventAt).getTime() >
        new Date(recovery.slotUpdatedAt).getTime()
    ) {
      return "returned";
    }
    return "failed";
  }
  // No brain_task row: only then trust a parsed delivery as a returned signal.
  if (slotStatus === null && hasDelivery) return "returned";
  return null; // unknown → leave the stored status untouched
}

// F3 (T-F3-17): the stage target this poll-writeback may advance to. Pure so
// tests can enumerate it. Rules (02 §8 writeback rows):
//   - run returned + STRONG delivery (PR / branch+commit) → 「验收」(待人工
//     评审) — the review-request row; THE CAP. Never 交付, never done.
//   - run returned without a strong delivery → 「测试」 (实施→测试 row).
//   - anything else → no stage change.
// Never rolls back: a stage at or past the computed target stays put.
const STAGE_LADDER = ["待办", "分析", "设计", "实施", "测试", "验收", "交付"];
export function deriveWritebackStage(
  nextStatus: string | null,
  currentStageName: string | null | undefined,
  hasStrongDelivery: boolean,
): string | null {
  if (nextStatus !== "returned") return null;
  const target = hasStrongDelivery ? "验收" : "测试";
  const curIdx = STAGE_LADDER.indexOf(currentStageName ?? "待办");
  const targetIdx = STAGE_LADDER.indexOf(target);
  // Unknown current stage → treat as earliest (advance); at/past target → keep.
  if (curIdx !== -1 && curIdx >= targetIdx) return null;
  return target;
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

    // The orchestrator's brain-thread/runsList/spawnList reads are strictly
    // owner-scoped on ITS side (V3 has no shares — see brain-thread.ts). The
    // identity that must authenticate this cross-app call is whoever actually
    // OWNS the dispatched work (item.ownerEmail — who dispatch-to-orchestrator
    // ran as), NOT the viewer currently browsing this page. ownerScope() above
    // already gated whether this viewer may see the item at all (org-level
    // access is fine there); using the viewer's own email here instead of the
    // item's real owner produced a real bug — any org-mate other than the
    // item's exact dispatching owner got "Brain thread ... not found" even
    // though the item itself rendered fine.
    const dispatchOwnerEmail = item.ownerEmail;

    // Fan out: brain transcript + tagged runs + tagged spawns + the global
    // brain queue snapshot (the live concurrency gate). Plus the per-item
    // brain_task slot read straight from the shared DB. Tolerate partial
    // failures so a transient orchestrator hiccup still shows what it can.
    const [threadRes, runsRes, spawnsRes, queueRes, slot] = await Promise.all([
      Promise.allSettled([
        callOrchestratorTool(dispatchOwnerEmail, "brain-thread", {
          threadId: item.orchestratorThreadId,
        }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(dispatchOwnerEmail, "runsList", {
          tagMatch,
          limit: 50,
        }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(dispatchOwnerEmail, "spawnList", {
          tagMatch,
          limit: 100,
        }),
      ]).then((r) => r[0]!),
      Promise.allSettled([
        callOrchestratorTool(dispatchOwnerEmail, "brain-queue-status", {}),
      ]).then((r) => r[0]!),
      // Per-item slot state, read via the orchestrator's own action surface
      // (F9 — no more raw cross-app SQL, see readBrainTaskSlot above).
      readBrainTaskSlot(dispatchOwnerEmail, item.orchestratorThreadId),
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
              dispatchOwnerEmail,
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
        return {
          id: typeof run.id === "string" ? run.id : null,
          ...run,
          nodes,
        };
      }),
    );

    const events: BrainEventRow[] = Array.isArray(threadData?.events)
      ? (threadData!.events as BrainEventRow[])
      : [];

    const delivery = extractDelivery(events);
    const latestEventAt = events.reduce<string | null>((latest, e) => {
      if (typeof e.createdAt !== "string") return latest;
      if (
        !latest ||
        new Date(e.createdAt).getTime() > new Date(latest).getTime()
      )
        return e.createdAt;
      return latest;
    }, null);

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
    // Reflect the live slot gate (queued → running → returned) onto the work
    // item so the board updates without a human touching it. The bound run id
    // (once the brain starts executing) is also captured for display/proof.
    //
    // F3 (T-F3-17, SDLC-058): this UNGUARDED poll path never writes `done` and
    // never advances the stage past 「验收」(待人工评审). A delivered PR means
    // the run RETURNED — review pending; `done` is exclusively written by the
    // guarded transition-work-item action. We only write when changed.
    const runIdFromSlot = slot?.runId ?? null;
    const runIdFromRuns =
      runsWithNodes.length && typeof runsWithNodes[0]?.id === "string"
        ? (runsWithNodes[0]!.id as string)
        : null;
    const orchestratorRunId = runIdFromSlot ?? runIdFromRuns ?? null;

    const nextStatus = deriveItemStatus(slot?.status ?? null, !!delivery, {
      isStrongDelivery: !!delivery?.isStrong,
      slotUpdatedAt: slot?.updatedAt ?? null,
      latestEventAt,
    });
    const patch: Record<string, unknown> = {};
    if (nextStatus && nextStatus !== item.status) patch.status = nextStatus;
    if (orchestratorRunId && orchestratorRunId !== item.orchestratorRunId)
      patch.orchestratorRunId = orchestratorRunId;

    // ── Stage advancement on run return (capped at 验收) ─────────────────────
    // Run returned + strong delivery → 验收 (待人工评审, the review row);
    // returned without strong delivery → 测试. Never done, never rolled back.
    // On failure, leave currentStageName as-is — the status chip shows red.
    const itemExecState =
      (item as { execState?: string | null }).execState ?? null;
    const nextStageName = deriveWritebackStage(
      nextStatus,
      item.currentStageName,
      !!delivery?.isStrong,
    );
    if (nextStageName) patch.currentStageName = nextStageName;
    // exec_state tracks the dispatch loop separately from the business stage:
    // a terminal-success run flips it to 'returned' (v24 vocabulary).
    if (nextStatus === "returned" && itemExecState !== "returned")
      patch.execState = "returned";

    if (delivery?.branch && delivery.branch !== item.branch)
      patch.branch = delivery.branch;
    // A run genuinely coming back may clear the dispatch gate for downstream
    // items that were blocked-by this one — re-evaluate them. (isGateCleared
    // keys on the 实施 stage being completed / the stage moving past 实施,
    // not on status="done", so the returned+验收 writeback still unblocks.)
    const justCompleted =
      nextStatus === "returned" && item.status !== "returned";
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
    if (justCompleted) {
      await reevaluateBlockedQueue(
        db,
        item.ownerEmail,
        item.orgId ?? null,
        item.id,
      );
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
      currentStageName: nextStageName ?? item.currentStageName,
      orchestratorRunId,
      queue,
      errors: Object.keys(errors).length ? errors : undefined,
    };
  },
});
