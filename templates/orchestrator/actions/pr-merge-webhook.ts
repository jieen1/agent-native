import { defineAction } from "@agent-native/core";
import { resolveSecret } from "@agent-native/core/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { schemeForType } from "../server/work-items/schemes.js";
import { terminalShippedStage } from "../shared/status-schemes.js";
import { applyTransition } from "../server/work-items/transition.js";

// PR-merge / deploy webhook — terminal closure (DESIGN §6.2b). A PR-merge or
// prod-deploy event calls this to move a delivered work item to its TERMINAL
// shipped stage (已上线 / 已关闭 / 已完成 / 定稿) with resolution:shipped — the closure
// the agent intentionally does NOT make itself (it rests the item at the
// near-terminal 待发布 when it opens the PR; shipping is a post-run event).
//
// This reuses the framework `integration-webhooks` pattern: an external,
// UN-authenticated caller validated by a SHARED SECRET, not a logged-in user.
// `requiresAuth:false` because there is no session; instead the call must carry
// the `ORCHESTRATOR_WEBHOOK_SECRET` (resolved value-safe from the Vault/secrets,
// never hardcoded). agentTool:false keeps this off the agent's tool list (it is
// a webhook endpoint, not an agent capability) — the agent moves status via
// transition-work-item. Hidden from the tools iframe bridge too.
//
// It funnels through the SAME §6.2b single-writer (`applyTransition`): scheme
// validation, statusCategory derivation, the resolution gate, the status-log
// trail row, AND the audit row — no back door.
export default defineAction({
  description:
    "PR-merge/deploy webhook: move a delivered work item to its terminal shipped stage with resolution:shipped (DESIGN §6.2b terminal closure). External caller validated by a shared secret; reuses the single-writer transition gate.",
  schema: z.object({
    workItemId: z.string().describe("The delivered work item to close out"),
    secret: z
      .string()
      .describe(
        "The shared webhook secret (ORCHESTRATOR_WEBHOOK_SECRET) — validated, never logged",
      ),
    // Optional explicit terminal stage; defaults to the type's first completed
    // stage. A deploy webhook for a prod-issue may pass 已关闭 explicitly.
    toStatus: z
      .string()
      .optional()
      .describe("Terminal stage override; defaults to the type's shipped stage"),
    resolution: z
      .enum([
        "shipped",
        "rolled-back",
        "cannot-reproduce",
        "duplicate",
        "rejected",
        "cancelled",
        "deferred",
      ])
      .optional()
      .describe("Closure resolution; defaults to 'shipped'"),
    environment: z
      .string()
      .nullable()
      .optional()
      .describe("Where it shipped, e.g. prod"),
    // Provenance for the audit trail (PR number / merge sha / deploy id).
    source: z
      .string()
      .optional()
      .describe("Webhook source for the trail, e.g. github-pr-merge"),
    eventId: z
      .string()
      .optional()
      .describe("Upstream event id (PR number, merge sha, deploy id) for the trail"),
  }),
  http: { method: "POST" },
  requiresAuth: false,
  agentTool: false,
  toolCallable: false,
  run: async (args) => {
    // ── validate the shared secret (constant work; never log the value) ──────
    const expected = await resolveSecret("ORCHESTRATOR_WEBHOOK_SECRET");
    if (!expected) {
      throw new Error(
        "Webhook secret not configured: set ORCHESTRATOR_WEBHOOK_SECRET in the Vault/secrets before enabling PR-merge closure.",
      );
    }
    if (args.secret !== expected) {
      throw new Error("Invalid webhook secret.");
    }

    const db = getDb();
    const itemRows = await db
      .select()
      .from(schema.workItems)
      .where(eq(schema.workItems.id, args.workItemId))
      .limit(1);
    const item = itemRows[0];
    if (!item) throw new Error(`Work item ${args.workItemId} not found`);

    // Resolve the terminal shipped stage from the item's (project-overridden)
    // scheme unless the caller pinned one.
    const scheme = schemeForType(
      // The webhook has no request user, so read the project scheme directly.
      (
        await db
          .select({ statusSchemes: schema.projects.statusSchemes })
          .from(schema.projects)
          .where(eq(schema.projects.id, String(item.projectId)))
          .limit(1)
      )[0]?.statusSchemes ?? null,
      String(item.type),
    );
    const toStatus = args.toStatus ?? terminalShippedStage(scheme);
    if (!toStatus) {
      throw new Error(
        `No terminal shipped stage for type '${item.type}'; pass toStatus explicitly.`,
      );
    }

    const actor = args.source ?? "webhook:pr-merge";
    const outcome = await applyTransition({
      item: item as unknown as Record<string, unknown>,
      actor,
      auditAction: "webhook.pr-merge",
      auditDetail: { source: args.source ?? null, eventId: args.eventId ?? null },
      input: {
        toStatus,
        resolution: args.resolution ?? "shipped",
        environment: args.environment,
      },
    });

    return {
      ...outcome,
      source: actor,
      eventId: args.eventId ?? null,
    };
  },
});
