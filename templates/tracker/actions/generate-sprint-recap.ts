import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, inArray, max } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import {
  buildSprintRecap,
  renderSprintRecapMarkdown,
  type RecapApprovalRow,
  type RecapCommentRow,
  type RecapRunRow,
  type RecapStageRow,
} from "../shared/sprint-recap.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// M5 度量复盘 — Sprint recap generation (human-intervention timeline).
//
// Derives the recap STRICTLY from real tracker records (approvals, human
// comments, stage rollbacks, superseded re-dispatches) via the pure
// shared/sprint-recap.ts builder — never fabricated; zero interventions is
// reported honestly. Writes a versioned `sprint-recap` artifact AND advances
// the sprint phase in ONE transaction (multi-row write is atomic — a mid-way
// failure rolls back both, never leaving a half-written recap/phase state).

export default defineAction({
  description:
    "Generate the sprint recap (human-intervention timeline) from real " +
    "approval/comment/stage-rollback/re-dispatch records, write it as a " +
    "versioned sprint-recap artifact, and advance the sprint phase — all in one " +
    "transaction. Zero interventions is reported honestly, never fabricated.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
    advancePhase: z
      .boolean()
      .default(true)
      .describe("Also set the sprint phase to 'done' in the same transaction"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    const sprint = (
      await db
        .select({
          id: schema.sprints.id,
          name: schema.sprints.name,
          phase: schema.sprints.phase,
        })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found or not accessible");

    const items = await db
      .select({ id: schema.workItems.id })
      .from(schema.workItems)
      .where(eq(schema.workItems.sprintId, args.sprintId));
    const itemIds = items.map((i) => i.id);

    // ── Pull the real intervention records (read-only) ─────────────────────
    const approvals = (
      await db
        .select()
        .from(schema.approvals)
        .where(
          and(
            eq(schema.approvals.sprintId, args.sprintId),
            ownerScope(schema.approvals),
          ),
        )
    ).map((a) => ({
      id: a.id,
      gateKey: a.gateKey,
      status: a.status,
      requestedBy: a.requestedBy,
      decidedBy: a.decidedBy,
      reason: a.reason,
      createdAt: a.createdAt,
      decidedAt: a.decidedAt,
    })) as RecapApprovalRow[];

    const comments: RecapCommentRow[] =
      itemIds.length > 0
        ? (
            await db
              .select()
              .from(schema.comments)
              .where(
                and(
                  inArray(schema.comments.workItemId, itemIds),
                  ownerScope(schema.comments),
                ),
              )
          ).map((c) => ({
            id: c.id,
            authorKind: c.authorKind ?? "human",
            authorName: c.authorName,
            body: c.body,
            createdAt: c.createdAt,
          }))
        : [];

    const stages: RecapStageRow[] =
      itemIds.length > 0
        ? (
            await db
              .select({
                id: schema.stages.id,
                stageName: schema.stages.stageName,
                stageStatus: schema.stages.stageStatus,
                verdict: schema.stages.verdict,
                updatedAt: schema.stages.updatedAt,
              })
              .from(schema.stages)
              .where(inArray(schema.stages.workItemId, itemIds))
          ).map((s) => {
            let verdictReason: string | null = null;
            try {
              const v = s.verdict ? JSON.parse(s.verdict) : null;
              verdictReason = v?.reason ?? null;
            } catch {
              verdictReason = null;
            }
            return {
              id: s.id,
              stageName: s.stageName,
              stageStatus: s.stageStatus ?? "",
              verdictReason,
              updatedAt: s.updatedAt,
            };
          })
        : [];

    const runs: RecapRunRow[] =
      itemIds.length > 0
        ? (
            await db
              .select({
                id: schema.workItemRuns.id,
                superseded: schema.workItemRuns.superseded,
                createdAt: schema.workItemRuns.createdAt,
              })
              .from(schema.workItemRuns)
              .where(
                and(
                  inArray(schema.workItemRuns.workItemId, itemIds),
                  ownerScope(schema.workItemRuns),
                ),
              )
          ).map((r) => ({
            id: r.id,
            superseded: r.superseded,
            createdAt: r.createdAt,
          }))
        : [];

    const recap = buildSprintRecap({ approvals, comments, stages, runs });
    const content = renderSprintRecapMarkdown(sprint.name, recap);

    // ── Transactional multi-row write: versioned artifact + phase advance ──
    const now = new Date().toISOString();
    const id = nanoid();

    const [maxRow] = await db
      .select({ v: max(schema.sprintArtifacts.version) })
      .from(schema.sprintArtifacts)
      .where(
        and(
          eq(schema.sprintArtifacts.sprintId, args.sprintId),
          eq(schema.sprintArtifacts.docKey, "sprint-recap"),
          ownerScope(schema.sprintArtifacts),
        ),
      );
    const nextVersion = (maxRow?.v ?? 0) + 1;

    let supersedes: string | null = null;
    if (nextVersion > 1) {
      const prev = (
        await db
          .select({ id: schema.sprintArtifacts.id })
          .from(schema.sprintArtifacts)
          .where(
            and(
              eq(schema.sprintArtifacts.sprintId, args.sprintId),
              eq(schema.sprintArtifacts.docKey, "sprint-recap"),
              eq(schema.sprintArtifacts.version, nextVersion - 1),
              ownerScope(schema.sprintArtifacts),
            ),
          )
          .limit(1)
      )[0];
      supersedes = prev?.id ?? null;
    }

    await db.transaction(async (tx) => {
      await tx.insert(schema.sprintArtifacts).values({
        id,
        sprintId: args.sprintId,
        docKey: "sprint-recap",
        kind: "复盘",
        name: `Sprint Recap — ${sprint.name}`,
        version: nextVersion,
        supersedes,
        producedByKind: "agent",
        content,
        contentRef: null,
        createdAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });

      if (args.advancePhase) {
        await tx
          .update(schema.sprints)
          .set({ phase: "done", updatedAt: now })
          .where(eq(schema.sprints.id, args.sprintId));
      }
    });

    return {
      id,
      sprintId: args.sprintId,
      docKey: "sprint-recap",
      version: nextVersion,
      supersedes,
      noInterventions: recap.noInterventions,
      counts: recap.counts,
      entryCount: recap.entries.length,
      phase: args.advancePhase ? "done" : sprint.phase,
    };
  },
});
