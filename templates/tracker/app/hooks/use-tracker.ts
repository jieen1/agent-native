import { useActionQuery, useActionMutation } from "@agent-native/core/client";
import type {
  ActivityResponse,
  Project,
  QueueHealthStatus,
  QueueItem,
  QueueStats,
  WorkItem,
  WorkItemDetail,
} from "@shared/types";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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

export function useOrgMembers() {
  return useActionQuery("list-org-members", {}) as {
    data?: { members: { email: string; role: string }[] };
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

// Goal metrics (S6 驾驶舱 Goal 卡) — deterministic parse of the sprint's
// latest sprint-doc artifact's "## Success Metrics" section
// (actions/extract-goal-metrics.ts). No separate stored field: the artifact
// IS the source of truth, so a sprint that never wrote that section
// correctly renders an honest empty state rather than fabricated metrics.
// The action throws when no sprint-doc artifact exists at all — surfaced to
// the caller as a query error, not swallowed, so the UI can render its own
// "尚未创建 sprint-doc" empty state instead of a silent blank.
export function useGoalMetrics(sprintId: string) {
  return useActionQuery(
    "extract-goal-metrics",
    { sprintId },
    { enabled: !!sprintId, retry: false },
  ) as {
    data?: import("@shared/types").ExtractedGoalMetrics;
    isLoading: boolean;
    error: unknown;
  };
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

export function useAdvanceStage() {
  const qc = useQueryClient();
  return useActionMutation("advance-stage", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-stages"] });
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "advance-stage", "Failed to advance stage"));
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
    data?: { items: QueueItem[]; stats: QueueStats };
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

// Queue scheduler pause/resume — real, persisted (server/lib/scheduler-gate.ts).
export function usePauseScheduler() {
  const qc = useQueryClient();
  return useActionMutation("pause-scheduler", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-queue-health"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "pause-scheduler", "暂停调度器失败"));
    },
  }) as {
    mutate: (
      vars: Record<string, never>,
      options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => void;
    isPending: boolean;
  };
}

export function useResumeScheduler() {
  const qc = useQueryClient();
  return useActionMutation("resume-scheduler", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-queue-health"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "resume-scheduler", "恢复调度器失败"));
    },
  }) as {
    mutate: (
      vars: Record<string, never>,
      options?: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => void;
    isPending: boolean;
  };
}

// Real cross-app health-gate status (orchestrator get-runtime-status +
// brain-queue-status over MCP) — see actions/get-queue-health.ts.
export function useQueueHealth() {
  return useActionQuery("get-queue-health", {}, { refetchInterval: 5000 }) as {
    data?: QueueHealthStatus;
    isLoading: boolean;
  };
}

// Persist manual drag/pin order for the queue's dispatchable rows.
export function useReorderQueue() {
  const qc = useQueryClient();
  return useActionMutation("reorder-queue", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-queue"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "reorder-queue", "保存排序失败"));
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

// F3: guarded human transition/close channel (transition-work-item).
// PESSIMISTIC refetch semantics (no optimistic cache write): only after the
// server confirms does this invalidate get-work-item (status/
// currentStageName/allowedTransitions all change) + list-work-items (board
// reflects the new state) + the activity feed (transition.* rows) — a
// guarded mutation can be rejected on actor/evidence/CAS grounds, so we
// never show a state the guard may refuse. Errors are NOT toasted here —
// the GuardedTransitionDialog needs the raw error's `.code`/`.need` to
// red-outline the missing evidence field and keep the dialog open with the
// user's input intact (S4 契约), so it handles its own onError per-call.
export function useTransitionWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("transition-work-item", {
    onSuccess: (_data: unknown, variables: unknown) => {
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
      qc.invalidateQueries({ queryKey: ["action", "list-tracker-activities"] });
      const workItemId = (variables as { id?: string } | undefined)?.id;
      if (workItemId) {
        qc.invalidateQueries({
          queryKey: ["action", "get-activity", { workItemId }],
        });
      }
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

// Sprint artifact hooks (M1-2).
export function useSprintArtifacts(sprintId: string) {
  return useActionQuery(
    "list-sprint-artifacts",
    { sprintId },
    { enabled: !!sprintId },
  ) as {
    data?: import("@shared/types").SprintArtifactsByDocKey;
    isLoading: boolean;
  };
}

export function useSprintArtifact(id: string) {
  return useActionQuery("get-sprint-artifact", { id }, { enabled: !!id }) as {
    data?: import("@shared/types").SprintArtifact;
    isLoading: boolean;
  };
}

export function useCreateSprintArtifact() {
  const qc = useQueryClient();
  return useActionMutation("create-sprint-artifact", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-sprint-artifacts"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "create-sprint-artifact", "创建产物失败"));
    },
  });
}

// Approval hooks (M1-3).
export function useApprovals(
  params: {
    sprintId?: string;
    status?: "pending" | "approved" | "rejected";
  } = {},
) {
  return useActionQuery("list-approvals", params, {
    refetchInterval: 5000,
  }) as { data?: import("@shared/types").Approval[]; isLoading: boolean };
}

export function useRequestApproval() {
  const qc = useQueryClient();
  return useActionMutation("request-approval", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-approvals"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "request-approval", "发起审批失败"));
    },
  });
}

export function useApproveGate() {
  const qc = useQueryClient();
  return useActionMutation("approve-gate", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-approvals"] });
      toast.success("已批准");
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "approve-gate", "批准失败"));
    },
  });
}

export function useRejectGate() {
  const qc = useQueryClient();
  return useActionMutation("reject-gate", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-approvals"] });
      toast.success("已拒绝");
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "reject-gate", "拒绝失败"));
    },
  });
}

// Inbox hooks (R3). See server/lib/inbox.ts for which groups are backed by
// real data (notifications is currently always empty).
export function useInboxItems() {
  return useActionQuery("list-inbox", {}, { refetchInterval: 5000 }) as {
    data?: import("@shared/types").InboxResult;
    isLoading: boolean;
  };
}

// Review checklist hooks (F6 gate criteria — S5 门判据 panel).
export function useReviewChecklist(workItemId: string | undefined) {
  return useActionQuery(
    "get-review-checklist",
    { workItemId: workItemId ?? "" },
    { enabled: !!workItemId },
  ) as {
    data?: import("@shared/types").ReviewChecklistResult;
    isLoading: boolean;
  };
}

export function useSetArtifactReview() {
  const qc = useQueryClient();
  return useActionMutation("set-artifact-review", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-review-checklist"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "set-artifact-review", "更新核对项失败"));
    },
  });
}

// Document hooks (M1-7).
export function useDocuments(workItemId: string) {
  return useActionQuery(
    "list-work-item-documents",
    { workItemId },
    { enabled: !!workItemId },
  ) as { data?: any; isLoading: boolean };
}

export function useAddDocument() {
  const qc = useQueryClient();
  return useActionMutation("add-work-item-document", {
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["action", "list-work-item-documents"],
      });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "add-work-item-document", "添加文档失败"));
    },
  });
}

export function useDeleteDocument() {
  const qc = useQueryClient();
  return useActionMutation("delete-work-item-document", {
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["action", "list-work-item-documents"],
      });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "delete-work-item-document", "删除文档失败"));
    },
  });
}

// Epic decomposition hooks (M1-4).
export function useEpicChildren(epicId: string) {
  return useActionQuery(
    "list-epic-children",
    { epicId },
    { enabled: !!epicId },
  ) as {
    data?: import("@shared/types").EpicChildrenResult;
    isLoading: boolean;
  };
}

export function useDecomposeEpic() {
  const qc = useQueryClient();
  return useActionMutation("decompose-epic", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-epic-children"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
      qc.invalidateQueries({ queryKey: ["action", "list-tracker-activities"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "decompose-epic", "拆解失败"));
    },
  });
}

// Dependency-graph validation (M1-5). On-demand: only fetches while a scope
// (epic/project or sprint) + id is set and the caller enables it (e.g. while
// the validation dialog is open).
export function useValidateDependencyGraph(
  scope: "epic" | "sprint" | undefined,
  id: string | undefined,
  enabled: boolean,
) {
  return useActionQuery(
    "validate-dependency-graph",
    { scope: scope ?? "epic", id: id ?? "" },
    { enabled: enabled && !!scope && !!id },
  ) as {
    data?: import("@shared/types").GraphValidationResult;
    isLoading: boolean;
    error: unknown;
  };
}

// ── F5: 任务拆分阈值(规划前置契约,02 §3.10) ────────────────────────────────

// Estimate a work item's implementation scale from its description text and
// persist scale_estimate. PESSIMISTIC (no optimistic write) — the badge/
// warning-bar should only flip once the server confirms the estimate.
export function useEstimateBriefScale() {
  const qc = useQueryClient();
  return useActionMutation("estimate-brief-scale", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "estimate-brief-scale", "规模估算失败"));
    },
  });
}

// Split an over-scale work item into children. Errors are NOT toasted here —
// the split dialog needs the raw error's `.code` (e.g. already-dispatched) to
// show an inline red banner and keep the dialog open with the user's rows
// intact (S2 契约: "失败(already-dispatched)红条提示不关框").
export function useSplitWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("split-work-item", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
      qc.invalidateQueries({ queryKey: ["action", "list-tracker-activities"] });
    },
  });
}

// ── R4b.2 Sprint Studio (/sprints/:id/studio) ───────────────────────────────

export function useArtifactReviews(
  params:
    | { artifactId: string; version?: number }
    | { sprintId: string; docKey: string },
  enabled = true,
) {
  return useActionQuery("list-artifact-reviews", params as any, {
    enabled,
  }) as {
    data?: {
      artifactId: string | null;
      version: number | null;
      reviews: Array<{
        id: string;
        reviewKey: string;
        checked: number;
        reviewer: string;
        createdAt: string;
        updatedAt: string;
      }>;
    };
    isLoading: boolean;
  };
}

export function useCheckArtifactGates(
  sprintId: string | undefined,
  docKey: string | undefined,
) {
  return useActionQuery(
    "check-artifact-gates",
    { sprintId: sprintId ?? "", docKey: docKey ?? "" },
    { enabled: !!sprintId && !!docKey },
  ) as {
    data?: {
      sprintId: string;
      docKey: string;
      artifactId: string | null;
      version: number | null;
      items: Array<{
        key: string;
        label: string;
        source: "machine" | "human";
        state: "pass" | "fail" | "needs-human";
        detail?: string;
      }>;
      complete: boolean;
      note?: string;
    };
    isLoading: boolean;
  };
}

// extract-briefs is a mutating (POST) action but idempotent per docKey
// (content-hash skip) — the Briefs step calls it both for the initial view
// and for the explicit "重新提取"/"强制提取" buttons, never silently on an
// unrelated render.
export function useExtractBriefs() {
  const qc = useQueryClient();
  return useActionMutation("extract-briefs", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-sprint-artifacts"] });
      qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
    },
    // Not toasted: design-signoff-required is an expected, recoverable state
    // the Briefs view should render inline (force button), not a red toast.
  });
}
