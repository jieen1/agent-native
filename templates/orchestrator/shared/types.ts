// Shared types for the Orchestrator app. Used by actions, server, and UI.

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export type StepRunStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

/** Where a workflow step runs its work. */
export type StepAssignee =
  // A sub-agent spawned inside this app's agent run.
  | "local"
  // Delegated to a sibling workspace app over A2A, e.g. "@brain", "@dispatch".
  | string;

/**
 * One node in a workflow DAG. `dependsOn` references other step `key`s and
 * defines the execution order; a step runs only after all its deps are `done`.
 */
export interface WorkflowStep {
  /** Stable, unique-within-workflow identifier (slug). */
  key: string;
  /** Human label. */
  title: string;
  /** "local" sub-agent or an "@app" A2A delegate. */
  assignee: StepAssignee;
  /**
   * Engine id for this step's sub-agent, e.g. "anthropic", "ai-sdk:openai",
   * "ai-sdk:ollama", "ai-sdk-harness:claude-code". Empty = orchestrator default.
   */
  engine?: string;
  /** Model id, e.g. "claude-opus-4-8", "gpt-5.5", "qwen2.5". */
  model?: string;
  /** Instruction template for the step's sub-agent. */
  prompt: string;
  /** Keys of steps that must finish before this one starts. */
  dependsOn: string[];
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  workflowId: string | null;
  /** Final delivered result (markdown). */
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StepRun {
  id: string;
  taskId: string;
  stepKey: string;
  title: string;
  assignee: StepAssignee;
  engine: string | null;
  model: string | null;
  status: StepRunStatus;
  /** Artifact / output summary produced by the sub-agent (markdown). */
  output: string | null;
  error: string | null;
  /** Background sub-agent run id, when one was spawned. */
  agentRunId: string | null;
  /** Position for stable display ordering. */
  ordering: number;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUSES: TaskStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "cancelled",
];

export const STEP_RUN_STATUSES: StepRunStatus[] = [
  "pending",
  "running",
  "done",
  "failed",
  "skipped",
];

/** Parse the JSON `steps` column into a typed array, tolerating bad data. */
export function parseSteps(raw: unknown): WorkflowStep[] {
  if (typeof raw !== "string")
    return Array.isArray(raw) ? (raw as WorkflowStep[]) : [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s) => s && typeof s === "object" && typeof s.key === "string")
      .map((s) => ({
        key: String(s.key),
        title: String(s.title ?? s.key),
        assignee: typeof s.assignee === "string" ? s.assignee : "local",
        engine: typeof s.engine === "string" ? s.engine : undefined,
        model: typeof s.model === "string" ? s.model : undefined,
        prompt: String(s.prompt ?? ""),
        dependsOn: Array.isArray(s.dependsOn)
          ? s.dependsOn.filter((d: unknown) => typeof d === "string")
          : [],
      }));
  } catch {
    return [];
  }
}

/**
 * Topologically sort workflow steps by their `dependsOn` edges (Kahn's
 * algorithm). Returns ordered steps. Throws on a dependency cycle so the
 * orchestrator never deadlocks on an unrunnable graph.
 */
export function topoSortSteps(steps: WorkflowStep[]): WorkflowStep[] {
  const byKey = new Map(steps.map((s) => [s.key, s]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    indegree.set(step.key, 0);
    dependents.set(step.key, []);
  }
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!byKey.has(dep)) continue; // ignore dangling deps
      indegree.set(step.key, (indegree.get(step.key) ?? 0) + 1);
      dependents.get(dep)!.push(step.key);
    }
  }

  const queue = steps
    .filter((s) => (indegree.get(s.key) ?? 0) === 0)
    .map((s) => s.key);
  const ordered: WorkflowStep[] = [];
  while (queue.length > 0) {
    const key = queue.shift()!;
    ordered.push(byKey.get(key)!);
    for (const next of dependents.get(key) ?? []) {
      const deg = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, deg);
      if (deg === 0) queue.push(next);
    }
  }

  if (ordered.length !== steps.length) {
    throw new Error(
      "Workflow has a dependency cycle; steps cannot be ordered. Fix dependsOn edges.",
    );
  }
  return ordered;
}

/** True when a workflow's DAG is valid (no cycles, deps resolve). */
export function validateWorkflowDag(steps: WorkflowStep[]): {
  ok: boolean;
  error?: string;
} {
  const keys = new Set(steps.map((s) => s.key));
  if (keys.size !== steps.length) {
    return { ok: false, error: "Duplicate step keys" };
  }
  try {
    topoSortSteps(steps);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Invalid DAG",
    };
  }
}

// ===========================================================================
// v2 GRAPH LAYER (DESIGN §3) — added alongside v1; v1 above is untouched.
//
// v1 (WorkflowStep / parseSteps / topoSortSteps / validateWorkflowDag) is the
// linear-DAG MVP and stays the source of truth for v1 runs. The v2 graph below
// is the richer engine: 11 node types, typed edges with conditions, and ONE
// shared validator (`validateGraph`) that both the client lint and the
// future `save-template` action call — no second validation pass anywhere.
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

  // ── agent / tool nodes ──────────────────────────────────────────────────
  /** "local" sub-agent or an "@app" A2A delegate. */
  assignee?: StepAssignee;
  /** Action id for `tool` nodes. */
  action?: string;
  /** Per-node engine routing, e.g. "anthropic", "ai-sdk:openai". */
  engine?: string;
  /** Per-node model id, e.g. "claude-opus-4-8". */
  model?: string;
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
 * bad data the same way `parseSteps` does (DESIGN §3.6 — JSON is the storage
 * and agent-editable format). Never throws; drops malformed nodes/edges.
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

// Re-export the single shared v2 graph validator so consumers importing from
// the central types module reach the SAME implementation that lives in
// `graph-validator.ts`. This is a re-export, not a second copy — there is one
// `validateGraph`, called by both the client lint and the save-template action.
export {
  validateGraph,
  type GraphValidationResult,
  type TemplateResolver,
} from "./graph-validator.js";

// ===========================================================================
// v2 PROJECT-MANAGEMENT LAYER (DESIGN §6 / §9) — P3a. Projects, work items
// (the six-dimension business status model), links, and the status-log row.
// The status SCHEMES + transition validator live in `status-schemes.ts`; these
// are the row shapes the DB tables and CRUD actions use.
// ===========================================================================

export type {
  StatusCategory,
  WorkItemType,
  Resolution,
  TransitionKind,
  StatusScheme,
  SchemeSet,
  StageDef,
  TransitionDef,
} from "./status-schemes.js";

/** The automation overlay state (DESIGN §6.2 / §6.4) — orthogonal to business status. */
export type ExecState =
  | "idle"
  | "queued"
  | "claimed"
  | "running"
  | "paused"
  | "failed"
  | "done";

export const EXEC_STATES: ExecState[] = [
  "idle",
  "queued",
  "claimed",
  "running",
  "paused",
  "failed",
  "done",
];

/** Severity (DESIGN §6.2a) — nullable, used mainly by prod-issue. */
export type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";

export const SEVERITIES: Severity[] = ["SEV1", "SEV2", "SEV3", "SEV4"];

/** Work-item link kinds (DESIGN §9 `work_item_links`). */
export type WorkItemLinkKind =
  | "duplicate-of"
  | "blocks"
  | "blocked-by"
  | "relates-to";

export const WORK_ITEM_LINK_KINDS: WorkItemLinkKind[] = [
  "duplicate-of",
  "blocks",
  "blocked-by",
  "relates-to",
];

/** A project's environment list default (DESIGN §6.2a). */
export const DEFAULT_ENVIRONMENTS: string[] = ["dev", "SIT", "UAT", "prod"];

/**
 * A project: a named container for work items with an id prefix (`key`) and a
 * `workingDir` deliverable root. It has NO "type"; a linked git repo
 * (`gitRemote`/`defaultBranch`) is the only thing distinguishing code work
 * (DESIGN §6.1). `statusSchemes`/`environments` are JSON overrides.
 */
export interface Project {
  id: string;
  name: string;
  key: string;
  description: string;
  workingDir: string;
  gitRemote: string | null;
  defaultBranch: string | null;
  defaultWorkflowId: string | null;
  /** JSON SchemeSet override; null/empty → the default schemes apply. */
  statusSchemes: import("./status-schemes.js").SchemeSet | null;
  environments: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A work item — the requirement/bug/incident/task you create and assign. The
 * six business-status dimensions (§6.2a) are written ONLY by
 * `transition-work-item`; the automation overlay (execState/claimed_*) is the
 * queue's. `status_category` is derived from `status` via the scheme.
 */
export interface WorkItem {
  id: string;
  projectId: string;
  type: import("./status-schemes.js").WorkItemType;
  title: string;
  description: string;
  priority: number;
  assignee: string | null;
  // ── business status (six dimensions, §6.2a/§6.2b) ──
  status: string;
  statusCategory: import("./status-schemes.js").StatusCategory;
  environment: string | null;
  severity: Severity | null;
  blocked: boolean;
  blockedReason: string | null;
  blockedBy: string | null;
  resolution: import("./status-schemes.js").Resolution | null;
  statusStale: boolean;
  // ── automation overlay (§6.4) ──
  execState: ExecState;
  claimedAt: string | null;
  claimedBy: string | null;
  workflowId: string | null;
  workflowRunId: string | null;
  deliverable: { kind: string; ref: unknown } | null;
  createdAt: string;
  updatedAt: string;
}

/** A directed link between two work items (DESIGN §9 `work_item_links`). */
export interface WorkItemLink {
  id: string;
  fromItem: string;
  toItem: string;
  kind: WorkItemLinkKind;
  createdBy: string;
  createdAt: string;
}

/** One append-only transition trail row (DESIGN §9 `work_item_status_log`). */
export interface WorkItemStatusLogEntry {
  id: string;
  workItemId: string;
  runId: string | null;
  actor: string;
  fromStatus: string | null;
  toStatus: string;
  blocked: boolean;
  resolution: string | null;
  at: string;
}

/** A reusable node-library entry (DESIGN §3.7 / §9 `node_defs`). */
export interface NodeDef {
  id: string;
  key: string;
  kind: string;
  title: string;
  config: unknown;
  version: number;
  createdAt: string;
  updatedAt: string;
}
