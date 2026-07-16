import type { ActivityResponse } from "@shared/types";

import { FailureEvidence, failingNodesOf } from "@/components/RunEvidenceList";
import { Skeleton } from "@/components/ui/skeleton";

export interface FailedRunEvidenceProps {
  activity: ActivityResponse | undefined;
  activityLoading: boolean;
}

/**
 * "最后错误 · 证据" block for the Inbox failed-routing card — matches
 * docs/sdlc-product-design/prototypes/s5-inbox.html (~549-553). Reuses the
 * SAME `FailureEvidence` filter/rendering the work-item detail page's
 * `RunEvidenceList` already uses (status ∈ {failed, cancelled} && error), fed
 * nodes flattened across every run `get-activity` returned for this item —
 * the Inbox card has no separate "历史运行" section, so any run's failing
 * node is in scope for "最后错误", not just the current (non-superseded) one.
 *
 * No retry-count / errorClass line: RunEvidenceList.tsx already established
 * (real investigation, not assumption) that no orchestrator read action
 * exposes a real retry counter or errorClass. Reusing that finding here
 * instead of fabricating the prototype's "分类 permanent/transient" line.
 *
 * Renders nothing while there is no failing node — never a fabricated card.
 */
export function FailedRunEvidence({
  activity,
  activityLoading,
}: FailedRunEvidenceProps) {
  if (activityLoading && !activity) {
    return (
      <Skeleton
        className="h-16 w-full"
        data-testid="failed-run-evidence-skeleton"
      />
    );
  }

  const nodes = (activity?.runs ?? []).flatMap((r) => r.nodes ?? []);
  if (failingNodesOf(nodes).length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted-foreground">
        最后错误 · 证据
      </div>
      <FailureEvidence nodes={nodes} />
    </div>
  );
}
