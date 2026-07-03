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

export default defineAction({
  description:
    "Create a sprint-level versioned artifact (sprint-doc / test-plan / tech-design / " +
    "brief:{itemKey} / shared-brief / audit-report:{n} / story / verify-report). " +
    "Auto-increments version within the same sprintId+docKey and sets supersedes. " +
    "Human-protection: if the current latest version for the same sprintId+docKey was " +
    "produced by 'human' and this request uses producedByKind='agent', an approvalId " +
    "MUST be supplied or the call is rejected with 'human 产物需审批'.",
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
      .describe("Document kind/category, e.g. 文档 / 测试计划 / 设计 / 审计报告"),
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
        .where(and(eq(schema.sprints.id, args.sprintId), ownerScope(schema.sprints)))
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
    };
  },
});
