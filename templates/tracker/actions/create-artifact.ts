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
  description: "Record a new artifact (versioned) produced during a stage.",
  schema: z.object({
    workItemId: z.string().min(1),
    stageId: z.string().min(1),
    stageName: z.string().min(1),
    kind: z.string().min(1).describe("e.g. 分析报告 / 设计稿 / 代码变更 / 测试集 / 验收报告"),
    name: z.string().min(1),
    contentRef: z.string().optional(),
    producedByKind: z.enum(["agent", "human"]).optional(),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();
    // Verify access
    const item = (
      await db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.workItemId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found");

    // Determine next version
    const [maxRow] = await db
      .select({ v: max(schema.artifacts.version) })
      .from(schema.artifacts)
      .where(
        and(
          eq(schema.artifacts.workItemId, args.workItemId),
          eq(schema.artifacts.stageName, args.stageName),
          eq(schema.artifacts.kind, args.kind),
        ),
      );
    const nextVersion = (maxRow?.v ?? 0) + 1;

    // Find superseded artifact id if version > 1
    let supersedes: string | null = null;
    if (nextVersion > 1) {
      const prev = (
        await db
          .select({ id: schema.artifacts.id })
          .from(schema.artifacts)
          .where(
            and(
              eq(schema.artifacts.workItemId, args.workItemId),
              eq(schema.artifacts.stageName, args.stageName),
              eq(schema.artifacts.kind, args.kind),
            ),
          )
          .limit(1)
      )[0];
      supersedes = prev?.id ?? null;
    }

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.artifacts).values({
      id,
      workItemId: args.workItemId,
      stageId: args.stageId,
      stageName: args.stageName,
      kind: args.kind,
      name: args.name,
      version: nextVersion,
      contentRef: args.contentRef ?? "",
      producedByKind: args.producedByKind ?? "agent",
      supersedes,
      createdAt: now,
      updatedAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    // Record activity
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.workItemId,
      actorKind: args.producedByKind ?? "agent",
      actorName: ownerEmail,
      eventType: "产物新版",
      payload: JSON.stringify({ kind: args.kind, name: args.name, version: nextVersion }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, workItemId: args.workItemId, stageName: args.stageName, kind: args.kind, name: args.name, version: nextVersion, createdAt: now };
  },
});
