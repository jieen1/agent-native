import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconShieldCheck } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { useRunGraph } from "@/hooks/use-runs";
import type { WorkItem } from "@/hooks/use-work-items";
import {
  ApprovalDialog,
  type ApprovalTarget,
} from "@/components/dialogs/ApprovalDialog";

// Human-approval surfacing (FRONTEND §5 build item 5). For each RUNNING work item
// that has a bound run, scan its run-graph for an `awaiting-approval` node and
// surface an entry here; clicking opens the ApprovalDialog →
// resolve-human-gate. Each running run is scanned by its own child component so
// the hooks-rule (no hooks in a loop) holds even as the running set changes.
export interface ApprovalBannerProps {
  items: WorkItem[];
}

interface FoundApproval extends ApprovalTarget {
  workItemId: string;
}

export function ApprovalBanner({ items }: ApprovalBannerProps) {
  const { t } = useTranslation();
  const [found, setFound] = useState<Record<string, FoundApproval | null>>({});
  const [dialogTarget, setDialogTarget] = useState<ApprovalTarget | null>(null);

  const running = items.filter(
    (i) => i.execState === "running" && i.workflowRunId,
  );

  const report = useCallback(
    (workItemId: string, approval: FoundApproval | null) => {
      setFound((prev) => {
        if (prev[workItemId] === approval) return prev;
        // Compare by node id to avoid render loops on identical results.
        if (
          prev[workItemId]?.nodeRunId === approval?.nodeRunId &&
          prev[workItemId]?.runId === approval?.runId
        ) {
          return prev;
        }
        return { ...prev, [workItemId]: approval };
      });
    },
    [],
  );

  const entries = running
    .map((i) => found[i.id])
    .filter((a): a is FoundApproval => !!a);

  if (running.length === 0 && entries.length === 0) return null;

  return (
    <>
      {/* invisible scanners — one per running run */}
      {running.map((i) => (
        <RunApprovalScanner
          key={i.workflowRunId}
          workItemId={i.id}
          runId={i.workflowRunId!}
          onResult={report}
        />
      ))}

      {entries.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-orange-500/30 bg-orange-500/10 px-4 py-2.5 text-sm">
          <IconShieldCheck className="size-4 shrink-0 text-orange-600 dark:text-orange-400" />
          <span className="font-medium text-orange-700 dark:text-orange-300">
            {t("approval.awaiting")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {entries.map((a) => (
              <Button
                key={a.nodeRunId}
                size="sm"
                variant="outline"
                onClick={() =>
                  setDialogTarget({
                    runId: a.runId,
                    nodeRunId: a.nodeRunId,
                    nodeTitle: a.nodeTitle,
                  })
                }
              >
                {a.nodeTitle}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <ApprovalDialog
        open={!!dialogTarget}
        onOpenChange={(o) => !o && setDialogTarget(null)}
        target={dialogTarget}
      />
    </>
  );
}

// One scanner per running run: reads the live graph and reports the first
// awaiting-approval node (or null) up to the banner.
function RunApprovalScanner({
  workItemId,
  runId,
  onResult,
}: {
  workItemId: string;
  runId: string;
  onResult: (workItemId: string, approval: FoundApproval | null) => void;
}) {
  const { data: graph } = useRunGraph(runId);

  useEffect(() => {
    const node = graph?.nodeRuns.find(
      (n) => n.status === "awaiting-approval",
    );
    onResult(
      workItemId,
      node
        ? {
            workItemId,
            runId,
            nodeRunId: node.id,
            nodeTitle: node.title || node.nodeId,
          }
        : null,
    );
  }, [graph, workItemId, runId, onResult]);

  return null;
}
