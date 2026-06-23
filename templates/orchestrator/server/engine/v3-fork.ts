// V3 Run Fork (DESIGN §8.4, IMPLEMENTATION P2 §B)
//
// Clone an existing run with artifact caching.  Resolved nodes reuse their
// artifacts; fromNode and its transitive descendants are reset to pending so
// the reconciler re-executes them.

import { eq, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { customAlphabet } from "nanoid";
import { v3Runs, v3Nodes, v3Artifacts, v3Spawns } from "../db/v3-schema.js";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

type NodeRow = InferSelectModel<typeof v3Nodes>;
type ArtifactRow = InferSelectModel<typeof v3Artifacts>;
type SpawnRow = InferSelectModel<typeof v3Spawns>;
type NodeInsert = InferInsertModel<typeof v3Nodes>;
type ArtifactInsert = InferInsertModel<typeof v3Artifacts>;
type SpawnInsert = InferInsertModel<typeof v3Spawns>;

export interface V3NodeDag {
  id: string;
  type: "agent" | "parallel_over" | "loop" | "human_gate";
  deps?: string[];
  [key: string]: unknown;
}

interface V3DagPayload {
  nodes: V3NodeDag[];
}

/**
 * Options for forking a run.
 */
export interface ForkOptions {
  /**
   * Node id and all transitive descendants that get reset to pending.
   * Artifacts are evicted for these nodes so the reconciler re-executes
   * this branch.  Omit to fork the entire run fresh (no cache).
   */
  fromNode?: string;

  /**
   * Extra tags merged into the source run's tags.  Keys in extraTags
   * overwrite keys with the same name from the source.
   */
  extraTags?: Record<string, string>;

  /**
   * Partial input overrides.  Merged shallowly into source inputs.
   * Pending nodes will pick up the new values when the reconciler renders
   * their prompts.
   */
  overrideInputs?: Record<string, unknown>;
}

export interface ForkResult {
  /** The id of the newly created fork run. */
  runId: string;
}

// ── ID generation ────────────────────────────────────────────────────────────

const gen = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 12);

function uid(prefix: string): string {
  return `${prefix}_${gen()}`;
}

// ── Resolved statuses ────────────────────────────────────────────────────────

const RESOLVED_STATUSES = new Set(["done", "skipped"]);

// ── DAG Helpers ──────────────────────────────────────────────────────────────

/**
 * Build a forward-adjacency map: nodeId -> [successor ids].
 * Edges are inferred from deps (dep -> node).
 */
function buildSuccessors(dag: V3NodeDag[]): Map<string, string[]> {
  const successors = new Map<string, string[]>();
  for (const node of dag) {
    successors.set(node.id, []);
  }
  for (const node of dag) {
    for (const dep of node.deps ?? []) {
      const list = successors.get(dep);
      if (list) {
        list.push(node.id);
      }
    }
  }
  return successors;
}

/**
 * Collect `fromNode` and all transitive descendants via BFS.
 */
function collectDescendants(
  fromNode: string,
  successors: Map<string, string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [fromNode];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const next = successors.get(current);
    if (next) {
      for (const child of next) {
        if (!visited.has(child)) {
          queue.push(child);
        }
      }
    }
  }

  return visited;
}

/**
 * Deep-clone the DAG so the fork owns its own copy.
 */
function cloneDag(dag: V3DagPayload): V3DagPayload {
  return JSON.parse(JSON.stringify(dag));
}

// ── Merge helpers ────────────────────────────────────────────────────────────

function mergeTags(
  base: Record<string, string> | null | undefined,
  extra: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!base && !extra) return null;
  const merged = { ...(base ?? {}), ...(extra ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

function mergeInputs(
  base: Record<string, unknown>,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) return { ...base };
  return { ...base, ...overrides };
}

// ── Fork ─────────────────────────────────────────────────────────────────────

/**
 * Fork an existing V3 run with artifact caching.
 *
 * Steps:
 *  1. Read source run (dag, inputs, tags, dag_version)
 *  2. Create new v3_runs row (pending, cloned DAG, merged inputs)
 *  3. Clone all v3_nodes from source
 *  4. For resolved nodes: copy v3_artifacts, set new nodes to done with
 *     artifact refs
 *  5. fromNode + transitive descendants reset to pending (no artifact cache)
 *  6. Merge tags: source.tags merged with options.extraTags
 *  7. Return new runId
 */
export async function forkRun(
  db: PostgresJsDatabase,
  sourceRunId: string,
  options: ForkOptions = {},
): Promise<ForkResult> {
  // ── 1. Read source run ─────────────────────────────────────────────────

  const [sourceRun] = await db
    .select()
    .from(v3Runs)
    .where(eq(v3Runs.id, sourceRunId));

  if (!sourceRun) {
    throw new Error(`Source run not found: ${sourceRunId}`);
  }

  const sourceNodes = await db
    .select()
    .from(v3Nodes)
    .where(eq(v3Nodes.runId, sourceRunId));

  // ── 2. Create new run ────────────────────────────────────────────────

  const newRunId = uid("run");
  const clonedDag = cloneDag(sourceRun.dag as V3DagPayload);
  const mergedInputs = mergeInputs(
    (sourceRun.inputs as Record<string, unknown>) ?? {},
    options.overrideInputs,
  );
  const mergedTags = mergeTags(
    sourceRun.tags as Record<string, string> | null,
    options.extraTags,
  );

  await db.insert(v3Runs).values({
    id: newRunId,
    templateId: sourceRun.templateId,
    templateVersion: sourceRun.templateVersion,
    inputs: mergedInputs,
    dag: clonedDag,
    dagVersion: sourceRun.dagVersion,
    status: "pending",
    priority: sourceRun.priority,
    tags: mergedTags,
    startedAt: null,
    completedAt: null,
    ownerEmail: sourceRun.ownerEmail,
    orgId: sourceRun.orgId,
  });

  // ── 3-5. Clone nodes with artifact caching ──────────────────────────

  // Compute the set of DAG node IDs to reset (fromNode + descendants)
  const resetNodeIds = options.fromNode
    ? collectDescendants(options.fromNode, buildSuccessors(clonedDag.nodes))
    : new Set<string>();

  // Pre-load all spawns and artifacts for the source run so we can clone
  // resolved node data in a single pass per node.
  const sourceNodeDbIds = sourceNodes.map((n) => n.id);
  const spawnByNodeId = new Map<string, SpawnRow[]>();
  const artifactBySpawnId = new Map<string, ArtifactRow[]>();

  if (sourceNodeDbIds.length > 0) {
    const sourceSpawns = await db
      .select()
      .from(v3Spawns)
      .where(inArray(v3Spawns.nodeId, sourceNodeDbIds));

    for (const spawn of sourceSpawns) {
      if (!spawn.nodeId) continue;
      const list = spawnByNodeId.get(spawn.nodeId) ?? [];
      list.push(spawn);
      spawnByNodeId.set(spawn.nodeId, list);
    }

    const sourceSpawnIds = sourceSpawns
      .map((s) => s.id)
      .filter((id): id is string => id !== null);

    if (sourceSpawnIds.length > 0) {
      const sourceArtifacts = await db
        .select()
        .from(v3Artifacts)
        .where(inArray(v3Artifacts.spawnId, sourceSpawnIds));

      for (const artifact of sourceArtifacts) {
        const list = artifactBySpawnId.get(artifact.spawnId) ?? [];
        list.push(artifact);
        artifactBySpawnId.set(artifact.spawnId, list);
      }
    }
  }

  // Process each source node and build insert batches.
  // We track old->new ID mappings so artifact references are rewired.
  const nodeIdMap = new Map<string, string>(); // old node DB id -> new
  const spawnIdMap = new Map<string, string>(); // old spawn id -> new
  const artifactIdMap = new Map<string, string>(); // old artifact id -> new

  const nodeInserts: NodeInsert[] = [];
  const spawnInserts: SpawnInsert[] = [];
  const artifactInserts: ArtifactInsert[] = [];

  for (const srcNode of sourceNodes) {
    const newNodeId = uid("n");
    nodeIdMap.set(srcNode.id, newNodeId);
    const shouldReset = resetNodeIds.has(srcNode.nodeIdInDag);

    if (shouldReset) {
      // Reset to pending, no artifact cache
      nodeInserts.push({
        id: newNodeId,
        runId: newRunId,
        nodeIdInDag: srcNode.nodeIdInDag,
        type: srcNode.type,
        status: "pending",
        iteration: srcNode.iteration,
        fanoutIndex: srcNode.fanoutIndex,
        currentSpawnId: null,
        outputArtifactId: null,
        startedAt: null,
        completedAt: null,
        error: null,
        ownerEmail: sourceRun.ownerEmail,
        orgId: sourceRun.orgId,
      });
      continue;
    }

    const isResolved = RESOLVED_STATUSES.has(srcNode.status);

    if (isResolved) {
      // Clone spawn + artifacts for resolved nodes
      const srcSpawns = spawnByNodeId.get(srcNode.id) ?? [];

      if (srcSpawns.length > 0) {
        // Clone the last (highest-attempt) spawn
        const lastSpawn = srcSpawns[srcSpawns.length - 1];
        const newSpawnId = uid("sp");
        spawnIdMap.set(lastSpawn.id, newSpawnId);

        // Clone artifacts for this spawn
        const srcArtifacts = artifactBySpawnId.get(lastSpawn.id) ?? [];
        let newOutputArtifactId: string | null = null;

        for (const art of srcArtifacts) {
          const newArtId = uid("art");
          artifactIdMap.set(art.id, newArtId);

          if (art.id === lastSpawn.outputArtifactId) {
            newOutputArtifactId = newArtId;
          }

          artifactInserts.push({
            id: newArtId,
            spawnId: newSpawnId,
            kind: art.kind,
            textContent: art.textContent,
            objectContent: art.objectContent,
            fullContentRef: art.fullContentRef,
            byteSize: art.byteSize,
            truncated: art.truncated,
            createdAt: new Date(),
            ownerEmail: sourceRun.ownerEmail,
            orgId: sourceRun.orgId,
          });
        }

        spawnInserts.push({
          id: newSpawnId,
          nodeId: newNodeId,
          attempt: lastSpawn.attempt,
          agentName: lastSpawn.agentName,
          engineRef: lastSpawn.engineRef,
          modelRef: lastSpawn.modelRef,
          runtime: lastSpawn.runtime,
          workspaceId: null, // Fork does not clone workspace VM
          renderedPrompt: lastSpawn.renderedPrompt,
          logRef: lastSpawn.logRef,
          vmName: lastSpawn.vmName,
          acpSessionId: lastSpawn.acpSessionId,
          status: lastSpawn.status,
          outputArtifactId: newOutputArtifactId,
          outputKind: lastSpawn.outputKind,
          tokensInput: lastSpawn.tokensInput,
          tokensOutput: lastSpawn.tokensOutput,
          latencyMs: lastSpawn.latencyMs,
          error: lastSpawn.error,
          errorClass: lastSpawn.errorClass,
          tags: lastSpawn.tags,
          startedAt: lastSpawn.startedAt,
          completedAt: lastSpawn.completedAt,
          ownerEmail: sourceRun.ownerEmail,
          orgId: sourceRun.orgId,
        });
      }

      // Remap the node's outputArtifactId and currentSpawnId
      const newOutputArtId = srcNode.outputArtifactId
        ? artifactIdMap.get(srcNode.outputArtifactId) ?? null
        : null;
      const newSpawnRef = srcNode.currentSpawnId
        ? spawnIdMap.get(srcNode.currentSpawnId) ?? null
        : null;

      nodeInserts.push({
        id: newNodeId,
        runId: newRunId,
        nodeIdInDag: srcNode.nodeIdInDag,
        type: srcNode.type,
        status: srcNode.status,
        iteration: srcNode.iteration,
        fanoutIndex: srcNode.fanoutIndex,
        currentSpawnId: newSpawnRef,
        outputArtifactId: newOutputArtId,
        startedAt: srcNode.startedAt,
        completedAt: srcNode.completedAt,
        error: srcNode.error,
        ownerEmail: sourceRun.ownerEmail,
        orgId: sourceRun.orgId,
      });
    } else {
      // Non-resolved, non-reset: clone as-is (e.g. running nodes)
      nodeInserts.push({
        id: newNodeId,
        runId: newRunId,
        nodeIdInDag: srcNode.nodeIdInDag,
        type: srcNode.type,
        status: srcNode.status,
        iteration: srcNode.iteration,
        fanoutIndex: srcNode.fanoutIndex,
        currentSpawnId: srcNode.currentSpawnId,
        outputArtifactId: srcNode.outputArtifactId,
        startedAt: srcNode.startedAt,
        completedAt: srcNode.completedAt,
        error: srcNode.error,
        ownerEmail: sourceRun.ownerEmail,
        orgId: sourceRun.orgId,
      });
    }
  }

  // Bulk insert artifacts, spawns, then nodes (dependency order)
  if (artifactInserts.length > 0) {
    await db.insert(v3Artifacts).values(artifactInserts as any);
  }

  if (spawnInserts.length > 0) {
    await db.insert(v3Spawns).values(spawnInserts as any);
  }

  if (nodeInserts.length > 0) {
    await db.insert(v3Nodes).values(nodeInserts as any);
  }

  return { runId: newRunId };
}
