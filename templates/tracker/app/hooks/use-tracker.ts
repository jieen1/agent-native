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
  return useActionQuery("list-work-items", projectId ? { projectId } : {}, {
    refetchInterval: 4000,
  }) as { data?: WorkItem[]; isLoading: boolean };
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

// Sprint hooks.
export function useSprints() {
  return useActionQuery("list-sprints", {}) as {
    data?: any;
    isLoading: boolean;
  };
}

export function useSprint(id: string) {
  return useActionQuery("get-sprint", { id }, { enabled: !!id }) as {
    data?: any;
    isLoading: boolean;
  };
}

export function useCreateSprint() {
  const qc = useQueryClient();
  return useActionMutation("create-sprint", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-sprints"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "create-sprint", "Failed to create sprint"));
    },
  });
}

export function useUpdateSprint() {
  const qc = useQueryClient();
  return useActionMutation("update-sprint", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-sprints"] });
      qc.invalidateQueries({ queryKey: ["action", "get-sprint"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "update-sprint", "Failed to update sprint"));
    },
  });
}

// Stage hooks.
export function useStages(workItemId: string) {
  return useActionQuery(
    "list-stages",
    { workItemId },
    { enabled: !!workItemId },
  ) as { data?: any; isLoading: boolean };
}

export function useTriggerStage() {
  const qc = useQueryClient();
  return useActionMutation("trigger-stage", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-stages"] });
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "trigger-stage", "Failed to trigger stage"));
    },
  });
}

export function useRollbackStage() {
  const qc = useQueryClient();
  return useActionMutation("rollback-stage", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-stages"] });
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "rollback-stage", "Failed to rollback stage"));
    },
  });
}

// Artifact hooks.
export function useArtifacts(workItemId: string) {
  return useActionQuery(
    "list-artifacts",
    { workItemId },
    { enabled: !!workItemId },
  ) as { data?: any; isLoading: boolean };
}

export function useCreateArtifact() {
  const qc = useQueryClient();
  return useActionMutation("create-artifact", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-artifacts"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "create-artifact", "Failed to create artifact"),
      );
    },
  });
}

// Tracker activity hooks.
export function useTrackerActivities(workItemId: string, enabled: boolean) {
  return useActionQuery(
    "list-tracker-activities",
    { workItemId },
    { enabled, refetchInterval: enabled ? 4000 : false },
  ) as { data?: any; isLoading: boolean };
}

// Comment hooks.
export function useAddComment() {
  const qc = useQueryClient();
  return useActionMutation("add-comment", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-comments"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "add-comment", "Failed to add comment"));
    },
  });
}

export function useComments(workItemId: string) {
  return useActionQuery(
    "list-comments",
    { workItemId },
    { enabled: !!workItemId },
  ) as { data?: any; isLoading: boolean };
}

// Queue hooks.
export function useQueue() {
  return useActionQuery("list-queue", {}, { refetchInterval: 3000 }) as {
    data?: any;
    isLoading: boolean;
  };
}

export function useEnqueueWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("enqueue-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-queue"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "enqueue-work-item", "Failed to enqueue work item"),
      );
    },
  });
}

export function useDequeueWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("dequeue-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-queue"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "dequeue-work-item", "Failed to dequeue work item"),
      );
    },
  });
}

// Link hooks.
export function useLinks(workItemId: string) {
  return useActionQuery(
    "list-links",
    { workItemId },
    { enabled: !!workItemId },
  ) as { data?: any; isLoading: boolean };
}

export function useAddLink() {
  const qc = useQueryClient();
  return useActionMutation("add-link", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-links"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "add-link", "Failed to add link"));
    },
  });
}

// Work item update hook.
export function useUpdateWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("update-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "update-work-item", "Failed to update work item"),
      );
    },
  });
}

// Delete work item hook.
export function useDeleteWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("delete-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(
        messageOf(err, "delete-work-item", "Failed to delete work item"),
      );
    },
  });
}

// Update project hook.
export function useUpdateProject() {
  const qc = useQueryClient();
  return useActionMutation("update-project", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-projects"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "update-project", "Failed to update project"));
    },
  });
}
