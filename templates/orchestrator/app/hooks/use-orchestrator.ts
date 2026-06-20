import {
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import type { StepRun, Task, Workflow } from "../../shared/types";

export interface TaskListItem {
  id: string;
  title: string;
  description: string;
  status: Task["status"];
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowListItem {
  id: string;
  name: string;
  description: string;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail {
  task: Task;
  workflow: Workflow | null;
  stepRuns: StepRun[];
  role: string;
}

export function useTasks(status?: Task["status"]) {
  return useActionQuery(
    "list-tasks",
    status ? { status } : {},
  ) as { data?: TaskListItem[]; isLoading: boolean; error?: unknown };
}

export function useTask(id: string | undefined) {
  return useActionQuery(
    "get-task",
    id ? { id } : { id: "" },
    { enabled: !!id },
  ) as { data?: TaskDetail; isLoading: boolean; error?: unknown };
}

export function useWorkflows() {
  return useActionQuery("list-workflows", {}) as {
    data?: WorkflowListItem[];
    isLoading: boolean;
  };
}

export function useWorkflow(id: string | undefined) {
  return useActionQuery(
    "get-workflow",
    id ? { id } : { id: "" },
    { enabled: !!id },
  ) as { data?: { workflow: Workflow; role: string }; isLoading: boolean };
}

function invalidateTasks(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-tasks"] });
  qc.invalidateQueries({ queryKey: ["action", "get-task"] });
}

export function useCreateTask() {
  const qc = useQueryClient();
  return useActionMutation("create-task", {
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useUpdateTask() {
  const qc = useQueryClient();
  return useActionMutation("update-task", {
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useDeleteTask() {
  const qc = useQueryClient();
  return useActionMutation("delete-task", {
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useRunOrchestrator() {
  const qc = useQueryClient();
  return useActionMutation("run-orchestrator", {
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useStopTask() {
  const qc = useQueryClient();
  return useActionMutation("stop-task", {
    onSuccess: () => invalidateTasks(qc),
  });
}

export function useSaveWorkflow() {
  const qc = useQueryClient();
  return useActionMutation("save-workflow", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-workflows"] });
      qc.invalidateQueries({ queryKey: ["action", "get-workflow"] });
    },
  });
}

export function useDeleteWorkflow() {
  const qc = useQueryClient();
  return useActionMutation("delete-workflow", {
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["action", "list-workflows"] }),
  });
}

// ── Runtime (vLLM / Claude Code) ──────────────────────────────────────────

export interface RuntimeConfigItem {
  id: string;
  name: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
  active: boolean;
}

export interface RuntimeStatus {
  chatEngine: string | null;
  chatModel: string | null;
  chatBaseUrl: string | null;
  executionRuntime: string;
  claudeCodeInstalled: boolean;
  claudeCodeLoggedIn?: boolean;
  claudeCodeExpired?: boolean;
  claudeCodeExpiresAt?: string | null;
  claudeCodeSubscription?: string | null;
  claudeCodeCredentialsFound?: boolean;
}

export function useRuntimeConfigs() {
  return useActionQuery("list-runtime-configs", {}) as {
    data?: RuntimeConfigItem[];
    isLoading: boolean;
  };
}

export function useRuntimeStatus() {
  return useActionQuery("get-runtime-status", {}) as {
    data?: RuntimeStatus;
    isLoading: boolean;
    isFetching: boolean;
    refetch: () => void;
  };
}

function invalidateRuntime(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-runtime-configs"] });
  qc.invalidateQueries({ queryKey: ["action", "get-runtime-status"] });
}

export function useSaveRuntimeConfig() {
  const qc = useQueryClient();
  return useActionMutation("save-runtime-config", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useActivateRuntime() {
  const qc = useQueryClient();
  return useActionMutation("activate-runtime", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useDeleteRuntimeConfig() {
  const qc = useQueryClient();
  return useActionMutation("delete-runtime-config", {
    onSuccess: () => invalidateRuntime(qc),
  });
}

export function useStartClaudeCode() {
  return useActionMutation("start-claude-code", {});
}
