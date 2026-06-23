import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import { eq, ilike, and, desc } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { newId } from "./_util.js";
import { validateDag } from "../server/engine/dag-validator.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";

const allFormats: FormatName[] = ["date", "time", "date-time", "duration", "uri", "uri-reference", "uri-template", "url", "email", "hostname", "ipv4", "ipv6", "regex", "uuid", "json-pointer", "json-pointer-uri-fragment", "relative-json-pointer", "byte", "int32", "int64", "float", "double"];

/** List all V3 workflow templates. */
export const workflowList = defineAction({
  description: "List all V3 workflow templates.",
  schema: z.object({}),
  readOnly: true,
  run: async () => {
    const db = getV3Db();
    const rows = await db
      .select()
      .from(v3Schema.v3WorkflowTemplates)
      .orderBy(desc(v3Schema.v3WorkflowTemplates.createdAt));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      description: r.description,
      createdAt: r.createdAt,
    }));
  },
});

/** Get a V3 workflow template by id or name. */
export const workflowGet = defineAction({
  description: "Get a V3 workflow template by id or name.",
  schema: z.object({
    idOrName: z.string(),
    version: z.number().int().positive().optional(),
  }),
  readOnly: true,
  run: async (args) => {
    const db = getV3Db();
    let rows;
    if (args.version !== undefined) {
      rows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(
          and(
            ilike(v3Schema.v3WorkflowTemplates.name, args.idOrName),
            eq(v3Schema.v3WorkflowTemplates.version, args.version),
          ),
        )
        .limit(1);
    } else {
      rows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.id, args.idOrName))
        .limit(1);
      if (!rows.length) {
        rows = await db
          .select()
          .from(v3Schema.v3WorkflowTemplates)
          .where(ilike(v3Schema.v3WorkflowTemplates.name, args.idOrName))
          .orderBy(desc(v3Schema.v3WorkflowTemplates.version))
          .limit(1);
      }
    }
    if (!rows.length) throw new Error(`Template '${args.idOrName}' not found`);
    const r = rows[0];
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      description: r.description,
      dag: r.dag,
      inputSchema: r.inputSchema,
      createdAt: r.createdAt,
    };
  },
});

/** Save a V3 workflow template. Validates DAG, auto-increments version. */
export const workflowSave = defineAction({
  description:
    "Save a V3 workflow template. Validates the DAG and auto-increments version.",
  schema: z.object({
    name: z.string(),
    dag: z.unknown(),
    inputSchema: z
      .unknown()
      .optional()
      .default({ type: "object", properties: {} }),
    description: z.string().optional().default(""),
  }),
  run: async (args) => {
    const dagResult = validateDag(args.dag);
    if (!dagResult.ok) {
      throw new Error(`Invalid DAG: ${dagResult.errors.join("; ")}`);
    }

    const ajv = new Ajv({ strict: false });
    addFormats(ajv, allFormats);
    try {
      ajv.compile(args.inputSchema as object);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Invalid input_schema: ${msg}`);
    }

    const db = getV3Db();
    const existing = await db
      .select({ version: v3Schema.v3WorkflowTemplates.version })
      .from(v3Schema.v3WorkflowTemplates)
      .where(eq(v3Schema.v3WorkflowTemplates.name, args.name))
      .orderBy(desc(v3Schema.v3WorkflowTemplates.version))
      .limit(1);
    const version = (existing[0]?.version ?? 0) + 1;
    const id = newId("v3wf");

    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;

    await db.insert(v3Schema.v3WorkflowTemplates).values({
      id,
      name: args.name,
      version,
      description: args.description,
      dag: args.dag,
      inputSchema: args.inputSchema,
      ownerEmail,
      orgId,
    });

    return { id, name: args.name, version, ok: true };
  },
});

/** Hard-delete a V3 workflow template by id or name. */
export const workflowDelete = defineAction({
  description: "Delete a V3 workflow template by id or name.",
  schema: z.object({
    idOrName: z.string(),
  }),
  run: async (args) => {
    const db = getV3Db();
    let rows = await db
      .select()
      .from(v3Schema.v3WorkflowTemplates)
      .where(eq(v3Schema.v3WorkflowTemplates.id, args.idOrName))
      .limit(1);
    if (!rows.length) {
      rows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(ilike(v3Schema.v3WorkflowTemplates.name, args.idOrName));
    }
    if (!rows.length) throw new Error(`Template '${args.idOrName}' not found`);

    const idsToDelete = rows.map((r) => r.id);
    for (const id of idsToDelete) {
      await db
        .delete(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.id, id));
    }

    return { deleted: idsToDelete.length, ok: true };
  },
});

/**
 * Start a V3 workflow run.
 * Accepts either a template (idOrName) to look up, or a dag directly.
 * Validates inputs against the template's input_schema via ajv.
 */
export const workflowRun = defineAction({
  description:
    "Start a V3 workflow run. Accepts a template (idOrName) or a direct dag. Validates inputs, inserts run + node rows.",
  schema: z.object({
    template: z.string().optional(),
    dag: z.unknown().optional(),
    inputs: z.record(z.string(), z.unknown()).default({}),
    tags: z.record(z.string(), z.unknown()).optional(),
    priority: z.number().int().optional().default(0),
  }),
  run: async (args) => {
    const db = getV3Db();

    // Resolve template from idOrName, or use direct dag
    let templateId: string | null = null;
    let templateVersion: number | null = null;
    let dag: unknown = null;
    let inputSchema: object | null = null;

    if (args.template) {
      let templateRows = await db
        .select()
        .from(v3Schema.v3WorkflowTemplates)
        .where(eq(v3Schema.v3WorkflowTemplates.id, args.template))
        .limit(1);
      if (!templateRows.length) {
        templateRows = await db
          .select()
          .from(v3Schema.v3WorkflowTemplates)
          .where(ilike(v3Schema.v3WorkflowTemplates.name, args.template))
          .orderBy(desc(v3Schema.v3WorkflowTemplates.version))
          .limit(1);
      }
      if (!templateRows.length) {
        throw new Error(`Template '${args.template}' not found`);
      }
      const template = templateRows[0];
      templateId = template.id;
      templateVersion = template.version;
      inputSchema = template.inputSchema as object;
      dag = args.dag ?? template.dag;
    } else if (args.dag) {
      dag = args.dag;
    } else {
      throw new Error("Either template or dag is required");
    }

    // Validate DAG
    const dagResult = validateDag(dag);
    if (!dagResult.ok) {
      throw new Error(`Invalid DAG: ${dagResult.errors.join("; ")}`);
    }

    // Validate inputs against input_schema (if we have one)
    if (inputSchema) {
      const ajv = new Ajv({ strict: false });
      addFormats(ajv, allFormats);
      try {
        const validate = ajv.compile(inputSchema);
        const valid = validate(args.inputs);
        if (!valid) {
          throw new Error(`Invalid inputs: ${JSON.stringify(validate.errors)}`);
        }
      } catch (e: unknown) {
        if (e instanceof Error && e.message.startsWith("Invalid inputs")) throw e;
        throw new Error(
          `Template input_schema error: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    const runId = newId("v3r");
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;

    // Insert run
    await db.insert(v3Schema.v3Runs).values({
      id: runId,
      templateId,
      templateVersion,
      inputs: args.inputs,
      dag,
      dagVersion: 1,
      status: "pending",
      priority: args.priority,
      tags: args.tags ?? null,
      ownerEmail,
      orgId,
    });

    // Insert node rows from DAG
    const dagTyped = dag as { nodes?: Array<{ id: string; type: string }> };
    const nodes = dagTyped?.nodes ?? [];
    for (const node of nodes) {
      await db.insert(v3Schema.v3Nodes).values({
        id: newId("v3n"),
        runId,
        nodeIdInDag: node.id,
        type: node.type,
        status: "pending",
        iteration: 0,
        fanoutIndex: 0,
        ownerEmail,
        orgId,
      });
    }

    return {
      runId,
      dagVersion: 1,
      templateId,
      templateVersion,
      status: "pending" as const,
      nodeCount: nodes.length,
    };
  },
});
