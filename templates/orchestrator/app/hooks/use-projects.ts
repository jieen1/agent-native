import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import type { SchemeSet } from "../../shared/status-schemes";

// Project hooks (FRONTEND §3 / §11). All data flows through useActionQuery /
// useActionMutation — never raw fetch. `useDbSync` (mounted in root.tsx)
// invalidates these on any DB write, so lists stay live.

export interface ProjectListItem {
  id: string;
  name: string;
  key: string;
  description: string;
  workingDir: string;
  gitRemote: string | null;
  defaultBranch: string | null;
  defaultWorkflowId: string | null;
  hasRepo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail {
  id: string;
  name: string;
  key: string;
  description: string;
  workingDir: string;
  gitRemote: string | null;
  defaultBranch: string | null;
  defaultWorkflowId: string | null;
  environments: string[];
  /** Resolved per-type scheme set (project override merged onto defaults). */
  schemes: SchemeSet;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export function useProjects() {
  return useActionQuery("list-projects", {}) as {
    data?: ProjectListItem[];
    isLoading: boolean;
    error?: unknown;
  };
}

export interface ProjectSchemesEntry {
  id: string;
  key: string;
  environments: string[];
  schemes: SchemeSet;
}

/**
 * Every visible project's resolved scheme set in ONE call — the all-projects
 * board uses this to derive per-type columns without N get-project round-trips.
 */
export function useProjectSchemes() {
  return useActionQuery("list-project-schemes", {}) as {
    data?: ProjectSchemesEntry[];
    isLoading: boolean;
  };
}

export function useProject(id: string | undefined) {
  return useActionQuery("get-project", id ? { id } : { id: "" }, {
    enabled: !!id,
  }) as { data?: ProjectDetail; isLoading: boolean; error?: unknown };
}

function invalidateProjects(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-projects"] });
  qc.invalidateQueries({ queryKey: ["action", "get-project"] });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useActionMutation("create-project", {
    onSuccess: () => invalidateProjects(qc),
  });
}

export function useUpdateProject() {
  const qc = useQueryClient();
  return useActionMutation("update-project", {
    onSuccess: () => invalidateProjects(qc),
  });
}
