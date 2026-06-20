import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// Node-library hooks (FRONTEND §7 / §11). The Library page reads list-node-defs;
// D7 writes via save-node-def; delete via delete-node-def. All through the
// action hooks (never raw fetch).

export interface NodeDef {
  id: string;
  key: string;
  kind: string;
  title: string;
  config: Record<string, unknown>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function useNodeDefs() {
  return useActionQuery("list-node-defs", {}) as {
    data?: NodeDef[];
    isLoading: boolean;
    error?: unknown;
  };
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-node-defs"] });
}

export function useSaveNodeDef() {
  const qc = useQueryClient();
  return useActionMutation("save-node-def", {
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteNodeDef() {
  const qc = useQueryClient();
  return useActionMutation("delete-node-def", {
    onSuccess: () => invalidate(qc),
  });
}

export function useSeedLibrary() {
  const qc = useQueryClient();
  return useActionMutation("seed-library", {
    onSuccess: () => {
      invalidate(qc);
      qc.invalidateQueries({ queryKey: ["action", "list-templates"] });
    },
  });
}
