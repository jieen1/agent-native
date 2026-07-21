import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, and, max } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// ── Pure helpers for approval stale logic (exported for unit tests) ─────────

export interface ApprovalRow {
  id: string;
  sprintId: string;
  workItemId: string | null;
  gateKey: string;
  status: string; // 'pending' | 'approved' | 'rejected'
  requestedBy: string;
  anchorArtifactId: string | null;
  anchorVersion: number | null;
  staleAt: string | null;
}

// 是否是一个「当前仍然有效」的已批准审批（status==='approved' 且未被置为 stale）。
export function isApprovalActiveApproved(
  approval: Pick<ApprovalRow, "status" | "staleAt">,
): boolean {
  return approval.status === "approved" && !approval.staleAt;
}

// 从一批候选审批中，挑出「锚定在给定旧产物版本id集合上、且当前仍是有效已批准」的那些 —— 这些就是新版本产生后应被置为 stale 的审批。
// 已经 staleAt 非空的跳过（幂等：重复调用不会重复处理）。
export function selectApprovalsToStale(
  approvals: ApprovalRow[],
  oldArtifactIds: string[],
): ApprovalRow[] {
  const oldSet = new Set(oldArtifactIds);
  return approvals.filter(
    (a) =>
      a.anchorArtifactId != null &&
      oldSet.has(a.anchorArtifactId) &&
      isApprovalActiveApproved(a),
  );
}

// 根据一条被置为 stale 的审批 + 新产物版本信息，构造一条「重确认」pending 审批的待插入字段（不含 id/createdAt，由调用方补充，和其余 insert 一致）。
export function buildReconfirmationApprovalInput(
  staleApproval: Pick<
    ApprovalRow,
    "sprintId" | "workItemId" | "gateKey" | "requestedBy"
  >,
  newArtifact: { id: string; docKey: string; version: number },
): {
  sprintId: string;
  workItemId: string | null;
  gateKey: string;
  status: "pending";
  requestedBy: string;
  anchorArtifactId: string;
  anchorVersion: number;
  reason: string;
} {
  return {
    sprintId: staleApproval.sprintId,
    workItemId: staleApproval.workItemId,
    gateKey: staleApproval.gateKey,
    status: "pending",
    requestedBy: staleApproval.requestedBy,
    anchorArtifactId: newArtifact.id,
    anchorVersion: newArtifact.version,
    reason: `重确认：${newArtifact.docKey} v${newArtifact.version}`,
  };
}

// ── Action definition ────────────────────────────────────────────────────────

export default defineAction({
  description:
    "Create a sprint-level versioned artifact (sprint-doc / test-plan / tech-design / " +
    "brief:{itemKey} / shared-brief / audit-report:{n} / story / verify-report). " +
    "Auto-increments version within the same sprintId+docKey and sets supersedes. " +
    "Human-protection: if the current latest version for the same sprintId+docKey was " +
    "produced by 'human' and this request uses producedByKind='agent', an approvalId " +
    "MUST be supplied or the call is rejected with 'human 产物需审批'. " +
    "B2 stale: when creating a new version, any approvals anchored to older artifact " +
    "versions will be marked stale and reconfirmation approvals will be generated.",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint id"),
    docKey: z
      .string()
      .min(1)
      .describe(
        "Document key: sprint-doc | test-plan | tech-design | brief:{itemKey} | shared-brief | audit-report:{n} | story | verify-report",
      ),
    kind: z
      .string()
      .min(1)
      .describe(
        "Document kind/category, e.g. 文档 / 测试计划 / 设计 / 审计报告",
      ),
    name: z.string().min(1).describe("Human-readable artifact name"),
    producedByKind: z
      .enum(["agent", "human"])
      .default("agent")
      .describe("Who produced this artifact"),
    content: z.string().default("").describe("Markdown body of the artifact"),
    contentRef: z
      .string()
      .optional()
      .describe("Optional external content reference (URL / storage key)"),
    approvalId: z
      .string()
      .optional()
      .describe(
        "Required when overwriting a human-produced artifact with an agent-produced one",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();

    // Verify sprint access
    const sprint = (
      await db
        .select({ id: schema.sprints.id })
        .from(schema.sprints)
        .where(
          and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)),
        )
        .limit(1)
    )[0];
    if (!sprint) throw new Error("Sprint not found");

    // Determine next version for this (sprintId, docKey) pair
    const [maxRow] = await db
      .select({ v: max(schema.sprintArtifacts.version) })
      .from(schema.sprintArtifacts)
      .where(
        and(
          eq(schema.sprintArtifacts.sprintId, args.sprintId),
          eq(schema.sprintArtifacts.docKey, args.docKey),
          ownerScope(schema.sprintArtifacts),
        ),
      );
    const nextVersion = (maxRow?.v ?? 0) + 1;

    // Find the current latest artifact for supersedes link + human-protection check
    let supersedes: string | null = null;
    if (nextVersion > 1) {
      const prev = (
        await db
          .select({
            id: schema.sprintArtifacts.id,
            producedByKind: schema.sprintArtifacts.producedByKind,
          })
          .from(schema.sprintArtifacts)
          .where(
            and(
              eq(schema.sprintArtifacts.sprintId, args.sprintId),
              eq(schema.sprintArtifacts.docKey, args.docKey),
              eq(schema.sprintArtifacts.version, nextVersion - 1),
              ownerScope(schema.sprintArtifacts),
            ),
          )
          .limit(1)
      )[0];

      if (prev) {
        supersedes = prev.id;
        // Human-protection: agent overwriting human's work requires explicit approval.
        if (
          prev.producedByKind === "human" &&
          (args.producedByKind ?? "agent") === "agent" &&
          !args.approvalId
        ) {
          throw new Error(
            "human 产物需审批: 当前最新版本为人工产物，智能体覆写需传入 approvalId",
          );
        }
      }
    }

    const id = nanoid();
    const now = new Date().toISOString();

    await db.insert(schema.sprintArtifacts).values({
      id,
      sprintId: args.sprintId,
      docKey: args.docKey,
      kind: args.kind,
      name: args.name,
      version: nextVersion,
      supersedes,
      producedByKind: args.producedByKind ?? "agent",
      content: args.content ?? "",
      contentRef: args.contentRef ?? null,
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // ── B2 stale logic: when nextVersion > 1, stale anchored approvals ─────
    const staleApprovals: Array<{
      id: string;
      gateKey: string;
      staleAt: string;
    }> = [];
    const reconfirmationApprovals: Array<{
      id: string;
      gateKey: string;
      status: string;
      reason: string;
    }> = [];

    if (nextVersion > 1) {
      // Collect all older artifact ids for this (sprintId, docKey)
      const oldArtifacts = await db
        .select({ id: schema.sprintArtifacts.id })
        .from(schema.sprintArtifacts)
        .where(
          and(
            eq(schema.sprintArtifacts.sprintId, args.sprintId),
            eq(schema.sprintArtifacts.docKey, args.docKey),
            ownerScope(schema.sprintArtifacts),
          ),
        );
      const oldArtifactIds = oldArtifacts
        .filter((a) => a.id !== id)
        .map((a) => a.id);

      if (oldArtifactIds.length > 0) {
        // Query all approvals for this sprintId (owner-scoped)
        const approvals = await db
          .select()
          .from(schema.approvals)
          .where(
            and(
              ownerScope(schema.approvals),
              eq(schema.approvals.sprintId, args.sprintId),
            ),
          );

        const toStale = selectApprovalsToStale(
          approvals as ApprovalRow[],
          oldArtifactIds,
        );

        const newArtifact = {
          id,
          docKey: args.docKey,
          version: nextVersion,
        };

        for (const approval of toStale) {
          // a. Mark stale
          await db
            .update(schema.approvals)
            .set({ staleAt: now })
            .where(eq(schema.approvals.id, approval.id));
          staleApprovals.push({
            id: approval.id,
            gateKey: approval.gateKey,
            staleAt: now,
          });

          // b. Create reconfirmation approval
          const reconfirmInput = buildReconfirmationApprovalInput(
            approval,
            newArtifact,
          );
          const reconfirmId = nanoid();
          await db.insert(schema.approvals).values({
            id: reconfirmId,
            sprintId: reconfirmInput.sprintId,
            workItemId: reconfirmInput.workItemId,
            gateKey: reconfirmInput.gateKey,
            gateRef: null,
            status: reconfirmInput.status,
            requestedBy: reconfirmInput.requestedBy,
            decidedBy: null,
            reason: reconfirmInput.reason,
            decidedAt: null,
            createdAt: now,
            anchorArtifactId: reconfirmInput.anchorArtifactId,
            anchorVersion: reconfirmInput.anchorVersion,
            ownerEmail,
            orgId,
            visibility: "private",
          });
          reconfirmationApprovals.push({
            id: reconfirmId,
            gateKey: reconfirmInput.gateKey,
            status: reconfirmInput.status,
            reason: reconfirmInput.reason,
          });

          // c. Activity log (only if workItemId is present)
          if (approval.workItemId != null) {
            // approval.stale activity
            await db.insert(schema.activities).values({
              id: `act_ast_${approval.id.slice(0, 6)}_${nanoid()}`,
              workItemId: approval.workItemId,
              actorKind: "agent",
              actorName: "智能体",
              eventType: "approval.stale",
              payload: JSON.stringify({
                approvalId: approval.id,
                gateKey: approval.gateKey,
                docKey: args.docKey,
                staleAt: now,
                staleArtifactVersion: approval.anchorVersion,
                newArtifactId: id,
                newVersion: nextVersion,
              }),
              createdAt: now,
              ownerEmail,
              orgId,
              visibility: "private",
            });

            // approval.reconfirm_requested activity
            await db.insert(schema.activities).values({
              id: `act_ars_${reconfirmId.slice(0, 6)}_${nanoid()}`,
              workItemId: approval.workItemId,
              actorKind: "agent",
              actorName: "智能体",
              eventType: "approval.reconfirm_requested",
              payload: JSON.stringify({
                newApprovalId: reconfirmId,
                gateKey: approval.gateKey,
                docKey: args.docKey,
                version: nextVersion,
              }),
              createdAt: now,
              ownerEmail,
              orgId,
              visibility: "private",
            });
          }
        }
      }
    }

    return {
      id,
      sprintId: args.sprintId,
      docKey: args.docKey,
      kind: args.kind,
      name: args.name,
      version: nextVersion,
      supersedes,
      producedByKind: args.producedByKind ?? "agent",
      createdAt: now,
      staleApprovals,
      reconfirmationApprovals,
    };
  },
});
