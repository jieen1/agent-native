// F4 — runVerdict core (docs/sdlc-impl-f1-f4.md §4A "verdict 落 run 证据").
//
// The review thread's conclusion must land in the RUN-LEVEL evidence trail —
// `v3_runs.tags.verdict` + a `review.verdict` v3_events row — not only inside
// the brain transcript (SDLC-055: verdicts that lived only in prose were
// unreadable by the tracker's review card / backlink). The `runVerdict`
// action (actions/runVerdict.ts) is a thin wrapper over `recordRunVerdict`;
// the logic lives here with an injected db so it is unit-testable
// (T-F4-05 / T-F4-10 unit halves).
//
// CHANGES_REQUESTED carries findings[]; the ONLY remediation exit is a NEW
// workflowRun in fix mode carrying those findings — enforced mechanically by
// the review phase's tool face (no Bash/Edit/Write; see brain-capability.ts),
// not by this module.

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as v3SchemaTypes from "../db/v3-schema.js";
import { v3Events, v3Runs } from "../db/v3-schema.js";

type V3Db = PostgresJsDatabase<typeof v3SchemaTypes>;

export type RunVerdict = "PASSED" | "CHANGES_REQUESTED";

export interface RecordRunVerdictArgs {
  runId: string;
  verdict: RunVerdict;
  /** Structured review findings (required non-empty for CHANGES_REQUESTED). */
  findings?: string[];
  /** The reviewing brain thread (bt_…) recording this verdict. */
  reviewThreadId?: string | null;
  /** Fail-closed owner scope (resolveOwnerEmail() at the action seam). */
  ownerEmail: string;
  orgId?: string | null;
}

export interface RecordRunVerdictResult {
  ok: true;
  runId: string;
  runStatus: string;
  verdict: RunVerdict;
  verdictAt: string;
  findingsCount: number;
  /**
   * Structural-independence readback (T-F4-04 signal): true when the run's
   * tags carry BOTH specThreadId and a reviewThreadId (the recorded one wins)
   * and they differ. False = "评审未分离" — surfaced by the S7/S5 badge.
   */
  reviewSeparated: boolean;
  /** What a CHANGES_REQUESTED reviewer must do next (informational). */
  nextStep: string;
}

/**
 * Record an independent review verdict on a terminal (or any) V3 run:
 * merges `{ verdict, verdictAt, verdictBy }` into `v3_runs.tags` and appends
 * a `review.verdict` v3_events row carrying the findings payload. Idempotent
 * in effect: re-recording overwrites the tags keys and appends a new event
 * (the event trail keeps history; the tags keys hold the latest verdict).
 */
export async function recordRunVerdict(
  db: V3Db,
  args: RecordRunVerdictArgs,
): Promise<RecordRunVerdictResult> {
  const findings = args.findings ?? [];
  if (args.verdict === "CHANGES_REQUESTED" && findings.length === 0) {
    throw new Error(
      "CHANGES_REQUESTED requires at least one finding — the findings list is " +
        "what the fix-mode workflowRun re-dispatch carries.",
    );
  }

  // Fail-closed owner scope, mirroring runSummary's read pattern.
  const [run] = await db
    .select({
      id: v3Runs.id,
      status: v3Runs.status,
      tags: v3Runs.tags,
    })
    .from(v3Runs)
    .where(
      and(eq(v3Runs.id, args.runId), eq(v3Runs.ownerEmail, args.ownerEmail)),
    )
    .limit(1);
  if (!run) throw new Error(`Run '${args.runId}' not found`);

  const t =
    run.tags && typeof run.tags === "object" && !Array.isArray(run.tags)
      ? (run.tags as Record<string, unknown>)
      : {};

  const verdictAt = new Date().toISOString();
  const newTags: Record<string, unknown> = {
    ...t,
    verdict: args.verdict,
    verdictAt,
  };
  if (args.reviewThreadId) {
    newTags.verdictBy = args.reviewThreadId;
    // Backfill reviewThreadId if the fork tag is missing (e.g. a manually
    // driven review) — never overwrite an existing fork tag.
    if (typeof t.reviewThreadId !== "string" || !t.reviewThreadId) {
      newTags.reviewThreadId = args.reviewThreadId;
    }
  }

  await db
    .update(v3Runs)
    .set({ tags: newTags })
    .where(eq(v3Runs.id, args.runId));

  // Run-level event (the durable evidence row the tracker review card reads).
  const [{ nextSeq }] = await db
    .select({
      nextSeq: sql<number>`COALESCE(MAX(${v3Events.seqNum}), 0) + 1`.mapWith(
        Number,
      ),
    })
    .from(v3Events)
    .where(eq(v3Events.runId, args.runId));

  await db.insert(v3Events).values({
    id: `ve_${randomUUID()}`,
    runId: args.runId,
    spawnId: null,
    kind: "review.verdict",
    payload: {
      verdict: args.verdict,
      findings,
      reviewThreadId: args.reviewThreadId ?? null,
      verdictAt,
    },
    seqNum: nextSeq,
    ts: new Date(),
    ownerEmail: args.ownerEmail,
    orgId: args.orgId ?? null,
  });

  const specThreadId =
    typeof t.specThreadId === "string" && t.specThreadId
      ? t.specThreadId
      : typeof t.brainThreadId === "string" && t.brainThreadId
        ? t.brainThreadId
        : null;
  const effectiveReviewThreadId =
    args.reviewThreadId ??
    (typeof t.reviewThreadId === "string" && t.reviewThreadId
      ? t.reviewThreadId
      : null);
  const reviewSeparated =
    !!specThreadId &&
    !!effectiveReviewThreadId &&
    specThreadId !== effectiveReviewThreadId;

  return {
    ok: true,
    runId: args.runId,
    runStatus: run.status,
    verdict: args.verdict,
    verdictAt,
    findingsCount: findings.length,
    reviewSeparated,
    nextStep:
      args.verdict === "CHANGES_REQUESTED"
        ? "Dispatch a NEW workflowRun in fix mode carrying these findings — the review session has no write tools and must not modify code."
        : "Deliver via workspaceCommit (createMr:true) when there are changes to ship.",
  };
}
