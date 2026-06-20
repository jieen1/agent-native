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
  if (typeof raw !== "string") return Array.isArray(raw) ? (raw as WorkflowStep[]) : [];
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

  const queue = steps.filter((s) => (indegree.get(s.key) ?? 0) === 0).map((s) => s.key);
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
    return { ok: false, error: err instanceof Error ? err.message : "Invalid DAG" };
  }
}
