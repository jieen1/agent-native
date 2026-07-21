import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, and } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { ownerScope } from "../server/lib/access.js";
import { actorFromCaller } from "../server/lib/transition-guard.js";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

export default defineAction({
  description:
    "Add a comment to a work item. authorKind is derived from the real caller " +
    'surface (agent/tool-loop and A2A/MCP callers are marked "agent"); agent ' +
    "callers cannot use authorName to impersonate a human name.",
  schema: z.object({
    workItemId: z.string().min(1),
    body: z.string().min(1),
    authorName: z.string().optional(),
  }),
  http: { method: "POST" },
  run: async (args, ctx) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    // 派生真实作者身份。复用 transition-guard 的 actorFromCaller 同款判定,并补上
    // A2A/MCP 跨应用调用面。caller 来自 action 的 run(args, ctx) 第二参 —— 框架把
    // 调用面经 ctx.caller 透传(与 transition-work-item.ts 的 actorFromCaller 用法
    // 同源)。core 的 request-context 不携带 caller 字段、也没有 getRequestCaller
    // 导出,故沿用既有的 ctx.caller 通道而非一个不存在的导入。
    const caller = ctx?.caller;
    // actorFromCaller 识别站内 agent 工具循环(caller==="tool")与回写哨兵邮箱;
    // A2A/MCP 跨应用调用面(caller==="mcp")对评论证据而言同样不是真人,即便它不是
    // 回写哨兵(SDLC-039 的假"人工评审"正是这样产生的)——故在此显式归为 agent。
    const derivedKind = actorFromCaller(caller, ownerEmail).kind;
    const authorKind: "human" | "agent" =
      derivedKind === "agent" || caller === "mcp" ? "agent" : "human";

    // authorName 防伪造:判定为 agent 时不允许调用方用任意人名覆盖,强制使用真实
    // 认证身份 ownerEmail;human 调用者保持现有行为(可用 args.authorName 显示名)。
    const authorName =
      authorKind === "agent" ? ownerEmail : (args.authorName ?? ownerEmail);

    const db = getDb();
    const item = (
      await db
        .select({ id: schema.workItems.id })
        .from(schema.workItems)
        .where(
          and(
            eq(schema.workItems.id, args.workItemId),
            ownerScope(schema.workItems),
          ),
        )
        .limit(1)
    )[0];
    if (!item) throw new Error("Work item not found");

    const id = nanoid();
    const now = new Date().toISOString();
    await db.insert(schema.comments).values({
      id,
      workItemId: args.workItemId,
      authorKind: authorKind,
      authorName: authorName,
      body: args.body,
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    await db.insert(schema.activities).values({
      id: nanoid(),
      workItemId: args.workItemId,
      actorKind: authorKind,
      actorName: authorName,
      eventType: "评论",
      payload: JSON.stringify({ commentId: id }),
      createdAt: now,
      ownerEmail,
      orgId,
      visibility: "private",
    });

    return { id, workItemId: args.workItemId, body: args.body, createdAt: now };
  },
});
