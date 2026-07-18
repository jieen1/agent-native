import { defineAction } from "@agent-native/core";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";
import {
  computeMergeGate,
  type MergeOverrideSnapshot,
  type MergeReviewSnapshot,
  type MergeReviewStatus,
} from "../server/engine/merge-review-gate.js";
import { newId } from "./_util.js";
import { workflowRun } from "./v3-workflow.js";
import { assertWorkspaceExists } from "./v3-workspace.js";

/**
 * Task board #95 — mandatory independent-review gate ahead of
 * `workspaceMergePr`. Three actions:
 *  - `mergeReviewStart` dispatches a SEPARATE `sdlc-merge-review` DAG run
 *    (own `agent:"claude-code"` node, re-fetches the real diff itself — see
 *    workflow-library-seed.ts) — a genuinely independent second pass, not a
 *    re-read of the original dev/review nodes' own verdict. Goes through the
 *    SAME `workflowRun` dispatch path every other run uses, so the existing
 *    claude-code-node concurrency admission gate (server/queue/
 *    claude-code-admit.ts) applies automatically — no separate concurrency
 *    mechanism to bypass or reinvent.
 *  - `mergeReviewGet` reads the latest review run's live verdict (never
 *    copied into a second table) plus any recorded human override, and
 *    returns the computed merge-gate decision (server/engine/merge-review-
 *    gate.ts) for RunMergeControl to render/enforce.
 *  - `mergeReviewOverride` records a human's explicit "I saw the findings,
 *    merge anyway" decision with a reason. `agentTool: false` — this is
 *    deliberately NOT something the orchestrator agent can grant itself; it
 *    exists so a human stays the one deciding to bypass a flagged review, not
 *    a silent agent-side workaround.
 */

/** Find the latest `sdlc-merge-review` run tagged for this workspace, owner-
 *  scoped. Shared by all three actions below so they agree on "latest". */
async function findLatestReviewRun(
  db: ReturnType<typeof getV3Db>,
  ownerEmail: string,
  workspaceId: string,
): Promise<{
  id: string;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
} | null> {
  const rows = await db
    .select({
      id: v3Schema.v3Runs.id,
      status: v3Schema.v3Runs.status,
      startedAt: v3Schema.v3Runs.startedAt,
      completedAt: v3Schema.v3Runs.completedAt,
    })
    .from(v3Schema.v3Runs)
    .where(
      and(
        eq(v3Schema.v3Runs.ownerEmail, ownerEmail),
        sql`${v3Schema.v3Runs.tags} @> ${JSON.stringify({ mergeReviewFor: workspaceId })}::jsonb`,
      ),
    )
    // Mirrors runsList's own "latest run" idiom (actions/v3-runs.ts) — startedAt
    // is null until the reconciler picks a run up, so a brand-new pending
    // review can briefly sort behind an older terminal one. Narrow, already-
    // accepted race (same as runsList's default view); mergeReviewStart avoids
    // the practical case that matters (a duplicate in-flight dispatch) by
    // checking for an existing pending/running review before starting a new one.
    .orderBy(desc(v3Schema.v3Runs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Read a completed/failed review run's single node into a gate-ready
 *  snapshot (verdict/summary/findings come straight off the node's own
 *  output artifact — mirrors nodeSummary/runSummary's own artifact read). */
async function loadReviewSnapshot(
  db: ReturnType<typeof getV3Db>,
  run: {
    id: string;
    status: string;
    startedAt: Date | null;
    completedAt: Date | null;
  },
): Promise<MergeReviewSnapshot> {
  const nodeRows = await db
    .select({
      status: v3Schema.v3Nodes.status,
      error: v3Schema.v3Nodes.error,
      outputArtifactId: v3Schema.v3Nodes.outputArtifactId,
    })
    .from(v3Schema.v3Nodes)
    .where(eq(v3Schema.v3Nodes.runId, run.id))
    .limit(1);
  const node = nodeRows[0] ?? null;

  let verdict: MergeReviewSnapshot["verdict"] = null;
  let summary: string | null = null;
  let findings: unknown[] | null = null;

  if (node?.outputArtifactId) {
    const artRows = await db
      .select({
        objectContent: v3Schema.v3Artifacts.objectContent,
        textContent: v3Schema.v3Artifacts.textContent,
      })
      .from(v3Schema.v3Artifacts)
      .where(eq(v3Schema.v3Artifacts.id, node.outputArtifactId))
      .limit(1);
    const art = artRows[0];
    let parsed: Record<string, unknown> | null =
      (art?.objectContent as Record<string, unknown> | null) ?? null;
    if (!parsed && art?.textContent) {
      try {
        parsed = JSON.parse(art.textContent) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (parsed) {
      verdict =
        parsed.verdict === "safe_to_merge" ||
        parsed.verdict === "concerns_found"
          ? parsed.verdict
          : null;
      summary = typeof parsed.summary === "string" ? parsed.summary : null;
      findings = Array.isArray(parsed.findings) ? parsed.findings : null;
    }
  }

  return {
    reviewRunId: run.id,
    status: run.status as MergeReviewStatus,
    verdict,
    summary,
    findings,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    error: node?.error ?? null,
  };
}

async function loadLatestOverride(
  db: ReturnType<typeof getV3Db>,
  ownerEmail: string,
  workspaceId: string,
): Promise<MergeOverrideSnapshot | null> {
  const rows = await db
    .select({
      reviewRunId: v3Schema.v3MergeOverrides.reviewRunId,
      reason: v3Schema.v3MergeOverrides.reason,
      overriddenBy: v3Schema.v3MergeOverrides.overriddenBy,
      createdAt: v3Schema.v3MergeOverrides.createdAt,
    })
    .from(v3Schema.v3MergeOverrides)
    .where(
      and(
        eq(v3Schema.v3MergeOverrides.ownerEmail, ownerEmail),
        eq(v3Schema.v3MergeOverrides.workspaceId, workspaceId),
      ),
    )
    .orderBy(desc(v3Schema.v3MergeOverrides.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    reviewRunId: row.reviewRunId,
    reason: row.reason,
    overriddenBy: row.overriddenBy,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

export const mergeReviewStart = defineAction({
  description:
    "Start a mandatory INDEPENDENT pre-merge review for a V3 workspace (task board #95) — " +
    "dispatches the dedicated `sdlc-merge-review` DAG template as its own separate run " +
    "(a fresh agent:'claude-code' pass that re-fetches the real diff itself, not a re-read " +
    "of the original dev/review nodes' verdict). Returns the existing in-flight review " +
    "instead of starting a duplicate if one is already pending/running for this workspace. " +
    "Call mergeReviewGet to poll the resulting verdict.",
  schema: z.object({
    workspaceId: z.string(),
    /** The origin run whose diff is being reviewed — used to pull the
     *  original spec/goal and PR url for the review's context. */
    runId: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = resolveOwnerEmail();
    await assertWorkspaceExists(args.workspaceId);

    const existing = await findLatestReviewRun(
      db,
      ownerEmail,
      args.workspaceId,
    );
    if (
      existing &&
      (existing.status === "pending" ||
        existing.status === "running" ||
        existing.status === "paused")
    ) {
      return {
        reviewRunId: existing.id,
        status: existing.status,
        alreadyRunning: true,
      };
    }

    const originRows = await db
      .select({ inputs: v3Schema.v3Runs.inputs, tags: v3Schema.v3Runs.tags })
      .from(v3Schema.v3Runs)
      .where(
        and(
          eq(v3Schema.v3Runs.id, args.runId),
          eq(v3Schema.v3Runs.ownerEmail, ownerEmail),
        ),
      )
      .limit(1);
    const origin = originRows[0];
    const originInputs = (origin?.inputs ?? {}) as Record<string, unknown>;
    const originTags = (origin?.tags ?? {}) as Record<string, unknown>;

    const spec =
      typeof originInputs.spec === "string" && originInputs.spec.trim()
        ? originInputs.spec
        : typeof originInputs.goal === "string" && originInputs.goal.trim()
          ? originInputs.goal
          : "(未提供原始规格 — 请仅依据实际 diff 判断改动本身是否合理、安全、且没有明显问题。)";
    const prUrl =
      typeof originTags.pr_url === "string"
        ? originTags.pr_url
        : typeof originTags.prUrl === "string"
          ? originTags.prUrl
          : "";

    const result = await workflowRun.run({
      template: "sdlc-merge-review",
      inputs: { workspaceId: args.workspaceId, spec, prUrl },
      tags: { mergeReviewFor: args.workspaceId, originRunId: args.runId },
      priority: 0,
    });

    return {
      reviewRunId: result.runId,
      status: result.status,
      alreadyRunning: false,
    };
  },
});

export const mergeReviewGet = defineAction({
  description:
    "Get the independent pre-merge review state for a V3 workspace (task board #95): " +
    "the latest sdlc-merge-review run's live verdict/summary/findings (if any), any " +
    "recorded human override, and the computed merge-gate decision " +
    "{ canMerge, source, reason } RunMergeControl uses to enable/disable the merge button.",
  schema: z.object({ workspaceId: z.string() }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = resolveOwnerEmail();

    const latestRun = await findLatestReviewRun(
      db,
      ownerEmail,
      args.workspaceId,
    );
    const review = latestRun ? await loadReviewSnapshot(db, latestRun) : null;
    const override = await loadLatestOverride(db, ownerEmail, args.workspaceId);
    const gate = computeMergeGate({ review, override });

    return {
      workspaceId: args.workspaceId,
      review,
      override,
      canMerge: gate.canMerge,
      source: gate.source,
      reason: gate.reason,
    };
  },
});

export const mergeReviewOverride = defineAction({
  description:
    "Record a human's explicit override of the independent pre-merge review (task board " +
    "#95) — 'I saw the findings, merge anyway', with a required reason. UI/HTTP-only " +
    "(agentTool:false): a human must be the one making this call, never the agent on its " +
    "own behalf. Pinned to the CURRENT latest review run, so a later, different review " +
    "for the same workspace is not silently covered by a stale override.",
  schema: z.object({
    workspaceId: z.string(),
    reason: z.string().min(1, "请说明确认合并的理由"),
  }),
  agentTool: false,
  run: async (args) => {
    const db = getV3Db();
    const ownerEmail = resolveOwnerEmail();
    await assertWorkspaceExists(args.workspaceId);

    const latest = await findLatestReviewRun(db, ownerEmail, args.workspaceId);
    const id = newId("v3mo");
    const reason = args.reason.trim();

    await db.insert(v3Schema.v3MergeOverrides).values({
      id,
      workspaceId: args.workspaceId,
      reviewRunId: latest?.id ?? null,
      reason,
      overriddenBy: ownerEmail,
      ownerEmail,
    });

    return {
      id,
      workspaceId: args.workspaceId,
      reviewRunId: latest?.id ?? null,
      reason,
      overriddenBy: ownerEmail,
    };
  },
});
