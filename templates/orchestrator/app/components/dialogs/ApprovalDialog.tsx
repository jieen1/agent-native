import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { IconCheck, IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useQueueControls } from "@/hooks/use-queue";

// Human-approval UI (FRONTEND §5 build item + DESIGN §3.1/§11). An
// awaiting-approval node surfaces here → resolve-human-gate(approve|reject).
export interface ApprovalTarget {
  runId: string;
  nodeRunId: string;
  nodeTitle: string;
}

export interface ApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ApprovalTarget | null;
}

export function ApprovalDialog({
  open,
  onOpenChange,
  target,
}: ApprovalDialogProps) {
  const { t } = useTranslation();
  const { resolveHumanGate } = useQueueControls();

  function resolve(decision: "approve" | "reject") {
    if (!target) return;
    resolveHumanGate.mutate(
      { runId: target.runId, nodeRunId: target.nodeRunId, decision },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(
            decision === "approve"
              ? t("approval.approved")
              : t("approval.rejected"),
          );
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("approval.title")}</DialogTitle>
          <DialogDescription>{t("approval.prompt")}</DialogDescription>
        </DialogHeader>
        {target ? (
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
            <span className="text-xs text-muted-foreground">
              {t("approval.node")}
            </span>
            <p className="mt-0.5 font-medium">{target.nodeTitle}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => resolve("reject")}
            disabled={resolveHumanGate.isPending}
          >
            {resolveHumanGate.isPending ? (
              <Spinner className="size-4" />
            ) : (
              <IconX className="size-4" />
            )}
            {t("approval.reject")}
          </Button>
          <Button
            onClick={() => resolve("approve")}
            disabled={resolveHumanGate.isPending}
          >
            {resolveHumanGate.isPending ? (
              <Spinner className="size-4" />
            ) : (
              <IconCheck className="size-4" />
            )}
            {t("approval.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
