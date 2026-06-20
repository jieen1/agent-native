import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import type { WorkflowGraph } from "../../shared/types";

// Single v2 workflow-TEMPLATE hooks (FRONTEND §6 / §11). The DAG editor reads
// get-template (the parsed graph) and writes save-template / delete-template. All
// through the action hooks — never raw fetch. Distinct from use-templates.ts
// (the list) and the legacy v1 use-orchestrator workflow hooks.

export interface TemplateDetail {
  id: string;
  name: string;
  description: string;
  version: number;
  graph: WorkflowGraph;
  role: string;
}

export function useTemplate(id: string | undefined) {
  return useActionQuery("get-template", id ? { id } : { id: "" }, {
    enabled: !!id,
  }) as { data?: TemplateDetail; isLoading: boolean; error?: unknown };
}

function invalidateTemplates(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-templates"] });
  qc.invalidateQueries({ queryKey: ["action", "get-template"] });
}

export function useSaveTemplate() {
  const qc = useQueryClient();
  return useActionMutation("save-template", {
    onSuccess: () => invalidateTemplates(qc),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useActionMutation("delete-template", {
    onSuccess: () => invalidateTemplates(qc),
  });
}
