import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { eq, isNull } from "drizzle-orm";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope, and } from "../server/lib/access.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Request an approval gate for a sprint. If an identical pending approval " +
    "already exists for the same sprintId + gateKey (+ optional workItemId), " +
    "returns it unchanged (idempotent).",
  schema: z.object({
    sprintId: z.string().min(1).describe("Sprint ID to attach the approval to"),
    gateKey: z
      .enum(["plan-signoff", "design-signoff", "escalation", "audit-deferral"])
      .describe("Gate type"),
    workItemId: z
      .string()
      .optional()
      .describe("Optional work item ID when the gate is scoped to one item"),
    gateRef: z
      .string()
      .optional()
      .describe(
        "Optional JSON string {runId, nodeId} referencing the orchestrator workflow node",
      ),
    anchorArtifactId: z
      .string()
      .optional()
      .describe(
        "可选：把该审批锚定到某个 tracker_sprint_artifacts.id，产物出新版本后该审批会被置为 stale 并自动生成重确认审批单",
      ),
    anchorVersion: z
      .number()
      .int()
      .optional()
      .describe("可选：锚定产物当时的 version，配合 anchorArtifactId 一起传"),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();

    // Idempotency: return existing pending approval for same sprint+gate+item
    const existing = await db
      .select()
      .from(schema.approvals)
      .where(
        and(
          ownerScope(schema.approvals),
          eq(schema.approvals.sprintId, args.sprintId),
          eq(schema.approvals.gateKey, args.gateKey),
          eq(schema.approvals.status, "pending"),
          args.workItemId
            ? eq(schema.approvals.workItemId, args.workItemId)
            : isNull(schema.approvals.workItemId),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const r = existing[0]!;
      return {
        id: r.id,
        sprintId: r.sprintId,
        workItemId: r.workItemId,
        gateKey: r.gateKey,
        gateRef: r.gateRef,
        status: r.status,
        requestedBy: r.requestedBy,
        decidedBy: r.decidedBy,
        reason: r.reason,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
      };
    }

    const id = nanoid();
    const now = new Date().toISOString();

    await db.insert(schema.approvals).values({
      id,
      sprintId: args.sprintId,
      workItemId: args.workItemId ?? null,
      gateKey: args.gateKey,
      gateRef: args.gateRef ?? null,
      status: "pending",
      requestedBy: ownerEmail,
      decidedBy: null,
      reason: null,
      decidedAt: null,
      createdAt: now,
      anchorArtifactId: args.anchorArtifactId ?? null,
      anchorVersion: args.anchorVersion ?? null,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return {
      id,
      sprintId: args.sprintId,
      workItemId: args.workItemId ?? null,
      gateKey: args.gateKey,
      gateRef: args.gateRef ?? null,
      status: "pending",
      requestedBy: ownerEmail,
      decidedBy: null,
      reason: null,
      decidedAt: null,
      createdAt: now,
      anchorArtifactId: args.anchorArtifactId ?? null,
      anchorVersion: args.anchorVersion ?? null,
    };
  },
});
