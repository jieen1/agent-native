import { useActionMutation } from "@agent-native/core/client";
import {
  IconAlertTriangle,
  IconLoader2,
  IconShieldCheck,
  IconShieldOff,
  IconShieldSearch,
  IconShieldX,
  IconUserCheck,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { V3MergeReviewGateResult } from "@/hooks/use-v3-run";
import { cn } from "@/lib/utils";

export interface MergeReviewGateProps {
  workspaceId: string;
  runId: string;
  gate: V3MergeReviewGateResult | undefined;
}

const REVIEW_IN_FLIGHT = new Set(["pending", "running", "paused"]);

/**
 * Task board #95 — mandatory independent-review gate. Renders the badge +
 * detail dialog for the SEPARATE `sdlc-merge-review` dispatch (own
 * `agent:"claude-code"` pass, not a re-read of the dev/review DAG's own
 * verdict) and the human-override affordance. RunMergeControl reads the SAME
 * `mergeReviewGet` result (passed in as `gate`) to decide whether its own
 * merge button is enabled — this component only renders the review's own UI,
 * it doesn't own the merge button.
 */
export function MergeReviewGate({
  workspaceId,
  runId,
  gate,
}: MergeReviewGateProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const startMutation = useActionMutation("mergeReviewStart" as any, {});
  const overrideMutation = useActionMutation("mergeReviewOverride" as any, {});

  const review = gate?.review ?? null;
  const inFlight = review ? REVIEW_IN_FLIGHT.has(review.status) : false;
  const isOverridden = gate?.source === "human-override";
  const isPassed = gate?.source === "review-passed";

  function handleStart() {
    startMutation.mutate(
      { workspaceId, runId },
      {
        onSuccess: () => toast.info("已发起独立复核"), // i18n-ignore matches this page's raw-Chinese convention
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "发起独立复核失败"),
      },
    );
  }

  function handleOverride() {
    const trimmed = reason.trim();
    if (!trimmed) return;
    overrideMutation.mutate(
      { workspaceId, reason: trimmed },
      {
        onSuccess: () => {
          toast.success("已记录人工确认，可以合并");
          setReason("");
          setOpen(false);
        },
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "记录确认失败"),
      },
    );
  }

  let icon = IconShieldOff;
  let tone = "bg-muted text-muted-foreground border-border";
  let label = "未独立复核";

  if (!review) {
    icon = IconShieldOff;
    tone = "bg-warning/15 text-warning border-warning/30";
    label = "未独立复核";
  } else if (inFlight) {
    icon = IconLoader2;
    tone = "bg-info/15 text-info border-info/30";
    label = "复核进行中";
  } else if (review.status === "failed" || review.status === "cancelled") {
    icon = IconShieldX;
    tone = "bg-destructive/15 text-destructive border-destructive/30";
    label = review.status === "failed" ? "复核未完成" : "复核已取消";
  } else if (isPassed) {
    icon = IconShieldCheck;
    tone = "bg-success/15 text-success border-success/30";
    label = "复核通过";
  } else if (isOverridden) {
    icon = IconUserCheck;
    tone = "bg-info/15 text-info border-info/30";
    label = "已人工确认合并";
  } else {
    icon = IconAlertTriangle;
    tone = "bg-warning/15 text-warning border-warning/30";
    label = "发现问题";
  }
  const Icon = icon;

  const canShowDialog = !!review;
  const showOverrideForm =
    !!review && !inFlight && gate != null && !gate.canMerge;

  const badge = (
    <Badge
      variant="outline"
      className={cn("h-6 gap-1 px-1.5 text-xs font-normal", tone)}
      title={gate?.reason}
    >
      <Icon className={cn("size-3", inFlight && "animate-spin")} />
      {label}
    </Badge>
  );

  return (
    <div className="flex items-center gap-1.5">
      <Dialog open={open} onOpenChange={setOpen}>
        {canShowDialog ? (
          <DialogTrigger asChild>
            <button type="button" className="cursor-pointer">
              {badge}
            </button>
          </DialogTrigger>
        ) : (
          badge
        )}
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>独立复核</DialogTitle>
            <DialogDescription>
              一次与开发/评审节点分开派发的独立对抗式复核——重新拉取真实 diff
              并给出合并前的最终意见。
            </DialogDescription>
          </DialogHeader>

          {!review ? (
            <p className="text-sm text-muted-foreground">尚未运行独立复核。</p>
          ) : inFlight ? (
            <p className="text-sm text-muted-foreground">
              复核进行中，正在重新拉取 diff 并审查……
            </p>
          ) : review.status === "failed" || review.status === "cancelled" ? (
            <p className="text-sm text-destructive">
              {review.error ?? "复核运行未能完成。"}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "gap-1 text-xs",
                    review.verdict === "safe_to_merge"
                      ? "bg-success/15 text-success border-success/30"
                      : "bg-warning/15 text-warning border-warning/30",
                  )}
                >
                  {review.verdict === "safe_to_merge"
                    ? "safe_to_merge"
                    : "concerns_found"}
                </Badge>
              </div>
              {review.summary ? (
                <p className="text-sm">{review.summary}</p>
              ) : null}
              {review.findings && review.findings.length > 0 ? (
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  {review.findings.map((f, i) => (
                    <li key={i}>
                      {typeof f === "string" ? f : JSON.stringify(f)}
                    </li>
                  ))}
                </ul>
              ) : review.verdict === "concerns_found" ? (
                <p className="text-sm text-muted-foreground">
                  未提供具体问题清单。
                </p>
              ) : null}
            </div>
          )}

          {isOverridden && gate?.override ? (
            <div className="rounded-md border border-info/30 bg-info/10 p-2 text-sm">
              已由 {gate.override.overriddenBy ?? "人工"} 确认合并：
              {gate.override.reason}
            </div>
          ) : showOverrideForm ? (
            <div className="space-y-2">
              <Textarea
                placeholder="说明确认合并的理由（必填）"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={!reason.trim() || overrideMutation.isPending}
                onClick={handleOverride}
              >
                人工确认：仍然合并
              </Button>
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              variant="outline"
              size="sm"
              disabled={inFlight || startMutation.isPending}
              onClick={handleStart}
            >
              <IconShieldSearch className="size-3.5" />
              {review ? "重新运行独立复核" : "运行独立复核"}
            </Button>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                关闭
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {!review ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={startMutation.isPending}
          onClick={handleStart}
        >
          <IconShieldSearch className="size-3.5" />
          {startMutation.isPending ? "发起中…" : "运行独立复核"}
        </Button>
      ) : null}
    </div>
  );
}
