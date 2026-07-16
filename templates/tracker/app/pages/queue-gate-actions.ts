import type { QueueItem } from "@shared/types";

// `QueueItem.id` is the exec_queue row id; `workItemId` is the underlying
// work item's id. Backend actions (enqueue-work-item / dequeue-work-item)
// key off workItemId, so any UI handler working off a QueueItem.id must
// resolve the real workItemId before calling them.
export function resolveWorkItemId(
  items: QueueItem[],
  queueRowId: string,
): string {
  return items.find((it) => it.id === queueRowId)?.workItemId ?? queueRowId;
}

export interface RunQueueGateActionArgs {
  id: string;
  items: QueueItem[];
  mutateAsync: (vars: { workItemId: string }) => Promise<unknown>;
  hide: (id: string) => void;
  unhide: (id: string) => void;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
}

// Optimistically hides a human-gate queue row, calls the real backing
// action, and rolls the hide back if the action fails so the row reappears
// for the user to retry. onError must be supplied so the reappearing row
// reads as "this failed", not as "nothing happened".
export async function runQueueGateAction({
  id,
  items,
  mutateAsync,
  hide,
  unhide,
  onSuccess,
  onError,
}: RunQueueGateActionArgs): Promise<void> {
  const workItemId = resolveWorkItemId(items, id);
  hide(id);
  try {
    await mutateAsync({ workItemId });
    onSuccess?.();
  } catch (error) {
    unhide(id);
    onError?.(error);
  }
}
