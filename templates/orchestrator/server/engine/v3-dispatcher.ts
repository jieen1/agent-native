// V3 Dispatcher — bridge between reconciler and NodeRunner (DESIGN §6.2, IMPLEMENTATION §B)
//
// Sits between the V3 event-driven reconciler and the existing 7-stage NodeRunner.
// Responsibilities:
//   1. Resolve agent config from .claude/agents/*.md frontmatter
//   2. Build interpolation context from upstream dep artifacts
//   3. Render prompt via {{ }} interpolation
//   4. Map V3 4-inputs to NodeRunnerInput (adapter from D0 spike)
//   5. Classify output: string / object (ajv) / schema-violation
//   6. Truncate via max_summary_tokens
//   7. Write v3_spawns + v3_artifacts rows
//   8. Update v3_nodes status
//   9. Error class mapping: transient → rollback, permanent → keep, workspace_error → recreate

import { eq, and } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { FormatName } from "ajv-formats";

import { v3Runs, v3Nodes, v3Spawns, v3Artifacts } from "../db/v3-schema.js";
import type { InferSelectModel } from "drizzle-orm";
import { loadAgent, type AgentConfig } from "../agent-loader.js";
import { renderTemplate, type ExpressionContext } from "./interpolation.js";
import type { V3NodeDag } from "./v3-reconciler.js";
import type { V3Node } from "./dag-validator.js";
import { NodeRunner } from "../runtime/node-runner.js";
import type { RuntimeExecutor } from "../runtime/executors/types.js";
import type { Node, NodeRuntimeSpec } from "../../shared/types.js";

// ── Types ────────────────────────────────────────────────────────────────────

type RunRow = InferSelectModel<typeof v3Runs>;
type NodeRow = InferSelectModel<typeof v3Nodes>;

/**
 * V3 channel input: the 4 fields a spawn receives.
 * This is the V3 channel contract — enforced at this boundary.
 */
interface V3SpawnInput {
  system_prompt: string;
  rendered_prompt: string;
  tools?: string[];
  workspace?: string;
}

/**
 * V3 channel output paths (DESIGN §6.2):
 *   1. "string"  — default, no output_schema
 *   2. "object"  — output_schema present and output validates
 *   3. "schema-violation" — output_schema present but output fails validation
 */
type V3SpawnOutput =
  | { path: "string"; value: string }
  | { path: "object"; schema: unknown; value: Record<string, unknown> }
  | { path: "schema-violation"; schema: unknown; raw: unknown; error: string };

/** Error classification that drives retry policy. */
type ErrorClass = "transient" | "permanent" | "workspace_error";

// ── Constants ────────────────────────────────────────────────────────────────

/** Transient error substrings — API / network / OOM failures that can be retried. */
const TRANSIENT_INDICATORS = [
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EAI_FAIL",
  "EAI_AGAIN",
  "network",
  "timeout",
  "rate.limit",
  "rate limit",
  "too many requests",
  "429",
  "502",
  "503",
  "504",
  "OOM",
  "out of memory",
  "context deadline exceeded",
  "canceled",
  "aborted",
] as const;

/** Permanent error substrings — schema violations, config errors. */
const PERMANENT_INDICATORS = [
  "schema-violation",
  "output_schema",
  "invalid schema",
  "invalid output",
  "schema validation",
] as const;

/** Workspace error substrings — VM crash, mount failures. */
const WORKSPACE_INDICATORS = [
  "mount",
  "vm",
  "microsandbox",
  "msb",
  "provision",
  "teardown",
  "workdir",
  "workspace",
  "permission denied",
  "enoent",
  "eacces",
  "eexist",
] as const;

// ── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return crypto.randomUUID();
}

/** Classify an error into V3 error class to drive retry policy. */
function classifyErrorClass(error: unknown): ErrorClass {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  const lower = message.toLowerCase();

  // Check permanent first (schema violations are explicitly permanent)
  for (const indicator of PERMANENT_INDICATORS) {
    if (lower.includes(indicator)) return "permanent";
  }

  // Check workspace errors (VM/mount failures)
  for (const indicator of WORKSPACE_INDICATORS) {
    if (lower.includes(indicator)) return "workspace_error";
  }

  // Check transient (API/network timeouts)
  for (const indicator of TRANSIENT_INDICATORS) {
    if (lower.includes(indicator)) return "transient";
  }

  // Default: transient — retry once in case of unknown transient failure
  return "transient";
}

/** Map error class to NodeRunner onFailure policy. */
function errorClassToOnFailure(errorClass: ErrorClass): NodeRuntimeSpec["onFailure"] {
  switch (errorClass) {
    case "transient":
      return "rollback";
    case "permanent":
      return "keep";
    case "workspace_error":
      return "recreate";
  }
}

/**
 * Adapter: maps V3 4-inputs to NodeRunnerInput shape.
 * Derived from D0 spike (v3-channel-contract.spec.ts).
 */
function v3ToNodeRunnerInput(
  v3Input: V3SpawnInput,
  nodeId: string,
  nodeTitle: string,
  outputSchema?: unknown,
): { node: Node; deps: Record<string, unknown> } {
  const node: Node = {
    id: nodeId,
    type: "agent",
    title: nodeTitle,
    prompt: v3Input.rendered_prompt,
    runtime: v3Input.workspace
      ? { kind: "microvm", onFailure: "recreate" }
      : { kind: "none", onFailure: "recreate" },
    outputSchema,
  };
  return { node, deps: {} };
}

/**
 * Classify a NodeRunnerResult.output into V3 output paths.
 * If output_schema is present, validate via ajv.
 */
function classifyOutput(
  output: unknown,
  outputSchema?: unknown,
): V3SpawnOutput {
  // No schema → string path (JSON.stringify non-strings)
  if (outputSchema === undefined) {
    return {
      path: "string",
      value: typeof output === "string" ? output : JSON.stringify(output),
    };
  }

  // Schema present — must be a plain object (not array, not null)
  if (output !== null && typeof output === "object" && !Array.isArray(output)) {
    // Validate with ajv
    try {
      const ajv = createAjv();
      const validate = ajv.compile(outputSchema as object);
      const valid = validate(output as Record<string, unknown>);

      if (valid) {
        return {
          path: "object",
          schema: outputSchema,
          value: output as Record<string, unknown>,
        };
      }

      // Schema present but validation failed → violation
      return {
        path: "schema-violation",
        schema: outputSchema,
        raw: output,
        error: `Output does not match schema: ${validate.errors
          ?.map((e) => `${e.instancePath} ${e.message}`)
          .join("; ") ?? "validation failed"}`,
      };
    } catch (err: unknown) {
      // ajv compile failure (should not happen after dag validation, but be safe)
      return {
        path: "schema-violation",
        schema: outputSchema,
        raw: output,
        error: `Schema compile error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Array or null when object expected → schema-violation
  return {
    path: "schema-violation",
    schema: outputSchema,
    raw: output,
    error: `Output does not match schema: expected object, got ${
      Array.isArray(output) ? "array" : typeof output
    }`,
  };
}

/** Create an AJV instance with all standard formats. */
function createAjv(): Ajv {
  const ajv = new Ajv({ strict: false });
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
  addFormats(ajv, allFormats);
  return ajv;
}

/**
 * Truncate output to maxSummaryTokens.
 * Rough heuristic: 1 token ~ 4 chars. Enforces a character budget.
 */
function truncateToMaxTokens(
  text: string,
  maxTokens: number,
): { text: string; truncated: boolean } {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxChars) + "\n\n... [truncated by max_summary_tokens]",
    truncated: true,
  };
}

// ── V3Dispatcher ─────────────────────────────────────────────────────────────

export class V3Dispatcher {
  private readonly db: PostgresJsDatabase;
  private readonly runner: NodeRunner;

  constructor(db: PostgresJsDatabase, executor: RuntimeExecutor) {
    this.db = db;
    this.runner = new NodeRunner({ executor });
  }

  /**
   * Spawn an agent node (DESIGN §6.2, IMPLEMENTATION §B).
   *
   * Steps:
   *  1. Resolve agent config via loadAgent(node.assignee)
   *  2. Build interpolation context from v3_nodes deps → their v3_artifacts
   *  3. Render prompt via renderTemplate(node.prompt, context)
   *  4. Create V3 spawn input: { system_prompt, rendered_prompt, tools, workspace }
   *  5. Convert to NodeRunner input format (v3ToNodeRunnerInput)
   *  6. Call NodeRunner.run(input, signal)
   *  7. Classify output: string / object / schema-violation (via ajv)
   *  8. Truncate via max_summary_tokens if set
   *  9. Write v3_spawns row + v3_artifacts row
   *  10. Update v3_nodes status
   */
  async spawn(nodeRow: NodeRow, runId: string): Promise<string> {
    const spawnId = uid();
    const startedAt = new Date();

    // ── Step 1: Resolve agent config ──────────────────────────────────────
    const agentConfig = this.resolveAgentConfig(nodeRow);

    // ── Step 2: Build interpolation context ───────────────────────────────
    const context = await this.buildInterpolationContext(runId, nodeRow);

    // ── Step 3: Render prompt ─────────────────────────────────────────────
    const renderedPrompt = renderTemplate(agentConfig.systemPrompt, context);

    // ── Step 4: Create V3 spawn input (4-field channel contract) ──────────
    const v3Input: V3SpawnInput = {
      system_prompt: agentConfig.systemPrompt,
      rendered_prompt: renderedPrompt,
      tools: agentConfig.tools.length > 0 ? agentConfig.tools : undefined,
      workspace: agentConfig.runtime === "microvm" ? "/work" : undefined,
    };

    // Resolve the V3 node dag to find output_schema
    const dag = await this.loadDagForRun(runId);
    const dagNode = this.findDagNode(dag, nodeRow.nodeIdInDag);
    const outputSchema = (dagNode as { output_schema?: unknown })?.output_schema;

    // ── Step 5: Convert to NodeRunner input ───────────────────────────────
    const { node: runnerNode } = v3ToNodeRunnerInput(
      v3Input,
      nodeRow.id,
      nodeRow.nodeIdInDag,
      outputSchema,
    );

    // Apply engine/model from agent config if present
    if (agentConfig.engine) runnerNode.engine = agentConfig.engine;
    if (agentConfig.model) runnerNode.model = agentConfig.model;

    // ── Step 6: Call NodeRunner ───────────────────────────────────────────
    const signal = new AbortController().signal;
    const runnerResult = await this.runner.run(
      {
        node: runnerNode,
        deps: context.deps,
        ownerEmail: nodeRow.ownerEmail,
        orgId: nodeRow.orgId,
      },
      signal,
    );

    const latencyMs = Date.now() - startedAt.getTime();

    // ── Step 7: Classify output ───────────────────────────────────────────
    const classifiedOutput = classifyOutput(runnerResult.output, outputSchema);

    // ── Step 8: Truncate via max_summary_tokens ───────────────────────────
    let truncated = false;
    let textContent: string | null = null;
    let objectContent: Record<string, unknown> | null = null;

    switch (classifiedOutput.path) {
      case "string": {
        if (agentConfig.maxSummaryTokens) {
          const result = truncateToMaxTokens(classifiedOutput.value, agentConfig.maxSummaryTokens);
          textContent = result.text;
          truncated = result.truncated;
        } else {
          textContent = classifiedOutput.value;
        }
        break;
      }
      case "object": {
        objectContent = classifiedOutput.value;
        // Also store a text summary for quick reads
        textContent = JSON.stringify(classifiedOutput.value);
        if (agentConfig.maxSummaryTokens) {
          const result = truncateToMaxTokens(textContent, agentConfig.maxSummaryTokens);
          textContent = result.text;
          truncated = result.truncated;
        }
        break;
      }
      case "schema-violation": {
        textContent = `Schema violation: ${classifiedOutput.error}`;
        // Schema violation is a permanent error — write spawn + fail node
        await this.writeSpawnRecord({
          spawnId,
          nodeRow,
          agentConfig,
          renderedPrompt,
          startedAt,
          completedAt: new Date(),
          status: "failed",
          outputKind: "schema-violation",
          outputArtifactId: null,
          tokensInput: 0,
          tokensOutput: runnerResult.tokensSpent,
          latencyMs,
          error: classifiedOutput.error,
          errorClass: "permanent",
          vmName: runnerResult.vmName,
        });

        await this.failNode(nodeRow, classifiedOutput.error, "permanent");

        return spawnId;
      }
    }

    // ── Step 9: Write v3_spawns + v3_artifacts ────────────────────────────
    const artifactId = uid();
    const byteSize = textContent ? new TextEncoder().encode(textContent).length : 0;

    await this.db.insert(v3Artifacts).values({
      id: artifactId,
      spawnId,
      kind: classifiedOutput.path,
      textContent,
      objectContent,
      fullContentRef: null,
      byteSize,
      truncated: truncated ? 1 : 0,
      createdAt: new Date(),
      ownerEmail: nodeRow.ownerEmail,
      orgId: nodeRow.orgId,
    });

    await this.writeSpawnRecord({
      spawnId,
      nodeRow,
      agentConfig,
      renderedPrompt,
      startedAt,
      completedAt: new Date(),
      status: "done",
      outputKind: classifiedOutput.path,
      outputArtifactId: artifactId,
      tokensInput: 0,
      tokensOutput: runnerResult.tokensSpent,
      latencyMs,
      error: null,
      errorClass: null,
      vmName: runnerResult.vmName,
    });

    // ── Step 10: Update v3_nodes status ───────────────────────────────────
    await this.db
      .update(v3Nodes)
      .set({
        status: "done",
        outputArtifactId: artifactId,
        completedAt: new Date(),
      })
      .where(eq(v3Nodes.id, nodeRow.id));

    return spawnId;
  }

  /**
   * Resolve agent config from the node's assignee.
   * The assignee field holds the agent name (matches .claude/agents/{name}.md).
   */
  private resolveAgentConfig(nodeRow: NodeRow): AgentConfig {
    const agentName = nodeRow.nodeIdInDag;
    // The assignee is stored in the DAG dag field as the `agent` property on
    // agent nodes. We resolve from the DAG first, falling back to the nodeId.
    try {
      return loadAgent(agentName);
    } catch {
      // Agent file not found — return a minimal config so the spawn can still
      // proceed with the rendered prompt alone.
      return {
        name: agentName,
        description: "",
        runtime: "none" as const,
        engine: "",
        model: "",
        tools: [],
        systemPrompt: "",
      };
    }
  }

  /**
   * Build interpolation context for a node (DESIGN §5.1, §6.4).
   *
   * 1. Read node from v3_nodes to get nodeIdInDag
   * 2. Load DAG from v3_runs to find deps for this nodeIdInDag
   * 3. For each dep, find the dep node's output_artifact_id → read v3_artifacts
   * 4. Map artifact content to deps[depId].output
   * 5. Include v3_runs[runId].inputs as top-level inputs
   * 6. Return ExpressionContext shape
   */
  async buildInterpolationContext(
    runId: string,
    nodeRow: NodeRow,
  ): Promise<ExpressionContext> {
    // Read run inputs
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) {
      return { inputs: {}, deps: {} };
    }

    // Load DAG to resolve dep edges for this node
    const dag = await this.loadDagForRun(runId);
    const depIds = this.getNodeDeps(nodeRow, dag);

    // Read all nodes for this run to find dep artifact ids
    const allNodes = await this.db
      .select()
      .from(v3Nodes)
      .where(eq(v3Nodes.runId, runId));

    const deps: ExpressionContext["deps"] = {};

    for (const depId of depIds) {
      // Find the latest resolved node for this dep id
      const depNode = allNodes
        .filter(
          (n) => n.nodeIdInDag === depId && (n.status === "done" || n.status === "skipped"),
        )
        .sort((a, b) => b.iteration - a.iteration)[0];

      if (!depNode || !depNode.outputArtifactId) {
        deps[depId] = { output: undefined };
        continue;
      }

      // Read artifact
      const [artifact] = await this.db
        .select()
        .from(v3Artifacts)
        .where(eq(v3Artifacts.id, depNode.outputArtifactId));

      if (!artifact) {
        deps[depId] = { output: undefined };
        continue;
      }

      // Resolve artifact content: prefer object_content, fall back to text_content
      const output = artifact.objectContent ?? artifact.textContent;
      deps[depId] = { output };
    }

    // Cast run.inputs to Record<string, unknown>
    const inputs = (run.inputs ?? {}) as Record<string, unknown>;

    return {
      inputs,
      deps,
      iteration: nodeRow.iteration > 0 ? nodeRow.iteration : undefined,
    };
  }

  // ── Private: DB writes ───────────────────────────────────────────────────

  private async writeSpawnRecord(opts: {
    spawnId: string;
    nodeRow: NodeRow;
    agentConfig: AgentConfig;
    renderedPrompt: string;
    startedAt: Date;
    completedAt: Date;
    status: "done" | "failed" | "running" | "cancelled";
    outputKind: string;
    outputArtifactId: string | null;
    tokensInput: number;
    tokensOutput: number;
    latencyMs: number;
    error: string | null;
    errorClass: ErrorClass | null;
    vmName: string | null;
  }): Promise<void> {
    await this.db.insert(v3Spawns).values({
      id: opts.spawnId,
      nodeId: opts.nodeRow.id,
      attempt: 1,
      agentName: opts.agentConfig.name,
      engineRef: opts.agentConfig.engine || null,
      modelRef: opts.agentConfig.model || null,
      runtime: opts.agentConfig.runtime,
      workspaceId: null,
      renderedPrompt: opts.renderedPrompt,
      logRef: null,
      vmName: opts.vmName,
      acpSessionId: null,
      status: opts.status,
      outputArtifactId: opts.outputArtifactId,
      outputKind: opts.outputKind,
      tokensInput: opts.tokensInput,
      tokensOutput: opts.tokensOutput,
      latencyMs: opts.latencyMs,
      error: opts.error,
      errorClass: opts.errorClass,
      tags: null,
      startedAt: opts.startedAt,
      completedAt: opts.completedAt,
      ownerEmail: opts.nodeRow.ownerEmail,
      orgId: opts.nodeRow.orgId,
    });
  }

  private async failNode(
    nodeRow: NodeRow,
    error: string,
    errorClass: ErrorClass,
  ): Promise<void> {
    await this.db
      .update(v3Nodes)
      .set({
        status: "failed",
        error: error.slice(0, 1000),
        completedAt: new Date(),
      })
      .where(eq(v3Nodes.id, nodeRow.id));
  }

  // ── Private: DAG resolution ──────────────────────────────────────────────

  /**
   * Load DAG from v3_runs for a given run. Returns an array of node objects
   * from the stored DAG JSON.
   */
  private async loadDagForRun(runId: string): Promise<V3Node[]> {
    const [run] = await this.db
      .select()
      .from(v3Runs)
      .where(eq(v3Runs.id, runId));

    if (!run) return [];

    const dagRaw = run.dag as Record<string, unknown> | null;
    if (!dagRaw || typeof dagRaw !== "object") return [];

    const nodes = dagRaw.nodes as V3Node[] | undefined;
    return Array.isArray(nodes) ? nodes : [];
  }

  /** Find a DAG node by id. */
  private findDagNode(
    dag: V3Node[],
    nodeId: string,
  ): V3Node | undefined {
    return dag.find((n) => n.id === nodeId);
  }

  /** Get dependency ids for a node from the DAG. */
  private getNodeDeps(
    nodeRow: NodeRow,
    dag: V3Node[],
  ): string[] {
    const dagNode = this.findDagNode(dag, nodeRow.nodeIdInDag);
    if (!dagNode) return [];

    const deps = (dagNode as { deps?: string[] }).deps;
    return Array.isArray(deps) ? deps : [];
  }
}

// ── Export error classification utilities for callers ────────────────────────

/**
 * Classify an error into V3 error class.
 * Used by the reconciler to determine cascade behavior.
 */
export function classifyNodeError(error: unknown): ErrorClass {
  return classifyErrorClass(error);
}

/**
 * Get the NodeRunner onFailure policy for a V3 error class.
 */
export function errorClassToOnFailurePolicy(errorClass: ErrorClass): NodeRuntimeSpec["onFailure"] {
  return errorClassToOnFailure(errorClass);
}
