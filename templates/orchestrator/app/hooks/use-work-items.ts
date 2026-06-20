import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// Work-item hooks (FRONTEND §2 / §11) — the board's read + write surface. Every
// call goes through useActionQuery / useActionMutation (never raw fetch);
// `useDbSync` (root.tsx) keeps the board live on any DB write. The TRANSITION
// mutation is optimistic with rollback (FRONTEND §2 "drag = business status").

export type StatusCategory = "todo" | "in-progress" | "completed" | "cancelled";
export type ExecState =
  | "idle"
  | "queued"
  | "claimed"
  | "running"
  | "paused"
  | "failed"
  | "done";
export type WorkItemType = "requirement" | "bug" | "prod-issue" | "task";

export interface Deliverable {
  kind: string;
  ref: unknown;
}

export interface WorkItem {
  id: string;
  projectId: string;
  type: WorkItemType;
  title: string;
  priority: number;
  assignee: string | null;
  status: string;
  statusCategory: StatusCategory;
  environment: string | null;
  severity: string | null;
  blocked: boolean;
  blockedReason: string | null;
  blockedBy: string | null;
  resolution: string | null;
  statusStale: boolean;
  execState: ExecState;
  workflowId: string | null;
  workflowRunId: string | null;
  deliverable: Deliverable | null;
  updatedAt: string;
}

export interface ListWorkItemsArgs {
  projectId?: string;
  type?: WorkItemType;
  statusCategory?: StatusCategory;
  execState?: ExecState;
}

/** The query key the board reads — exported so optimistic writers can target it. */
export function workItemsKey(args: ListWorkItemsArgs = {}) {
  return ["action", "list-work-items", args] as const;
}

export function useWorkItems(args: ListWorkItemsArgs = {}) {
  return useActionQuery("list-work-items", args) as {
    data?: WorkItem[];
    isLoading: boolean;
    error?: unknown;
  };
}

export interface WorkItemStatusLogRow {
  id: string;
  runId: string | null;
  actor: string;
  fromStatus: string | null;
  toStatus: string;
  blocked: boolean;
  resolution: string | null;
  at: string;
}

export interface WorkItemLink {
  id: string;
  direction: "from" | "to";
  kind: string;
  otherItem: string;
}

export interface WorkItemDetail extends WorkItem {
  description: string;
  role: string;
  createdAt: string;
  statusLog: WorkItemStatusLogRow[];
  links: WorkItemLink[];
}

export function useWorkItem(id: string | undefined) {
  return useActionQuery("get-work-item", id ? { id } : { id: "" }, {
    enabled: !!id,
  }) as { data?: WorkItemDetail; isLoading: boolean };
}

function invalidateWorkItems(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
  qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
  qc.invalidateQueries({ queryKey: ["action", "queue-status"] });
}

export function useCreateWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("create-work-item", {
    onSuccess: () => invalidateWorkItems(qc),
  });
}

export function useUpdateWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("update-work-item", {
    onSuccess: () => invalidateWorkItems(qc),
  });
}

export function useDeleteWorkItem() {
  const qc = useQueryClient();
  return useActionMutation("delete-work-item", {
    onSuccess: () => invalidateWorkItems(qc),
  });
}

export interface TransitionVars {
  id: string;
  toStatus: string;
  /** The new category, supplied by the board so the optimistic move is instant. */
  optimisticCategory?: StatusCategory;
  resolution?: string;
  environment?: string | null;
  blocked?: boolean;
  blockedReason?: string | null;
  blockedBy?: string | null;
  severity?: string | null;
}

interface OptimisticContext {
  /** Snapshots of every list-work-items cache entry, for rollback. */
  snapshots: Array<[readonly unknown[], WorkItem[] | undefined]>;
}

/**
 * transition-work-item with optimistic move + rollback (FRONTEND §2). On a board
 * drag we patch every cached list immediately (the card jumps columns), then the
 * server validates from→to against the scheme; an illegal drop throws and we roll
 * back (the card snaps to its column) and the caller toasts the error.
 */
export function useTransitionWorkItem() {
  const qc = useQueryClient();
  return useActionMutation<unknown, TransitionVars>("transition-work-item", {
    onMutate: async (vars): Promise<OptimisticContext> => {
      await qc.cancelQueries({ queryKey: ["action", "list-work-items"] });
      const entries = qc.getQueriesData<WorkItem[]>({
        queryKey: ["action", "list-work-items"],
      });
      const snapshots: OptimisticContext["snapshots"] = entries.map(
        ([key, data]) => [key, data],
      );
      for (const [key, data] of entries) {
        if (!data) continue;
        qc.setQueryData<WorkItem[]>(
          key,
          data.map((item) =>
            item.id === vars.id
              ? {
                  ...item,
                  status: vars.toStatus,
                  statusCategory:
                    vars.optimisticCategory ?? item.statusCategory,
                  ...(vars.blocked !== undefined
                    ? {
                        blocked: vars.blocked,
                        blockedReason:
                          vars.blockedReason ?? item.blockedReason,
                      }
                    : {}),
                }
              : item,
          ),
        );
      }
      return { snapshots };
    },
    onError: (_err, _vars, context) => {
      const ctx = context as OptimisticContext | undefined;
      if (!ctx) return;
      for (const [key, data] of ctx.snapshots) {
        qc.setQueryData(key, data);
      }
    },
    onSettled: () => invalidateWorkItems(qc),
  });
}
