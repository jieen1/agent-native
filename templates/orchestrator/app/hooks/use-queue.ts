import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";

// Queue / automation-overlay hooks (FRONTEND §2 ⋯-menu run controls + the
// topbar capacity indicator). These drive execState ONLY — never business
// status (that is transition-work-item). All via useActionQuery /
// useActionMutation.

export interface QueueStatus {
  concurrencyDegree: number;
  running: number;
  queued: number;
  claimed: number;
  maxConcurrentVMs: number;
  vmsInUse: number;
  schedulerAlive: boolean;
  lastTickAt: string | null;
  reapsFired: number;
}

const QUEUE_POLL_MS = 4000;

export function useQueueStatus() {
  return useActionQuery("queue-status", {}, {
    refetchInterval: QUEUE_POLL_MS,
  }) as { data?: QueueStatus; isLoading: boolean };
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["action", "list-work-items"] });
  qc.invalidateQueries({ queryKey: ["action", "queue-status"] });
  qc.invalidateQueries({ queryKey: ["action", "get-work-item"] });
}

/**
 * The work-item run/queue verbs (FRONTEND §2 table): enqueue/dequeue drive the
 * queue; runStart(workItemId) / runPause / runCancel drive an active run.
 * setConcurrency widens/narrows the worker pool. resolveHumanGate clears an
 * awaiting-approval node. Each invalidates the board + queue snapshot.
 */
export function useQueueControls() {
  const qc = useQueryClient();
  const enqueue = useActionMutation("enqueue-work-item", {
    onSuccess: () => invalidate(qc),
  });
  const dequeue = useActionMutation("dequeue-work-item", {
    onSuccess: () => invalidate(qc),
  });
  const runStart = useActionMutation("run-start", {
    onSuccess: () => invalidate(qc),
  });
  const runPause = useActionMutation("run-pause", {
    onSuccess: () => invalidate(qc),
  });
  const runCancel = useActionMutation("run-cancel", {
    onSuccess: () => invalidate(qc),
  });
  const setConcurrency = useActionMutation("set-concurrency", {
    onSuccess: () => invalidate(qc),
  });
  const resolveHumanGate = useActionMutation("resolve-human-gate", {
    onSuccess: () => invalidate(qc),
  });
  return {
    enqueue,
    dequeue,
    runStart,
    runPause,
    runCancel,
    setConcurrency,
    resolveHumanGate,
  };
}
