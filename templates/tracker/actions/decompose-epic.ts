import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { and, eq, sql, inArray } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { resolveActorKind, resolveActorName } from "../server/lib/activity.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

const EPIC_TYPES = new Set(["epic", "集合"]);

export default defineAction({
  description:
    "Decompose an epic (集合) work item into a fixed, caller-supplied list of " +
    "child work items with explicit dependency edges. This action NEVER " +
    "auto-decomposes via AI — it only persists exactly the children the " +
    "caller provides. Idempotent: re-calling with the same epic and the same " +
    "child titles skips children that already exist. Atomic: if any " +
    "dependsOnTitles reference doesn't match a sibling title in this same " +
    "call, the entire operation fails before anything is written.",
  schema: z.object({
    epicId: z.string().min(1).describe("The epic (集合) work item id to decompose"),
    children: z
      .array(
        z.object({
          title: z.string().min(1).describe("Child work item title"),
          description: z.string().optional(),
          repoName: z
            .string()
            .optional()
            .describe("Optional repo name tag, stored as a 'repo:<name>' tag"),
          dependsOnTitles: z
            .array(z.string())
            .optional()
            .describe(
              "Titles of sibling children (within this same call) that this " +
                "child is blocked-by",
            ),
        }),
      )
      .min(1)
      .describe("The fixed list of children to create — never inferred by AI"),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;
    const db = getDb();

    // Confirm the epic exists, is accessible, and is actually an epic.
    const epic = (
      await db
        .select()
        .from(schema.workItems)
        .where(and(eq(schema.workItems.id, args.epicId), ownerScope(schema.workItems)))
        .limit(1)
    )[0];
    if (!epic) throw new Error("Epic work item not found or not accessible");
    if (!EPIC_TYPES.has(epic.type)) {
      throw new Error(`Work item ${args.epicId} is not an epic (type=${epic.type})`);
    }

    const titleKey = (t: string) => t.trim().toLowerCase();

    // Validate titles are unique within this call.
    const titleSet = new Map<string, string>();
    for (const c of args.children) {
      const key = titleKey(c.title);
      if (titleSet.has(key)) {
        throw new Error(`Duplicate child title in this call: "${c.title}"`);
      }
      titleSet.set(key, c.title);
    }

    // Validate every dependsOnTitles reference resolves to a sibling BEFORE
    // any writes, so a bad reference fails the whole call atomically.
    for (const c of args.children) {
      for (const dep of c.dependsOnTitles ?? []) {
        const key = titleKey(dep);
        if (!titleSet.has(key)) {
          throw new Error(
            `Unknown dependsOnTitles reference "${dep}" on child "${c.title}" — ` +
              `must match a sibling title in this same call`,
          );
        }
        if (key === titleKey(c.title)) {
          throw new Error(`Child "${c.title}" cannot depend on itself`);
        }
      }
    }

    // Idempotency: find children this epic already has (child-of links).
    const existingChildLinks = await db
      .select({ fromItemId: schema.links.fromItemId })
      .from(schema.links)
      .where(
        and(
          eq(schema.links.toItemId, args.epicId),
          eq(schema.links.linkType, "child-of"),
          ownerScope(schema.links),
        ),
      );
    const existingChildIds = existingChildLinks.map((l) => l.fromItemId);
    let existingChildren: { id: string; title: string }[] = [];
    if (existingChildIds.length > 0) {
      existingChildren = await db
        .select({ id: schema.workItems.id, title: schema.workItems.title })
        .from(schema.workItems)
        .where(
          and(inArray(schema.workItems.id, existingChildIds), ownerScope(schema.workItems)),
        );
    }
    const childIdByTitle = new Map<string, string>();
    for (const ec of existingChildren) childIdByTitle.set(titleKey(ec.title), ec.id);

    // Project key + running sequence number for itemKey generation.
    const project = (
      await db
        .select({ key: schema.projects.key })
        .from(schema.projects)
        .where(eq(schema.projects.id, epic.projectId))
        .limit(1)
    )[0];
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.workItems)
      .where(eq(schema.workItems.projectId, epic.projectId));
    let seq = (Number(countResult[0]?.count) || 0) + 1;

    const now = new Date().toISOString();
    const results: { id: string; title: string; itemKey: string; created: boolean }[] = [];

    for (const c of args.children) {
      const key = titleKey(c.title);
      const existingId = childIdByTitle.get(key);
      if (existingId) {
        results.push({ id: existingId, title: c.title, itemKey: "", created: false });
        continue;
      }
      const id = nanoid();
      const itemKey = `${project?.key ?? "ITEM"}-${String(seq).padStart(3, "0")}`;
      seq++;
      const tags = c.repoName ? [`repo:${c.repoName}`] : [];
      await db.insert(schema.workItems).values({
        id,
        projectId: epic.projectId,
        type: "任务",
        title: c.title.trim(),
        description: c.description?.trim() ?? "",
        status: "open",
        priority: epic.priority ?? 2,
        risk: "medium",
        tags: JSON.stringify(tags),
        nature: "[]",
        owner: null,
        sprintId: epic.sprintId ?? null,
        executionMode: "manual",
        itemKey,
        createdAt: now,
        updatedAt: now,
        ownerEmail,
        orgId,
        visibility: "private",
      });
      childIdByTitle.set(key, id);
      results.push({ id, title: c.title, itemKey, created: true });
    }

    // Ensure a duplicate-checked link (mirrors add-link.ts's dedup pattern).
    async function ensureLink(fromItemId: string, toItemId: string, linkType: string) {
      const existing = await db
        .select({ id: schema.links.id })
        .from(schema.links)
        .where(
          and(
            eq(schema.links.fromItemId, fromItemId),
            eq(schema.links.toItemId, toItemId),
            eq(schema.links.linkType, linkType),
            ownerScope(schema.links),
          ),
        )
        .limit(1);
      if (existing[0]) return;
      await db.insert(schema.links).values({
        id: nanoid(),
        fromItemId,
        toItemId,
        linkType,
        createdAt: new Date().toISOString(),
        ownerEmail,
        orgId,
      });
    }

    for (const c of args.children) {
      const childId = childIdByTitle.get(titleKey(c.title))!;
      await ensureLink(childId, args.epicId, "child-of");
    }
    for (const c of args.children) {
      const childId = childIdByTitle.get(titleKey(c.title))!;
      for (const dep of c.dependsOnTitles ?? []) {
        const depId = childIdByTitle.get(titleKey(dep))!;
        await ensureLink(childId, depId, "blocked-by");
      }
    }

    // Log one activity row on the epic summarizing the decomposition.
    const createdCount = results.filter((r) => r.created).length;
    const actorKind = resolveActorKind(ctx);
    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.epicId,
      actorKind,
      actorName: resolveActorName(actorKind, ownerEmail),
      eventType: "decompose-epic",
      payload: JSON.stringify({
        requested: args.children.length,
        created: createdCount,
        skipped: args.children.length - createdCount,
        children: results.map((r) => ({ id: r.id, title: r.title, created: r.created })),
      }),
      createdAt: now,
      ownerEmail,
      orgId,
    });

    return {
      epicId: args.epicId,
      children: results,
    };
  },
});
