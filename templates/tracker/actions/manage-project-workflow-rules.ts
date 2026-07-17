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

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

// R4a.3 L1 — project-level workflow routing rules (design authority:
// docs/sdlc-product-design/r4-workflow-families-planning-skills.md §4.4 first
// bullet). Mirrors manage-project-repos.ts's op-parameterized shape: one
// action for the whole project-settings CRUD surface instead of four
// separate list/add/update/remove actions, per this template's existing
// convention for project-scoped settings tables.
//
// Rows here OVERRIDE/EXTEND the code-level DEFAULT_WORKFLOW_RULES fallback in
// server/lib/workflow-routing.ts — a project with zero rows still gets
// sensible routing from the defaults; `dispatch-to-orchestrator.ts` reads
// both (project rows first) via `resolveWorkflowRule`.
const ruleFieldsSchema = z.object({
  itemType: z
    .string()
    .optional()
    .describe(
      'Matches work_items.type (e.g. "需求"/"缺陷"/"from-audit"). Empty/omitted = any.',
    ),
  nature: z
    .string()
    .optional()
    .describe(
      'Matches itemType or any tag (e.g. "文档"/"调研"). Empty/omitted = any.',
    ),
  inSprint: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "null/omitted = any; true = item must be in a sprint; false = must not be.",
    ),
  // Required for op=add (checked in the run() body — not schema-required
  // here since op=remove only needs `id`, and op=update may patch other
  // fields without renaming the template).
  templateName: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Workflow template name to suggest, e.g. 'hotfix' (required for op=add)",
    ),
  defaultInputs: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Default workflowRun inputs to suggest alongside the template"),
  priority: z
    .number()
    .int()
    .optional()
    .describe(
      "Lower = evaluated first (default 100). Use a lower number to override a default rule.",
    ),
});

export default defineAction({
  description:
    "Manage a tracker project's L1 workflow-routing rules (deterministic " +
    "pre-selection: item type/nature/in-sprint → suggested workflow template). " +
    "op=list returns all rules for the project; op=add creates a rule; " +
    "op=update patches an existing rule by id; op=remove deletes a rule by id. " +
    "Rules override the built-in default routing table; a project with no " +
    "rules still gets sensible defaults.",
  schema: z.object({
    projectId: z.string().min(1).describe("Project id"),
    op: z.enum(["list", "add", "update", "remove"]).describe("Operation"),
    rule: ruleFieldsSchema
      .extend({
        // update/remove identify the row by id.
        id: z.string().min(1).optional(),
      })
      .optional()
      .describe(
        "Rule data (required for add/update/remove; id required for update/remove)",
      ),
  }),
  http: { method: "POST" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) throw new Error("Not authenticated");
    const orgId = getRequestOrgId() ?? null;

    const db = getDb();

    const project = (
      await db
        .select()
        .from(schema.projects)
        .where(
          and(
            eq(schema.projects.id, args.projectId),
            ownerScope(schema.projects),
          ),
        )
        .limit(1)
    )[0];
    if (!project) throw new Error("Project not found or access denied");

    switch (args.op) {
      case "list": {
        const rows = await db
          .select()
          .from(schema.projectWorkflowRules)
          .where(
            and(
              eq(schema.projectWorkflowRules.projectId, args.projectId),
              ownerScope(schema.projectWorkflowRules),
            ),
          );
        return rows;
      }

      case "add": {
        if (!args.rule) throw new Error("rule is required for op=add");
        if (!args.rule.templateName?.trim()) {
          throw new Error("rule.templateName is required for op=add");
        }
        const id = nanoid();
        const now = new Date().toISOString();
        const row = {
          id,
          projectId: args.projectId,
          itemType: args.rule.itemType?.trim() ?? "",
          nature: args.rule.nature?.trim() ?? "",
          inSprint:
            args.rule.inSprint === undefined || args.rule.inSprint === null
              ? null
              : args.rule.inSprint
                ? 1
                : 0,
          templateName: args.rule.templateName.trim(),
          defaultInputs: JSON.stringify(args.rule.defaultInputs ?? {}),
          priority: args.rule.priority ?? 100,
          createdAt: now,
          updatedAt: now,
          ownerEmail,
          orgId,
          visibility: "private" as const,
        };

        await db.insert(schema.projectWorkflowRules).values(row);
        return row;
      }

      case "update": {
        if (!args.rule?.id)
          throw new Error("rule.id is required for op=update");

        const target = (
          await db
            .select()
            .from(schema.projectWorkflowRules)
            .where(
              and(
                eq(schema.projectWorkflowRules.id, args.rule.id),
                eq(schema.projectWorkflowRules.projectId, args.projectId),
                ownerScope(schema.projectWorkflowRules),
              ),
            )
            .limit(1)
        )[0];
        if (!target) throw new Error(`Rule "${args.rule.id}" not found`);

        const now = new Date().toISOString();
        const patch: Partial<typeof schema.projectWorkflowRules.$inferInsert> =
          {
            updatedAt: now,
          };
        if (args.rule.itemType !== undefined)
          patch.itemType = args.rule.itemType.trim();
        if (args.rule.nature !== undefined)
          patch.nature = args.rule.nature.trim();
        if (args.rule.inSprint !== undefined) {
          patch.inSprint =
            args.rule.inSprint === null ? null : args.rule.inSprint ? 1 : 0;
        }
        if (args.rule.templateName !== undefined)
          patch.templateName = args.rule.templateName.trim();
        if (args.rule.defaultInputs !== undefined)
          patch.defaultInputs = JSON.stringify(args.rule.defaultInputs);
        if (args.rule.priority !== undefined)
          patch.priority = args.rule.priority;

        await db
          .update(schema.projectWorkflowRules)
          .set(patch)
          .where(
            and(
              eq(schema.projectWorkflowRules.id, target.id),
              ownerScope(schema.projectWorkflowRules),
            ),
          );

        const updated = (
          await db
            .select()
            .from(schema.projectWorkflowRules)
            .where(eq(schema.projectWorkflowRules.id, target.id))
            .limit(1)
        )[0];
        return updated;
      }

      case "remove": {
        if (!args.rule?.id)
          throw new Error("rule.id is required for op=remove");

        const target = (
          await db
            .select()
            .from(schema.projectWorkflowRules)
            .where(
              and(
                eq(schema.projectWorkflowRules.id, args.rule.id),
                eq(schema.projectWorkflowRules.projectId, args.projectId),
                ownerScope(schema.projectWorkflowRules),
              ),
            )
            .limit(1)
        )[0];
        if (!target) throw new Error(`Rule "${args.rule.id}" not found`);

        await db
          .delete(schema.projectWorkflowRules)
          .where(
            and(
              eq(schema.projectWorkflowRules.id, target.id),
              ownerScope(schema.projectWorkflowRules),
            ),
          );

        return { deleted: true, id: target.id };
      }

      default:
        throw new Error(`Unknown op: ${args.op}`);
    }
  },
});
