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
import { IconFolderPlus } from "@tabler/icons-react";

/** Shape of `workspaceCreate`'s response (see actions/v3-workspace.ts). */
interface CreateWorkspaceResult {
  workspaceId: string;
  vmName: string | null;
  hostPath: string;
  state: string;
  repoUrl: string;
  branch: string;
}

export interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after a workspace is successfully provisioned. */
  onCreated?: (workspaceId: string) => void;
}

/**
 * "+ New workspace" modal — a real shadcn Dialog (not inline page content, per
 * design review). Calls `workspaceCreate` with { repo, branch }; the action
 * itself is host-native and synchronous (git clone into a volume dir), so the
 * only async wait is the network round trip, reflected via a disabled +
 * spinner-labeled submit button rather than a page-wide blocking spinner.
 */
export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
}: NewWorkspaceDialogProps) {
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");

  const createMutation = useActionMutation("workspaceCreate" as any, {});

  const resetAndClose = () => {
    setRepo("");
    setBranch("main");
    onOpenChange(false);
  };

  const handleSubmit = () => {
    if (!repo.trim()) return;
    createMutation.mutate(
      { repo: repo.trim(), branch: branch.trim() || undefined },
      {
        onSuccess: (result: CreateWorkspaceResult) => {
          toast.success(`工作区已创建（分支 ${result.branch}）`);
          onCreated?.(result.workspaceId);
          resetAndClose();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : "创建工作区失败");
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
          <DialogTitle>新建工作区</DialogTitle>
          <DialogDescription>
            克隆仓库并检出指定分支，为工作流派生准备计算环境。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="new-ws-repo">仓库地址</Label>
            <Input
              id="new-ws-repo"
              className="font-mono text-xs"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="git@github.com:acme/orchestrator-app.git"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-ws-branch">基础分支</Label>
            <Input
              id="new-ws-branch"
              className="font-mono text-xs"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={resetAndClose}
            disabled={createMutation.isPending}
          >
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={createMutation.isPending || !repo.trim()}
          >
            <IconFolderPlus className="mr-1 size-4" />
            {createMutation.isPending ? "创建中…" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
