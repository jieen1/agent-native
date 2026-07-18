// Shared types for the Orchestrator app. Used by actions, server, and UI.

/** Where a workflow node's work is assigned. */
export type StepAssignee =
  // A sub-agent spawned inside this app's agent run.
  | "local"
  // Delegated to a sibling workspace app over A2A, e.g. "@brain", "@dispatch".
  | string;

// ===========================================================================
// GRAPH LAYER (DESIGN §3) — the workflow-template graph model: 11 node types,
// typed edges with conditions, and the shared validator (`validateGraph`) used
// by the client lint. This is the type surface the V3 runtime (executors,
// node-runner, dispatcher) builds on.
// ===========================================================================

/**
 * Every node type the engine supports (DESIGN §3.1). All 11 are first-class —
 * §0.6 mandates the full set; `human` and `subworkflow` are NOT dropped.
 */
export type NodeType =
  | "start"
  | "agent"
  | "tool"
  | "parallel"
  | "fanout"
  | "join"
  | "branch"
  | "loop"
  | "subworkflow"
  | "human"
  | "end";

export const NODE_TYPES: NodeType[] = [
  "start",
  "agent",
  "tool",
  "parallel",
  "fanout",
  "join",
  "branch",
  "loop",
  "subworkflow",
  "human",
  "end",
];

/** Reasoning-effort hint for agent nodes (DESIGN §1.6). */
export type NodeEffort = "low" | "medium" | "high";

/**
 * A small, safe condition evaluated against run state — never `eval`
 * (DESIGN §3.5). Used on `branch` out-edges and as a `loop` stop predicate.
 */
export type Condition =
  | { kind: "jsonpath"; path: string; op: string; value: unknown }
  | { kind: "status"; node: string; equals: string }
  | { kind: "agent"; prompt: string };

/** A directed edge in the base graph (DESIGN §3.3). `when` gates a branch. */
export interface Edge {
  id: string;
  from: string;
  to: string;
  /** Present only on conditional (branch) edges; absent = unconditional. */
  when?: Condition;
}

/**
 * Per-node virtual environment (DESIGN §7.4.3). STRUCTURAL PLACEHOLDER only:
 * P2 (the NodeRunner) consumes this; nothing in this file gives it behavior.
 * Carried on the node so a template fully describes where each node runs.
 */
export interface NodeRuntimeSpec {
  /** microvm = MicrosandboxRuntime (default for tool/code/agent); none = pure reasoning. */
  kind: "microvm" | "none";
  /** OCI image; default is the prebaked node+pnpm+git+claude image (§7.4.7). */
  image?: string;
  /** Branch/commit to fork; default = project.defaultBranch. */
  baseRef?: string;
  /** Working branch; default = an/run-<runId>, shared across a run's nodes. */
  branch?: string;
  /**
   * Git remote (https URL) to CLONE into the VM and PUSH the run branch to.
   * Injected per-run from the bound project's `gitRemote` by the engine
   * (DESIGN §7.1a); a template node may also set it explicitly. When set, INIT
   * clones the repo and EXTRACT delivers (commit + push branch + open PR).
   */
  gitRemote?: string;
  /**
   * Shared host checkout this node operates in DIRECTLY (no copy). When set, the
   * node's `/work` worktree IS this host directory (a git checkout): the agent's
   * Read/Edit/Write/Bash tools edit the REAL files and changes persist for
   * downstream nodes (e.g. a later CC review/commit node sees them). Set per-run
   * by the engine for nodes that must share one workspace. Only the `none`
   * runtime honors it (it runs on the host and symlinks `/work` → this dir);
   * teardown removes the node's scoped temp root but NEVER this directory.
   */
  hostDir?: string;
  /** Extra folders to attach (read-only by default). */
  mounts?: { host: string; path: string; mode?: "ro" | "rw" }[];
  /** Secret keys → injected as scoped VM env via resolveSecret; never baked in. */
  creds?: string[];
  /** Extra VM env. */
  env?: Record<string, string>;
  /** Init commands run once after checkout (e.g. ["pnpm install"]). */
  setup?: string[];
  /** Per-VM resource caps (concurrency budget, §7.4.7). */
  resources?: { cpus?: number; memMB?: number; diskMB?: number };
  /** Recovery policy on failure (§7.4.5). */
  onFailure: "rollback" | "recreate" | "keep";
  /** Cleanup policy on success; default destroy. */
  onSuccess?: "destroy" | "snapshot" | "keep";
}

/**
 * One node in a v2 workflow graph (DESIGN §3.4). Most fields are optional and
 * only meaningful for a subset of `type`s; the validator enforces the
 * per-type requirements (e.g. fanout needs `itemsFrom`, loop needs
 * `condition` + `maxIterations`).
 */
export interface Node {
  id: string;
  type: NodeType;
  title: string;

  // ── library reference (DESIGN §3.7) ─────────────────────────────────────
  /**
   * When this node is dropped from the node library, the library entry's `key`.
   * The node inherits the library config (overridable per-use). The library
   * (`node_defs`) is referenced FROM a graph by this field, and delete-node-def
   * blocks a delete when any saved template's graph references the key.
   */
  nodeDefKey?: string;

  // ── agent / tool nodes ──────────────────────────────────────────────────
  /** "local" sub-agent or an "@app" A2A delegate. */
  assignee?: StepAssignee;
  /** Action id for `tool` nodes. */
  action?: string;
  /** Per-node engine routing, e.g. "anthropic", "ai-sdk:openai". */
  engine?: string;
  /** Per-node model id, e.g. "claude-opus-4-8". */
  model?: string;
  /**
   * Task #89: the DAG node's EXPLICIT `model_override`, carried separately
   * from `model`. `v3-dispatcher.ts` flattens `model` to
   * `model_override ?? agentConfig.model` before a node ever reaches a
   * `RuntimeExecutor`, so `model` alone cannot tell "the DAG author picked
   * this on purpose" apart from "this is just the agent-def's static
   * default" (e.g. `vllm`'s seeded `qwen3.6`). `RoutingRuntimeExecutor` /
   * `VllmExecutor.resolveModel` need that distinction: an explicit override
   * must win even when the node is routed to a `runtime_configs` row, but a
   * row's own configured model should win over the agent-def default when
   * there is NO explicit override. Unset when the DAG node has no
   * `model_override`.
   */
  modelOverride?: string;
  /** Reasoning-effort hint (§1.6). */
  effort?: NodeEffort;
  /** Instruction template; supports {{deps.<id>.output}} refs. */
  prompt?: string;
  /** Force a validated structured output (JSON Schema, §1.6). */
  outputSchema?: unknown;

  // ── container nodes (parallel / loop / subworkflow body) ────────────────
  children?: string[];

  // ── fanout ──────────────────────────────────────────────────────────────
  /** Node id whose array output drives the fan-out width N. */
  itemsFrom?: string;
  /** Per-fanout concurrency cap. */
  maxConcurrency?: number;

  // ── loop ─────────────────────────────────────────────────────────────────
  /** Stop predicate (also serves loop-until-condition). */
  condition?: Condition;
  /** Hard upper bound on iterations (required for `loop`). */
  maxIterations?: number;
  /** JSONPath identifying each item, for loop-until-dry dedupe. */
  dedupeKey?: string;
  /** Stop after this many consecutive rounds adding nothing new. */
  dryRounds?: number;

  // ── subworkflow ──────────────────────────────────────────────────────────
  /** Template id/key this node embeds. */
  templateRef?: string;

  // ── execution ────────────────────────────────────────────────────────────
  /** false = fire-and-forget, joined later. */
  await?: boolean;
  /** Retry policy. */
  retry?: { max: number; backoffMs: number };
  /** Hard timeout in ms. */
  timeoutMs?: number;
  /** Per-node virtual env (P2 consumes it; structural here). */
  runtime?: NodeRuntimeSpec;
}

/** A v2 workflow template's authored graph: nodes + edges (DESIGN §3.6). */
export interface WorkflowGraph {
  nodes: Node[];
  edges: Edge[];
}

const NODE_TYPE_SET = new Set<string>(NODE_TYPES);

/** Coerce unknown into a Condition, or undefined if it isn't one. */
function parseCondition(raw: unknown): Condition | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (
    c.kind === "jsonpath" &&
    typeof c.path === "string" &&
    typeof c.op === "string"
  ) {
    return { kind: "jsonpath", path: c.path, op: c.op, value: c.value };
  }
  if (
    c.kind === "status" &&
    typeof c.node === "string" &&
    typeof c.equals === "string"
  ) {
    return { kind: "status", node: c.node, equals: c.equals };
  }
  if (c.kind === "agent" && typeof c.prompt === "string") {
    return { kind: "agent", prompt: c.prompt };
  }
  return undefined;
}

/** Coerce unknown into a NodeRuntimeSpec, or undefined. Structural only. */
function parseRuntime(raw: unknown): NodeRuntimeSpec | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "none" ? "none" : "microvm";
  const onFailure =
    r.onFailure === "recreate" || r.onFailure === "keep"
      ? r.onFailure
      : "rollback";
  const spec: NodeRuntimeSpec = { kind, onFailure };
  if (typeof r.image === "string") spec.image = r.image;
  if (typeof r.baseRef === "string") spec.baseRef = r.baseRef;
  if (typeof r.branch === "string") spec.branch = r.branch;
  if (typeof r.gitRemote === "string") spec.gitRemote = r.gitRemote;
  if (typeof r.hostDir === "string") spec.hostDir = r.hostDir;
  if (Array.isArray(r.creds)) {
    spec.creds = r.creds.filter((x): x is string => typeof x === "string");
  }
  if (
    r.onSuccess === "destroy" ||
    r.onSuccess === "snapshot" ||
    r.onSuccess === "keep"
  ) {
    spec.onSuccess = r.onSuccess;
  }
  // env / mounts / setup / resources are passed through structurally if present.
  if (r.env && typeof r.env === "object") {
    spec.env = r.env as Record<string, string>;
  }
  if (Array.isArray(r.mounts)) {
    spec.mounts = r.mounts as NodeRuntimeSpec["mounts"];
  }
  if (Array.isArray(r.setup)) {
    spec.setup = r.setup.filter((x): x is string => typeof x === "string");
  }
  if (r.resources && typeof r.resources === "object") {
    spec.resources = r.resources as NodeRuntimeSpec["resources"];
  }
  return spec;
}

function parseNode(raw: unknown): Node | null {
  if (!raw || typeof raw !== "object") return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== "string") return null;
  const type: NodeType = NODE_TYPE_SET.has(n.type as string)
    ? (n.type as NodeType)
    : "agent";

  const node: Node = {
    id: n.id,
    type,
    title: typeof n.title === "string" ? n.title : n.id,
  };

  if (typeof n.nodeDefKey === "string") node.nodeDefKey = n.nodeDefKey;
  if (typeof n.assignee === "string") node.assignee = n.assignee;
  if (typeof n.action === "string") node.action = n.action;
  if (typeof n.engine === "string") node.engine = n.engine;
  if (typeof n.model === "string") node.model = n.model;
  if (n.effort === "low" || n.effort === "medium" || n.effort === "high") {
    node.effort = n.effort;
  }
  if (typeof n.prompt === "string") node.prompt = n.prompt;
  if (n.outputSchema !== undefined) node.outputSchema = n.outputSchema;

  if (Array.isArray(n.children)) {
    node.children = n.children.filter(
      (x): x is string => typeof x === "string",
    );
  }
  if (typeof n.itemsFrom === "string") node.itemsFrom = n.itemsFrom;
  if (typeof n.maxConcurrency === "number")
    node.maxConcurrency = n.maxConcurrency;

  const cond = parseCondition(n.condition);
  if (cond) node.condition = cond;
  if (typeof n.maxIterations === "number") node.maxIterations = n.maxIterations;
  if (typeof n.dedupeKey === "string") node.dedupeKey = n.dedupeKey;
  if (typeof n.dryRounds === "number") node.dryRounds = n.dryRounds;

  if (typeof n.templateRef === "string") node.templateRef = n.templateRef;

  if (typeof n.await === "boolean") node.await = n.await;
  if (
    n.retry &&
    typeof n.retry === "object" &&
    typeof (n.retry as Record<string, unknown>).max === "number"
  ) {
    const r = n.retry as Record<string, unknown>;
    node.retry = {
      max: r.max as number,
      backoffMs: typeof r.backoffMs === "number" ? r.backoffMs : 0,
    };
  }
  if (typeof n.timeoutMs === "number") node.timeoutMs = n.timeoutMs;
  const runtime = parseRuntime(n.runtime);
  if (runtime) node.runtime = runtime;

  return node;
}

function parseEdge(raw: unknown, index: number): Edge | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.from !== "string" || typeof e.to !== "string") return null;
  const edge: Edge = {
    id: typeof e.id === "string" ? e.id : `e${index}-${e.from}-${e.to}`,
    from: e.from,
    to: e.to,
  };
  const when = parseCondition(e.when);
  if (when) edge.when = when;
  return edge;
}

/**
 * Parse a stored/agent-supplied graph into a typed WorkflowGraph, tolerating
 * bad data (DESIGN §3.6 — JSON is the storage and agent-editable format).
 * Never throws; drops malformed nodes/edges.
 */
export function parseGraph(raw: unknown): WorkflowGraph {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { nodes: [], edges: [] };
    }
  }
  if (!value || typeof value !== "object") return { nodes: [], edges: [] };
  const obj = value as Record<string, unknown>;

  const nodes = Array.isArray(obj.nodes)
    ? obj.nodes.map(parseNode).filter((n): n is Node => n !== null)
    : [];
  const edges = Array.isArray(obj.edges)
    ? obj.edges
        .map((e, i) => parseEdge(e, i))
        .filter((e): e is Edge => e !== null)
    : [];

  return { nodes, edges };
}
