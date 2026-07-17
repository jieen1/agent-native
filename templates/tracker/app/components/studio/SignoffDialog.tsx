import type { Approval, GateKey, SprintArtifact } from "@shared/types";
import { GATE_KEY_LABELS } from "@shared/types";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  useApproveGate,
  useRejectGate,
  useRequestApproval,
} from "@/hooks/use-tracker";

/**
 * 3 signoff gate mini-banners, expanded into a dialog (§5.4): request /
 * approve / reject in place, stale-reconfirm read straight off `staleAt`
 * (create-sprint-artifact's existing B2 logic already sets it — nothing new
 * to compute here).
 */
export function SignoffDialog({
  open,
  onOpenChange,
  sprintId,
  gateKey,
  approval,
  anchorArtifact,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sprintId: string;
  gateKey: GateKey;
  approval: Approval | undefined;
  anchorArtifact: SprintArtifact | undefined;
}) {
  const [reason, setReason] = useState("");
  const requestApproval = useRequestApproval();
  const approveGate = useApproveGate();
  const rejectGate = useRejectGate();

  const isStale = !!approval?.staleAt;
  const isPending = approval?.status === "pending";
  const isApproved = approval?.status === "approved" && !isStale;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {GATE_KEY_LABELS[gateKey]}
            {isApproved ? (
              <Badge variant="secondary">已批</Badge>
            ) : isPending ? (
              <Badge variant="outline">待决</Badge>
            ) : approval?.status === "rejected" ? (
              <Badge variant="destructive">已驳回</Badge>
            ) : (
              <Badge variant="outline">未发起</Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {isStale ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
            锚定产物已出新版本，此签核已失效，需重新确认。
          </div>
        ) : null}

        {anchorArtifact ? (
          <p className="text-xs text-muted-foreground">
            锚定 {anchorArtifact.docKey} v{anchorArtifact.version}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            尚无可锚定的产物版本 — 先完成对应步骤。
          </p>
        )}

        {!approval || approval.status === "rejected" || isStale ? (
          <Button
            disabled={!anchorArtifact || requestApproval.isPending}
            onClick={() =>
              requestApproval.mutate(
                {
                  sprintId,
                  gateKey,
                  anchorArtifactId: anchorArtifact?.id,
                  anchorVersion: anchorArtifact?.version,
                },
                { onSuccess: () => onOpenChange(false) },
              )
            }
          >
            发起签核
          </Button>
        ) : isPending ? (
          <div className="flex flex-col gap-2">
            <Textarea
              placeholder="意见（驳回必填）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
            />
            <DialogFooter>
              <Button
                variant="outline"
                disabled={!reason.trim() || rejectGate.isPending}
                onClick={() =>
                  rejectGate.mutate(
                    { id: approval.id, reason },
                    { onSuccess: () => onOpenChange(false) },
                  )
                }
              >
                驳回
              </Button>
              <Button
                disabled={approveGate.isPending}
                onClick={() =>
                  approveGate.mutate(
                    { id: approval.id, reason: reason || undefined },
                    { onSuccess: () => onOpenChange(false) },
                  )
                }
              >
                批准
              </Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
