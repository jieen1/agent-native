import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActionQuery, useActionMutation } from "@agent-native/core/client";
import type {
  ActivityResponse,
  Project,
  WorkItem,
  WorkItemDetail,
} from "@shared/types";

export function useProjects() {
  return useActionQuery("list-projects", {}) as {
    data?: Project[];
    isLoading: boolean;
  };
}

export function useWorkItems(projectId?: string) {
  // Poll on the board's ~4s cadence so status transitions driven by the
  // orchestrator slot gate (queued → running → done) surface without a reload.
  return useActionQuery(
    "list-work-items",
    projectId ? { projectId } : {},
    { refetchInterval: 4000 },
  ) as { data?: WorkItem[]; isLoading: boolean };
}

export function useWorkItem(id: string) {
  return useActionQuery("get-work-item", { id }, { enabled: !!id }) as {
    data?: WorkItemDetail;
    isLoading: boolean;
  };
}

export function useActivity(workItemId: string, enabled: boolean) {
  return useActionQuery(
    "get-activity",
    { workItemId },
    { enabled, refetchInterval: enabled ? 4000 : false },
  ) as { data?: ActivityResponse; isLoading: boolean };
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useActionMutation("create-project", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-projects"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "create-project", "Failed to create project"));
    },
  });
}

export function useCreateWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("create-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "create-work-item", "Failed to create work item"),
      );
    },
  });
}

export function useDispatch() {
  const qc = useQueryClient();
  return useActionMutation("dispatch-to-orchestrator", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "dispatch-to-orchestrator", "Dispatch failed"),
      );
    },
  });
}

// Bulk dispatch — fires one action that loops the admission gate over many
// items. Reports how many ran vs queued vs failed, then refreshes the board.
export function useBulkDispatch() {
  const qc = useQueryClient();
  return useActionMutation("bulk-dispatch-to-orchestrator", {
    onSuccess: (data: unknown) => {
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
      const d = data as
        | { dispatched?: number; failed?: number; requested?: number }
        | undefined;
      if (d && typeof d.dispatched === "number") {
        const failed = d.failed ?? 0;
        toast.success(
          `Dispatched ${d.dispatched}/${d.requested ?? d.dispatched} item(s)` +
            (failed ? ` · ${failed} failed` : ""),
        );
      }
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "bulk-dispatch-to-orchestrator", "Bulk dispatch failed"),
      );
    },
  });
}

// Poll get-activity for ONE in-flight item. Used on the board to drive each
// item's status writeback (queued → running → done) without opening it. The
// action itself writes the derived status back to the work item server-side;
// this just keeps the poll alive while the item is in flight.
export function useItemActivityPoll(workItemId: string, enabled: boolean) {
  return useActionQuery(
    "get-activity",
    { workItemId },
    { enabled, refetchInterval: enabled ? 4000 : false },
  ) as { data?: ActivityResponse };
}

function messageOf(err: unknown, action: string, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message.replace(new RegExp(`^Action ${action} failed:\\s*`), "");
  }
  return fallback;
}
