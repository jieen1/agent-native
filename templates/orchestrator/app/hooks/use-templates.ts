import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// v2 workflow-template hooks (FRONTEND §5 / §11). The board's D1 workflow picker
// and the promote flow (D9) read/write here. All via the action hooks.

export interface TemplateListItem {
  id: string;
  name: string;
  description: string;
  version: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
}

export function useTemplates() {
  return useActionQuery("list-templates", {}) as {
    data?: TemplateListItem[];
    isLoading: boolean;
    error?: unknown;
  };
}

export function usePromoteRun() {
  const qc = useQueryClient();
  return useActionMutation("promote-run-to-template", {
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["action", "list-templates"] }),
  });
}
