import { defineAction } from "@agent-native/core";
import { eq, and, desc, ilike, isNotNull, isNull, sql, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema, resolveOwnerEmail } from "../server/db/index.js";

export interface V3SpawnRow {
  id: string;
  nodeId: string | null;
  runId: string | null;
  attempt: number;
  agentName: string | null;
  engineRef: string | null;
  modelRef: string | null;
  runtime: string | null;
  workspaceId: string | null;
  renderedPrompt: string;
  logRef: string | null;
  vmName: string | null;
  acpSessionId: string | null;
  status: string;
  outputArtifactId: string | null;
  outputKind: string | null;
  tokensInput: number;
  tokensOutput: number;
  latencyMs: number | null;
  error: string | null;
  errorClass: string | null;
  tags: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string | null;
}

/**
 * List V3 spawns with optional filters.
 * A spawn is run-scoped when it has a nodeId (belonging to a node in a run),
 * and ad-hoc when nodeId is null.
 */
export const spawnList = defineAction({
  description:
    "List V3 spawns with optional scope (run-scoped vs ad-hoc), status, agent, tagMatch (JSONB containment partial key/value match), since, and pagination filters.",
  schema: z.object({
    scope: z.enum(["run-scoped", "ad-hoc", "all"]).default("all"),
    status: z.string().optional(),
    agentName: z.string().optional(),
    /**
     * Partial JSONB containment match — pass an object whose keys/values must
     * ALL appear in the spawn's tags column. Uses Postgres @> operator.
     * E.g. { source: "tracker", item_id: "PAY-14" }.
     */
    tagMatch: z.record(z.string(), z.string()).optional(),
    /** ISO-8601 datetime — return only spawns started at or after this time. */
    since: z.string().datetime({ offset: true }).optional(),
    limit: z.number().int().positive().default(100),
    offset: z.number().int().min(0).default(0),
  }),
  readOnly: true,
  // Advertise on the A2A agent card so peer apps (e.g. tracker) can discover
  // this read-back surface for tag-match activity reassembly (v3-DESIGN §16).
  publicAgent: { expose: true, readOnly: true, requiresAuth: false },
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();
    const conditions: Array<import("drizzle-orm").SQL> = [];

    // Fail-closed owner scope — ALWAYS constrain to the resolved owner's spawns
    // so no request (including an unauthenticated A2A peer) can enumerate
    // another owner's spawns.
    conditions.push(eq(v3Schema.v3Spawns.ownerEmail, resolveOwnerEmail()));

    // Scope filter: run-scoped has nodeId, ad-hoc has no nodeId
    if (args.scope === "run-scoped") {
      conditions.push(isNotNull(v3Schema.v3Spawns.nodeId));
    } else if (args.scope === "ad-hoc") {
      conditions.push(isNull(v3Schema.v3Spawns.nodeId));
    }

    if (args.status) {
      conditions.push(
        eq(v3Schema.v3Spawns.status, args.status as any),
      );
    }
    if (args.agentName) {
      conditions.push(
        ilike(v3Schema.v3Spawns.agentName, `%${args.agentName}%`),
      );
    }

    // JSONB containment: tags @> $1::jsonb (design §16: partial key/value match)
    if (args.tagMatch && Object.keys(args.tagMatch).length > 0) {
      conditions.push(
        sql`${v3Schema.v3Spawns.tags} @> ${JSON.stringify(args.tagMatch)}::jsonb`,
      );
    }

    if (args.since) {
      conditions.push(gte(v3Schema.v3Spawns.startedAt, new Date(args.since)));
    }

    const rows = await db
      .select({
        id: v3Schema.v3Spawns.id,
        nodeId: v3Schema.v3Spawns.nodeId,
        attempt: v3Schema.v3Spawns.attempt,
        agentName: v3Schema.v3Spawns.agentName,
        engineRef: v3Schema.v3Spawns.engineRef,
        modelRef: v3Schema.v3Spawns.modelRef,
        runtime: v3Schema.v3Spawns.runtime,
        workspaceId: v3Schema.v3Spawns.workspaceId,
        renderedPrompt: v3Schema.v3Spawns.renderedPrompt,
        logRef: v3Schema.v3Spawns.logRef,
        vmName: v3Schema.v3Spawns.vmName,
        acpSessionId: v3Schema.v3Spawns.acpSessionId,
        status: v3Schema.v3Spawns.status,
        outputArtifactId: v3Schema.v3Spawns.outputArtifactId,
        outputKind: v3Schema.v3Spawns.outputKind,
        tokensInput: v3Schema.v3Spawns.tokensInput,
        tokensOutput: v3Schema.v3Spawns.tokensOutput,
        latencyMs: v3Schema.v3Spawns.latencyMs,
        error: v3Schema.v3Spawns.error,
        errorClass: v3Schema.v3Spawns.errorClass,
        tags: v3Schema.v3Spawns.tags,
        startedAt: v3Schema.v3Spawns.startedAt,
        completedAt: v3Schema.v3Spawns.completedAt,
      })
      .from(v3Schema.v3Spawns)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(v3Schema.v3Spawns.startedAt))
      .limit(args.limit)
      .offset(args.offset);

    // Resolve runId from nodeId for run-scoped spawns
    const runScopedRows = rows.filter((r) => r.nodeId != null);
    let nodeIdToRunId: Map<string, string> = new Map();
    if (runScopedRows.length > 0) {
      const nodeIds = runScopedRows.map((r) => r.nodeId!) as string[];
      const nodeRows = await db
        .select({
          id: v3Schema.v3Nodes.id,
          runId: v3Schema.v3Nodes.runId,
        })
        .from(v3Schema.v3Nodes)
        .where(inArray(v3Schema.v3Nodes.id, nodeIds));
      nodeIdToRunId = new Map(
        nodeRows.map((n) => [n.id, n.runId]),
      );
    }

    return rows.map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      runId: nodeIdToRunId.get(r.nodeId ?? "") ?? null,
      attempt: r.attempt,
      agentName: r.agentName,
      engineRef: r.engineRef,
      modelRef: r.modelRef,
      runtime: r.runtime,
      workspaceId: r.workspaceId,
      renderedPrompt: r.renderedPrompt,
      logRef: r.logRef,
      vmName: r.vmName,
      acpSessionId: r.acpSessionId,
      status: r.status,
      outputArtifactId: r.outputArtifactId,
      outputKind: r.outputKind,
      tokensInput: r.tokensInput,
      tokensOutput: r.tokensOutput,
      latencyMs: r.latencyMs,
      error: r.error,
      errorClass: r.errorClass,
      tags: r.tags,
      startedAt: r.startedAt?.toISOString() ?? null,
      completedAt: r.completedAt?.toISOString() ?? null,
      createdAt: null,
    })) as V3SpawnRow[];
  },
});

/** Get full detail for a single V3 spawn. */
export const spawnGet = defineAction({
  description: "Get full detail for a single V3 spawn including prompt and output.",
  schema: z.object({
    spawnId: z.string(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const db = getV3Db();

    // Fail-closed owner scope — a foreign spawn simply isn't found.
    const spawnRows = await db
      .select()
      .from(v3Schema.v3Spawns)
      .where(
        and(
          eq(v3Schema.v3Spawns.id, args.spawnId),
          eq(v3Schema.v3Spawns.ownerEmail, resolveOwnerEmail()),
        ),
      )
      .limit(1);

    if (!spawnRows.length) {
      throw new Error(`Spawn '${args.spawnId}' not found`);
    }

    const s = spawnRows[0];

    // Resolve runId from nodeId
    let runId: string | null = null;
    if (s.nodeId) {
      const nodeRows = await db
        .select({ runId: v3Schema.v3Nodes.runId })
        .from(v3Schema.v3Nodes)
        .where(eq(v3Schema.v3Nodes.id, s.nodeId))
        .limit(1);
      if (nodeRows.length) {
        runId = nodeRows[0].runId;
      }
    }

    // Fetch output artifact if present
    let output: string | null = null;
    let log: string | null = null;

    if (s.outputArtifactId) {
      const artRows = await db
        .select({
          textContent: v3Schema.v3Artifacts.textContent,
          objectContent: v3Schema.v3Artifacts.objectContent,
        })
        .from(v3Schema.v3Artifacts)
        .where(eq(v3Schema.v3Artifacts.id, s.outputArtifactId))
        .limit(1);

      if (artRows.length) {
        const art = artRows[0];
        output = art.textContent ?? (art.objectContent != null ? JSON.stringify(art.objectContent, null, 2) : null);
      }
    }

    // Fetch log artifact if logRef points to an artifact id
    if (s.logRef) {
      const logRows = await db
        .select({ textContent: v3Schema.v3Artifacts.textContent })
        .from(v3Schema.v3Artifacts)
        .where(eq(v3Schema.v3Artifacts.id, s.logRef))
        .limit(1);

      if (logRows.length) {
        log = logRows[0].textContent;
      }
    }

    return {
      id: s.id,
      nodeId: s.nodeId,
      runId,
      attempt: s.attempt,
      agentName: s.agentName,
      engineRef: s.engineRef,
      modelRef: s.modelRef,
      runtime: s.runtime,
      workspaceId: s.workspaceId,
      renderedPrompt: s.renderedPrompt,
      logRef: s.logRef,
      vmName: s.vmName,
      acpSessionId: s.acpSessionId,
      status: s.status,
      outputArtifactId: s.outputArtifactId,
      outputKind: s.outputKind,
      tokensInput: s.tokensInput,
      tokensOutput: s.tokensOutput,
      latencyMs: s.latencyMs,
      error: s.error,
      errorClass: s.errorClass,
      tags: s.tags,
      startedAt: s.startedAt?.toISOString() ?? null,
      completedAt: s.completedAt?.toISOString() ?? null,
      // Detail-only fields
      output,
      log,
    } as V3SpawnRow & { runId: string | null; output?: string | null; log?: string | null };
  },
});
