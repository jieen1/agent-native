import { defineAction } from "@agent-native/core";
import {
  getRequestUserEmail,
  getRequestOrgId,
} from "@agent-native/core/server/request-context";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";
import { eq, ilike, and, desc, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import { getV3Db, v3Schema } from "../server/db/index.js";
import { validateDag } from "../server/engine/dag-validator.js";
import { lintTemplateDispatchGrade } from "../server/engine/dispatch-grade-lint.js";
import {
  computeRunStats,
  diffDagNodes,
} from "../server/engine/workflow-stats.js";
import { triggerTickSafe } from "../server/plugins/v3-reconciler.js";
import { newId } from "./_util.js";

/** Shape of the `meta` JSONB column (s8-workflow-library migration, 04 §13).
 *  `metaTaggedOnly` (r4 doc §4.1, task #77's `workflow-templates-seed.ts`
 *  boot plugin): this version's `dag` was never written by this seed —
 *  it's a real brain/human row whose `meta` got patched by the boot
 *  script's name-collision path. Mutually exclusive with `builtin`. */
interface WorkflowTemplateMeta {
  builtin?: boolean;
  family?: "core" | "sdlc" | "light";
  tags?: string[];
  changeNote?: string;
  metaTaggedOnly?: boolean;
}

function readMeta(raw: unknown): WorkflowTemplateMeta {
  if (!raw || typeof raw !== "object") return {};
  return raw as WorkflowTemplateMeta;
}

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const allFormats: FormatName[] = [
  "date",
  "time",
  "date-time",
  "duration",
  "uri",
  "uri-reference",
  "uri-template",
  "url",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "regex",
  "uuid",
  "json-pointer",
  "json-pointer-uri-fragment",
  "relative-json-pointer",
  "byte",
  "int32",
  "int64",
  "float",
  "double",
];

/**
 * List V3 workflow templates — one row per distinct name, the LATEST version
 * only (workflowSave never mutates in place; every save inserts a new
 * version row under the same name). Rows are ordered newest-first, so the
 * first row seen per name is already its highest version.
 *
 * S8 workflow library (04 §4/§13): each entry also carries `meta` (builtin
 * flag / family / applicable-scenario tags) and `stats` — a 30-day run-count
 * + success-rate window computed from `v3_runs` for THIS template version
 * (not summed across the name's whole version history — see workflowVersions
 * for per-version, all-time stats in the version chain).
 */
export const workflowList = defineAction({
  description:
    "List V3 workflow templates, one entry per name (latest version only). " +
    "Each entry has { id, name, version, description, nodeCount, dag, createdAt, " +
    "ownerEmail, meta: { builtin, family, tags, changeNote, metaTaggedOnly }, " +
    "stats: { runCount, successRate }, dispatchGrade: { ok, level, passCount, " +
    "totalCount, results } } — stats are a 30-day window for this version; " +
    "dispatchGrade is the §4.2 7-rule lint (lintTemplateDispatchGrade), computed " +
    "fresh from this version's dag/inputSchema.",
  schema: z.object({}),
  readOnly: true,
  http: { method: "GET" },
  run: async () => {
    const db = getV3Db();
    // Not owner-scoped — matches workflowGet/workflowSave/workflowDelete/
    // workflowRun below, which have never scoped v3_workflow_templates by
    // owner (the shared template library is meant to be visible/usable by
    // anyone who can reach this app, unlike per-run/per-workspace V3 data).
    // Empirically verified on the 101 dogfood DB: real templates are owned by
    // a synthetic dogfood identity while boot-seeded rows default to
    // "local@localhost" — scoping ONLY this new read would have made the
    // library page show a different, incomplete slice of templates than
    // workflowGet/Save/Delete/Run still operate on by id, which is worse than
    // today's unscoped-everywhere behavior. Unifying ownership scoping across
    // all six template actions is legitimate follow-up work, not something to
    // bolt on partially as a side effect of this page rebuild.
    const rows = await db
      .select({
        id: v3Schema.v3WorkflowTemplates.id,
        name: v3Schema.v3WorkflowTemplates.name,
        version: v3Schema.v3WorkflowTemplates.version,
        description: v3Schema.v3WorkflowTemplates.description,
        dag: v3Schema.v3WorkflowTemplates.dag,
        inputSchema: v3Schema.v3WorkflowTemplates.inputSchema,
        meta: v3Schema.v3WorkflowTemplates.meta,
        createdAt: v3Schema.v3WorkflowTemplates.createdAt,
        ownerEmail: v3Schema.v3WorkflowTemplates.ownerEmail,
      })
      .from(v3Schema.v3WorkflowTemplates)
      .orderBy(desc(v3Schema.v3WorkflowTemplates.createdAt));

    const seenNames = new Set<string>();
    const latest: typeof rows = [];
    for (const r of rows) {
      if (seenNames.has(r.name)) continue;
      seenNames.add(r.name);
      latest.push(r);
    }

    // One batched fetch of recent run statuses for every latest-version id,
    // instead of one query per template (performance skill — avoid N+1).
    const ids = latest.map((r) => r.id);
    const recentRunsByTemplate = new Map<string, { status: string }[]>();
    if (ids.length > 0) {
      const since = new Date(Date.now() - RECENT_WINDOW_MS);
      const runRows = await db
        .select({
          templateId: v3Schema.v3Runs.templateId,
          status: v3Schema.v3Runs.status,
        })
        .from(v3Schema.v3Runs)
        .where(
          and(
            inArray(v3Schema.v3Runs.templateId, ids),
            gte(v3Schema.v3Runs.startedAt, since),
          ),
        );
      for (const r of runRows) {
        if (!r.templateId) continue;
        const bucket = recentRunsByTemplate.get(r.templateId) ?? [];
        bucket.push({ status: r.status });
        recentRunsByTemplate.set(r.templateId, bucket);
      }
    }

    return latest.map((r) => {
      const nodes = (r.dag as { nodes?: unknown[] } | null)?.nodes;
      const meta = readMeta(r.meta);
      return {
        id: r.id,
        name: r.name,
        version: r.version,
        description: r.description,
        nodeCount: Array.isArray(nodes) ? nodes.length : 0,
        dag: r.dag,
        createdAt: r.createdAt,
        ownerEmail: r.ownerEmail,
        meta: {
          builtin: meta.builtin === true,
          family: meta.family,
          tags: meta.tags ?? [],
          changeNote: meta.changeNote,
          metaTaggedOnly: meta.metaTaggedOnly === true,
        },
        stats: computeRunStats(recentRunsByTemplate.get(r.id) ?? []),
        dispatchGrade: lintTemplateDispatchGrade(r.dag, r.inputSchema),
      };
    });
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
  http: { method: "GET" },
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
    "Save a V3 workflow template. Validates the DAG and auto-increments version. " +
    "`changeNote` records what changed in THIS version (shown in the workflow " +
    "library's version chain); `tags` (适用场景标签) override the previous " +
    "version's tags when provided. The builtin/family flags of the previous " +
    "version always carry forward untouched — editing a built-in template's " +
    "DAG never strips its 内置 badge or family grouping.",
  schema: z.object({
    name: z.string(),
    dag: z.unknown(),
    inputSchema: z
      .unknown()
      .optional()
      .default({ type: "object", properties: {} }),
    description: z.string().optional().default(""),
    changeNote: z.string().optional(),
    tags: z.array(z.string()).optional(),
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
      .select({
        version: v3Schema.v3WorkflowTemplates.version,
        meta: v3Schema.v3WorkflowTemplates.meta,
      })
      .from(v3Schema.v3WorkflowTemplates)
      .where(eq(v3Schema.v3WorkflowTemplates.name, args.name))
      .orderBy(desc(v3Schema.v3WorkflowTemplates.version))
      .limit(1);
    const version = (existing[0]?.version ?? 0) + 1;
    const id = newId("v3wf");
    const prevMeta = readMeta(existing[0]?.meta);

    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const orgId = getRequestOrgId() ?? null;

    const meta: WorkflowTemplateMeta = {
      builtin: prevMeta.builtin === true,
      family: prevMeta.family,
      tags: args.tags ?? prevMeta.tags ?? [],
      changeNote: args.changeNote,
    };

    await db.insert(v3Schema.v3WorkflowTemplates).values({
      id,
      name: args.name,
      version,
      description: args.description,
      dag: args.dag,
      inputSchema: args.inputSchema,
      meta,
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

    // Normalize a JSON-string DAG to an object. validateDag() accepts and parses
    // a string form (a common, valid way the brain passes a DAG), but only
    // returns { ok, errors } — not the parsed value. Without this, both the
    // stored v3_runs.dag and the node-materialization loop below would see an
    // unparsed string, `dag.nodes` would be undefined, ZERO node rows would be
    // inserted, and the run would reconcile straight to "done" as an empty DAG.
    if (typeof dag === "string") {
      try {
        dag = JSON.parse(dag);
      } catch (e) {
        throw new Error(
          `Invalid DAG: failed to parse JSON string — ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
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
        if (e instanceof Error && e.message.startsWith("Invalid inputs"))
          throw e;
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
    // Fail loud rather than create a 0-node run that instantly reconciles to
    // "done" as a no-op (the symptom of the string-DAG bug above).
    if (nodes.length === 0) {
      throw new Error(
        "Invalid DAG: no nodes to run (dag.nodes is empty after parsing)",
      );
    }
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

    // G1: Trigger the first reconciler tick so pending nodes advance immediately.
    // Best-effort — a missing dispatcher/db config must not prevent run creation.
    triggerTickSafe(runId).catch(() => {});

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

/**
 * Validate a DAG definition without persisting it — powers the visual
 * workflow editor's live/"Validate" checks (structural shape, node types,
 * dep/cycle checks, guard/expression syntax, per-type field rules). Delegates
 * to the same `validateDag()` engine helper that `workflowSave`/`workflowRun`
 * enforce at write time, so the editor can never show "valid" for a DAG that
 * would then fail to save.
 */
export const dagValidate = defineAction({
  description:
    "Validate a DAG definition (an object with a nodes array) without saving it. " +
    "Returns { ok, errors } — errors are prefixed with the offending node id where applicable.",
  schema: z.object({ dag: z.unknown() }),
  readOnly: true,
  run: async (args) => {
    return validateDag(args.dag);
  },
});

/**
 * Dispatch-grade lint (r4 doc §4.2, task #78) for a DAG + inputSchema without
 * saving it — powers the editor's live "派发级检查" panel. Same
 * validate-before-save pattern as `dagValidate`: re-run on every debounced
 * edit so the panel never shows a rule result the saved version wouldn't
 * also get from `workflowList`'s per-row `dispatchGrade`.
 */
export const dagDispatchGradeLint = defineAction({
  description:
    "Lint a DAG + inputSchema for dispatch-grade readiness (04 doc §4.2's 7 " +
    "rules) without saving. Returns { ok, level, passCount, totalCount, results } " +
    "— results[] has { rule, key, label, confidence: 'structural'|'heuristic', ok, " +
    "detail, nodeIds }. Run validateDag first; this assumes a shape-valid dag.",
  schema: z.object({ dag: z.unknown(), inputSchema: z.unknown().optional() }),
  readOnly: true,
  run: async (args) => {
    return lintTemplateDispatchGrade(args.dag, args.inputSchema ?? {});
  },
});

/**
 * List every saved version of a workflow template by name — the "version
 * chain" the workflow library's detail strip renders (04 §4). Each entry
 * carries its own all-time run stats (no 30-day window — the chain is a
 * historical record, not a "what's active now" view like the card grid).
 */
export const workflowVersions = defineAction({
  description:
    "List every saved version of a V3 workflow template by name, newest first. " +
    "Each entry has { id, version, description, createdAt, ownerEmail, " +
    "meta: { builtin, family, tags, changeNote, metaTaggedOnly }, " +
    "stats: { runCount, successRate } } — " +
    "stats are all-time (this exact version's runs only), not a 30-day window.",
  schema: z.object({ name: z.string() }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    // Not owner-scoped — see workflowList's comment above for why the V3
    // template library reads stay unscoped, matching the pre-existing
    // workflowGet/Save/Delete/Run in this file.
    const db = getV3Db();
    const rows = await db
      .select({
        id: v3Schema.v3WorkflowTemplates.id,
        version: v3Schema.v3WorkflowTemplates.version,
        description: v3Schema.v3WorkflowTemplates.description,
        meta: v3Schema.v3WorkflowTemplates.meta,
        createdAt: v3Schema.v3WorkflowTemplates.createdAt,
        ownerEmail: v3Schema.v3WorkflowTemplates.ownerEmail,
      })
      .from(v3Schema.v3WorkflowTemplates)
      .where(eq(v3Schema.v3WorkflowTemplates.name, args.name))
      .orderBy(desc(v3Schema.v3WorkflowTemplates.version));

    if (rows.length === 0) {
      throw new Error(`Template '${args.name}' not found`);
    }

    const ids = rows.map((r) => r.id);
    const runsByTemplate = new Map<string, { status: string }[]>();
    const runRows = await db
      .select({
        templateId: v3Schema.v3Runs.templateId,
        status: v3Schema.v3Runs.status,
      })
      .from(v3Schema.v3Runs)
      .where(inArray(v3Schema.v3Runs.templateId, ids));
    for (const r of runRows) {
      if (!r.templateId) continue;
      const bucket = runsByTemplate.get(r.templateId) ?? [];
      bucket.push({ status: r.status });
      runsByTemplate.set(r.templateId, bucket);
    }

    return rows.map((r) => {
      const meta = readMeta(r.meta);
      return {
        id: r.id,
        version: r.version,
        description: r.description,
        createdAt: r.createdAt,
        ownerEmail: r.ownerEmail,
        meta: {
          builtin: meta.builtin === true,
          family: meta.family,
          tags: meta.tags ?? [],
          changeNote: meta.changeNote,
          metaTaggedOnly: meta.metaTaggedOnly === true,
        },
        stats: computeRunStats(runsByTemplate.get(r.id) ?? []),
      };
    });
  },
});

/**
 * Structural diff between two saved versions of the same template name (04
 * §4 "任意两版图级 diff" / §13 `workflowDiff(name, v1, v2)`). Returns node ids
 * added/removed/changed/unchanged by comparing `dag.nodes` — a full visual
 * graph-diff (color-coded canvas) is a frontend rendering concern on top of
 * this data, not implemented here.
 */
export const workflowDiff = defineAction({
  description:
    "Diff two saved versions of a V3 workflow template by name. Returns " +
    "{ name, v1, v2, added, removed, changed, unchanged } — arrays of node ids.",
  schema: z.object({
    name: z.string(),
    v1: z.number().int().positive(),
    v2: z.number().int().positive(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    // Not owner-scoped — see workflowList's comment above.
    const db = getV3Db();

    const fetchVersion = async (version: number) => {
      const rows = await db
        .select({ dag: v3Schema.v3WorkflowTemplates.dag })
        .from(v3Schema.v3WorkflowTemplates)
        .where(
          and(
            eq(v3Schema.v3WorkflowTemplates.name, args.name),
            eq(v3Schema.v3WorkflowTemplates.version, version),
          ),
        )
        .limit(1);
      if (!rows.length) {
        throw new Error(`Template '${args.name}' has no version ${version}`);
      }
      const nodes = (rows[0].dag as { nodes?: unknown[] } | null)?.nodes;
      return Array.isArray(nodes) ? (nodes as { id: string }[]) : [];
    };

    const [nodesV1, nodesV2] = await Promise.all([
      fetchVersion(args.v1),
      fetchVersion(args.v2),
    ]);

    const diff = diffDagNodes(nodesV1, nodesV2);
    return { name: args.name, v1: args.v1, v2: args.v2, ...diff };
  },
});
