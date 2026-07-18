import { useActionMutation } from "@agent-native/core/client";
import {
  IconCircleCheck,
  IconCircleX,
  IconGitMerge,
  IconLoader2,
} from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  useMergeReviewGate,
  useV3WorkspaceCi,
  type V3RunStatus,
} from "@/hooks/use-v3-run";
import { cn } from "@/lib/utils";

import { MergeReviewGate } from "./MergeReviewGate";

export interface RunMergeControlProps {
  workspaceId: string | null;
  prUrl: string | null;
  runStatus: V3RunStatus;
  /** The run whose diff the independent review (task board #95) should
   *  cover — used to pull the original spec/goal for review context when a
   *  human starts one. */
  runId: string;
}

interface MergePrActionResult {
  workspaceId: string;
  merged: boolean;
  reason?: string;
  sha?: string | null;
  prUrl?: string | null;
}

interface LastMergeResult {
  /** Positive tone (merged now, or already merged) vs. a real failure. */
  ok: boolean;
  message: string;
  sha?: string | null;
}

const CI_TONE: Record<string, string> = {
  green: "bg-success/15 text-success border-success/30",
  red: "bg-destructive/15 text-destructive border-destructive/30",
  pending: "bg-warning/15 text-warning border-warning/30",
  none: "bg-muted text-muted-foreground border-border",
};

const CI_LABEL: Record<string, string> = {
  green: "CI 通过",
  red: "CI 失败",
  pending: "CI 运行中",
  none: "无 CI",
};

const PR_STATE_LABEL: Record<string, string> = {
  OPEN: "PR 开放中",
  MERGED: "已合并",
  CLOSED: "已关闭未合并",
};

const PR_STATE_TONE: Record<string, string> = {
  OPEN: "bg-info/15 text-info border-info/30",
  MERGED: "bg-success/15 text-success border-success/30",
  CLOSED: "bg-muted text-muted-foreground border-border",
};

/**
 * Real "merge to main" control (04-orchestrator.md gap: `workspaceMergePr`
 * existed with zero frontend call sites — brain-only). Calls the same action
 * a human would need SSH+`gh` for. `workspaceMergePr` itself re-asserts PR
 * open + CI green + no conflicts server-side right before merging and never
 * force-merges — this control's disabled/CI state is a UX nicety only, the
 * safety check lives server-side and is authoritative.
 */
export function RunMergeControl({
  workspaceId,
  prUrl,
  runStatus,
  runId,
}: RunMergeControlProps) {
  const [lastResult, setLastResult] = useState<LastMergeResult | null>(null);
  const { data: ci } = useV3WorkspaceCi(workspaceId);
  const { data: reviewGate } = useMergeReviewGate(workspaceId);
  const mergeMutation = useActionMutation("workspaceMergePr" as any, {});

  // Nothing to merge yet — no workspace, or no PR opened.
  if (!workspaceId || !prUrl) return null;

  const prState = ci?.prState ?? null;
  const alreadyMerged = prState === "MERGED";
  const prClosed = prState === "CLOSED";
  const ciRed = ci?.state === "red";
  const isDone = runStatus === "done";
  // Task board #95 — mandatory independent-review gate. Fails CLOSED: an
  // unloaded/absent gate result blocks merge the same as an explicit
  // "blocked" verdict, never defaults to "allowed" while unknown.
  const reviewBlocks = !reviewGate || !reviewGate.canMerge;

  const disabledReason = !isDone
    ? "运行尚未完成，暂不能合并"
    : alreadyMerged
      ? "此 PR 已合并"
      : prClosed
        ? "此 PR 已关闭，未合并"
        : ciRed
          ? "CI 未通过，无法合并"
          : reviewBlocks
            ? (reviewGate?.reason ?? "正在加载独立复核状态…")
            : null;

  function handleMerge() {
    mergeMutation.mutate(
      { workspaceId },
      {
        onSuccess: (result: unknown) => {
          const r = result as MergePrActionResult;
          if (r.merged) {
            // Raw Chinese strings below match this page's existing convention
            // — RunHeaderActions.tsx in the same directory is not i18n'd either.
            setLastResult({
              ok: true,
              message: "已合并到 main", // i18n-ignore see above
              sha: r.sha,
            });
            toast.success("已合并到 main"); // i18n-ignore see above
            return;
          }
          const reason = r.reason ?? "未知原因";
          const isAlreadyMerged = /'MERGED'/.test(reason);
          if (isAlreadyMerged) {
            setLastResult({ ok: true, message: "此 PR 已经合并过了" }); // i18n-ignore see above
            toast.info("此 PR 已经合并过了"); // i18n-ignore see above
            return;
          }
          setLastResult({ ok: false, message: reason });
          toast.error(`合并失败：${reason}`);
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "合并失败";
          setLastResult({ ok: false, message });
          toast.error(message);
        },
      },
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        {ci ? (
          <Badge
            variant="outline"
            className={cn(
              "h-6 gap-1 px-1.5 text-xs font-normal",
              CI_TONE[ci.state],
            )}
            title={ci.summary}
          >
            {ci.state === "pending" ? (
              <IconLoader2 className="size-3 animate-spin" />
            ) : ci.state === "red" ? (
              <IconCircleX className="size-3" />
            ) : (
              <IconCircleCheck className="size-3" />
            )}
            {CI_LABEL[ci.state] ?? ci.state}
          </Badge>
        ) : null}
        {prState ? (
          <Badge
            variant="outline"
            className={cn(
              "h-6 gap-1 px-1.5 text-xs font-normal",
              PR_STATE_TONE[prState] ?? PR_STATE_TONE.CLOSED,
            )}
          >
            {PR_STATE_LABEL[prState] ?? prState}
          </Badge>
        ) : null}

        <MergeReviewGate
          workspaceId={workspaceId}
          runId={runId}
          gate={reviewGate}
        />

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={!!disabledReason || mergeMutation.isPending}
              title={disabledReason ?? undefined}
            >
              <IconGitMerge className="size-3.5" />
              {mergeMutation.isPending ? "合并中…" : "合并到 main"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {
                  "合并这个 PR 到 main？" /* i18n-ignore matches this page's existing raw-Chinese convention */
                }
              </AlertDialogTitle>
              <AlertDialogDescription>
                {
                  "这会真实调用 gh pr merge 把工作区分支合入 main 分支。合并前会再次确认 PR 为 open、CI 全绿、且分支相对 base 无冲突、不落后——任一条件不满足会安全失败并返回原因，不会强制合并。" /* i18n-ignore see above */
                }
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>再想想</AlertDialogCancel>
              <AlertDialogAction onClick={handleMerge}>
                确认合并
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {lastResult ? (
        <Alert
          variant={lastResult.ok ? "default" : "destructive"}
          className="w-72 py-2"
        >
          <AlertDescription className="text-xs">
            {lastResult.message}
            {lastResult.sha ? (
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {lastResult.sha.slice(0, 7)}
              </span>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
