import { useState } from "react";
import { useActionMutation } from "@agent-native/core/client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { IconGitCommit, IconUpload } from "@tabler/icons-react";

export interface WorkspaceCommitTarget {
  workspaceId: string;
  branch: string | null;
}

/** Shape of `workspaceCommit`'s response (see actions/workspaceCommit.ts). */
interface CommitAndPushResult {
  committed: boolean;
  sha: string | null;
  pushed: boolean;
  branch: string;
  prUrl?: string;
}

export interface WorkspaceCommitDialogProps {
  /** The workspace being acted on, or null when the dialog is closed. */
  target: WorkspaceCommitTarget | null;
  /** "commit" pushes the branch only; "commitPush" also opens a PR. */
  mode: "commit" | "commitPush";
  onOpenChange: (open: boolean) => void;
}

/**
 * Shared "Commit" / "Commit + Push" modal for a single workspace row.
 *
 * Both modes call the SAME action — `workspaceCommit` (actions/workspaceCommit.ts)
 * — because it is the only one of the two real commit-capable actions that
 * exposes `createMr` / `prTitle` / `prBody` / `baseBranch`. The other real
 * action, `workspaceCommitPush` (actions/workspaceCommitPush.ts, re-exporting
 * v3-workspace.ts's implementation), only accepts { workspaceId, message,
 * pushBranch } — no PR fields — and for host-native workspaces it hardcodes
 * createMr:true internally, so it cannot express a plain "commit + push, no
 * PR" call. `workspaceCommit` covers both UI actions cleanly via `createMr`:
 * false for "Commit", true (with the extra PR fields) for "Commit + Push".
 *
 * Both modes commit AND push under the hood (the underlying `commitAndPush`
 * helper always pushes once a token is available — there is no push-less
 * commit primitive in this codebase); `createMr` only controls whether a PR
 * is additionally opened.
 */
export function WorkspaceCommitDialog({
  target,
  mode,
  onOpenChange,
}: WorkspaceCommitDialogProps) {
  const [message, setMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [baseBranch, setBaseBranch] = useState("");

  const commitMutation = useActionMutation("workspaceCommit" as any, {});

  const open = target !== null;
  const isPush = mode === "commitPush";

  const resetAndClose = () => {
    setMessage("");
    setPrTitle("");
    setPrBody("");
    setBaseBranch("");
    onOpenChange(false);
  };

  const handleSubmit = () => {
    if (!target || !message.trim()) return;
    commitMutation.mutate(
      {
        workspaceId: target.workspaceId,
        message: message.trim(),
        createMr: isPush,
        ...(isPush && prTitle.trim() ? { prTitle: prTitle.trim() } : {}),
        ...(isPush && prBody.trim() ? { prBody: prBody.trim() } : {}),
        ...(isPush && baseBranch.trim()
          ? { baseBranch: baseBranch.trim() }
          : {}),
      },
      {
        onSuccess: (result: CommitAndPushResult) => {
          if (!result.committed) {
            toast.info(
              result.pushed
                ? "没有新更改可提交；已推送现有提交"
                : "没有可提交的更改",
            );
          } else if (isPush) {
            toast.success(
              result.prUrl
                ? `已提交并推送到 ${result.branch}，PR 已创建`
                : `已提交并推送到 ${result.branch}`,
            );
          } else {
            toast.success(`已提交并推送到 ${result.branch}`);
          }
          resetAndClose();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : "提交失败");
        },
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetAndClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isPush ? (
              <IconUpload className="size-4" />
            ) : (
              <IconGitCommit className="size-4" />
            )}
            {isPush ? "提交并推送" : "提交更改"}
          </DialogTitle>
          <DialogDescription>
            {isPush
              ? "提交工作区中的所有更改，推送分支，并打开合并请求。"
              : "提交工作区中的所有更改并推送分支。"}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="commit-message">提交信息</Label>
            <Textarea
              id="commit-message"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="描述这次更改…"
              autoFocus
            />
          </div>
          {isPush ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="commit-pr-title">PR 标题（可选）</Label>
                <Input
                  id="commit-pr-title"
                  value={prTitle}
                  onChange={(e) => setPrTitle(e.target.value)}
                  placeholder="默认使用提交信息首行"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="commit-pr-body">PR 描述（可选）</Label>
                <Textarea
                  id="commit-pr-body"
                  rows={2}
                  value={prBody}
                  onChange={(e) => setPrBody(e.target.value)}
                  placeholder="默认使用提交信息"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="commit-base-branch">基础分支（可选）</Label>
                <Input
                  id="commit-base-branch"
                  className="font-mono text-xs"
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder={
                    target?.branch ? `默认: ${target.branch}` : "main"
                  }
                />
              </div>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={resetAndClose}
            disabled={commitMutation.isPending}
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={commitMutation.isPending || !message.trim()}
          >
            {commitMutation.isPending
              ? isPush
                ? "提交并推送中…"
                : "提交中…"
              : isPush
                ? "提交并推送"
                : "提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
