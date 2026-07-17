import { useActionMutation } from "@agent-native/core/client";
import {
  IconEdit,
  IconGitFork,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { V3DagNode, V3Node, V3RunState } from "@/hooks/use-v3-run";

interface WorkflowPatchResult {
  ok: boolean;
  error?: string;
}
interface RunForkResult {
  runId: string;
  ok: boolean;
}

const FORK_FRESH = "__fork-fresh__";

export interface RunHeaderActionsProps {
  runId: string;
  runState: V3RunState;
  dagNodes: V3DagNode[];
  nodes: V3Node[];
}

/**
 * Header action row (04-orchestrator.md §3): 暂停/恢复 · 取消 · Fork · Patch.
 * All four wire to backend actions that already existed
 * (runPause/runResume/runCancel/runFork/workflowPatch) — this is the frontend
 * wiring the acceptance review flagged as missing.
 */
export function RunHeaderActions({
  runId,
  runState,
  dagNodes,
  nodes,
}: RunHeaderActionsProps) {
  const navigate = useNavigate();
  const pauseMutation = useActionMutation("runPause" as any, {});
  const resumeMutation = useActionMutation("runResume" as any, {});
  const cancelMutation = useActionMutation("runCancel" as any, {});
  const forkMutation = useActionMutation("runFork" as any, {});
  const patchMutation = useActionMutation("workflowPatch" as any, {});

  const [forkOpen, setForkOpen] = useState(false);
  const [forkFromNode, setForkFromNode] = useState<string>(FORK_FRESH);

  const [patchOpen, setPatchOpen] = useState(false);
  const [patchNodeId, setPatchNodeId] = useState("");
  const [patchPrompt, setPatchPrompt] = useState("");
  const [patchModel, setPatchModel] = useState("");

  const isTerminal = ["done", "failed", "cancelled"].includes(runState.status);
  const isPaused = runState.status === "paused";

  // Patch (§8.6) only admits agent nodes not yet at/behind the execution
  // frontier — mirrors v3-patcher.ts's IMMUTABLE_STATUSES (running/done/
  // failed are rejected server-side; a node with no runtime row yet is
  // pending by definition).
  const patchableNodes = useMemo(() => {
    const byDag = new Map<string, V3Node[]>();
    for (const n of nodes) {
      if (!byDag.has(n.nodeIdInDag)) byDag.set(n.nodeIdInDag, []);
      byDag.get(n.nodeIdInDag)!.push(n);
    }
    return dagNodes.filter((d) => {
      if (d.type !== "agent") return false;
      const rows = byDag.get(d.id) ?? [];
      if (rows.length === 0) return true;
      return rows.every((r) => r.status === "pending" || r.status === "ready");
    });
  }, [dagNodes, nodes]);

  function handlePauseResume() {
    if (isPaused) {
      resumeMutation.mutate(
        { runId },
        {
          onSuccess: () => toast.success("已恢复运行"),
          onError: (err: unknown) =>
            toast.error(err instanceof Error ? err.message : "恢复失败"),
        },
      );
    } else {
      pauseMutation.mutate(
        { runId },
        {
          onSuccess: () => toast.success("已暂停运行"),
          onError: (err: unknown) =>
            toast.error(err instanceof Error ? err.message : "暂停失败"),
        },
      );
    }
  }

  function handleCancel() {
    cancelMutation.mutate(
      { runId },
      {
        onSuccess: () => toast.success("已取消运行"),
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "取消失败"),
      },
    );
  }

  function handleFork() {
    forkMutation.mutate(
      {
        runId,
        ...(forkFromNode !== FORK_FRESH ? { fromNode: forkFromNode } : {}),
      },
      {
        onSuccess: (result: unknown) => {
          toast.success("已 Fork 新运行");
          setForkOpen(false);
          const newRunId = (result as RunForkResult | undefined)?.runId;
          if (newRunId) navigate(`/runs/${newRunId}`);
        },
        onError: (err: unknown) =>
          toast.error(err instanceof Error ? err.message : "Fork 失败"),
      },
    );
  }

  async function handlePatchSubmit() {
    if (!patchNodeId) {
      toast.error("请选择要修改的节点");
      return;
    }
    const set: Record<string, string> = {};
    if (patchPrompt.trim()) set.prompt = patchPrompt.trim();
    if (patchModel.trim()) set.model_override = patchModel.trim();
    if (Object.keys(set).length === 0) {
      toast.error("请填写新的提示词或模型后再提交");
      return;
    }
    try {
      const result = (await patchMutation.mutateAsync({
        runId,
        expected_dag_version: runState.dagVersion,
        ops: [{ op: "modify_node", node_id: patchNodeId, set }],
        reason: "运行头部快速补丁",
      })) as WorkflowPatchResult;
      if (result && result.ok === false) {
        toast.error(
          result.error === "version_conflict"
            ? "DAG 已被其它补丁修改，请刷新后重试"
            : (result.error ?? "补丁提交失败"),
        );
        return;
      }
      toast.success("补丁已提交");
      setPatchOpen(false);
      setPatchNodeId("");
      setPatchPrompt("");
      setPatchModel("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "提交失败");
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {!isTerminal ? (
        <>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            disabled={pauseMutation.isPending || resumeMutation.isPending}
            onClick={handlePauseResume}
          >
            {isPaused ? (
              <IconPlayerPlay className="size-3.5" />
            ) : (
              <IconPlayerPause className="size-3.5" />
            )}
            {isPaused ? "恢复" : "暂停"}
          </Button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs"
              >
                <IconX className="size-3.5" />
                取消
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>取消这次运行？</AlertDialogTitle>
                <AlertDialogDescription>
                  取消后运行进入终态，正在执行的节点会被终止，无法恢复。如需继续这条工作，请改用
                  Fork。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>再想想</AlertDialogCancel>
                <AlertDialogAction
                  onClick={handleCancel}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  确认取消
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => setForkOpen(true)}
      >
        <IconGitFork className="size-3.5" />
        Fork
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        disabled={isTerminal}
        title={isTerminal ? "运行已终态，无法 Patch — 请改用 Fork" : undefined}
        onClick={() => setPatchOpen(true)}
      >
        <IconEdit className="size-3.5" />
        Patch
      </Button>

      {/* Fork dialog */}
      <Dialog open={forkOpen} onOpenChange={setForkOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Fork 这次运行</DialogTitle>
            <DialogDescription>
              已完成节点复用其产物作为缓存；所选节点及其下游会重新执行。省略节点则整条运行全新重跑（不缓存）。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label>从节点 fork（可选）</Label>
            <Select value={forkFromNode} onValueChange={setForkFromNode}>
              <SelectTrigger className="font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FORK_FRESH}>
                  整条运行全新 fork（不缓存）
                </SelectItem>
                {dagNodes.map((n) => (
                  <SelectItem
                    key={n.id}
                    value={n.id}
                    className="font-mono text-xs"
                  >
                    {n.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setForkOpen(false)}>
              取消
            </Button>
            <Button onClick={handleFork} disabled={forkMutation.isPending}>
              {forkMutation.isPending ? "Fork 中…" : "确认 Fork"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Patch dialog */}
      <Dialog open={patchOpen} onOpenChange={setPatchOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Patch 未执行的节点</DialogTitle>
            <DialogDescription>
              只能修改尚未执行的节点（pending/ready）；已执行/运行中的节点请改用
              Fork。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>目标节点</Label>
              <Select value={patchNodeId} onValueChange={setPatchNodeId}>
                <SelectTrigger className="font-mono text-xs">
                  <SelectValue placeholder="选择一个未执行的节点" />
                </SelectTrigger>
                <SelectContent>
                  {patchableNodes.map((n) => (
                    <SelectItem
                      key={n.id}
                      value={n.id}
                      className="font-mono text-xs"
                    >
                      {n.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {patchableNodes.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  没有可修改的未执行节点。
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="run-patch-prompt">新提示词（留空则不改）</Label>
              <Textarea
                id="run-patch-prompt"
                rows={5}
                className="font-mono text-xs"
                value={patchPrompt}
                onChange={(e) => setPatchPrompt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="run-patch-model">模型覆盖（留空则不改）</Label>
              <Input
                id="run-patch-model"
                className="font-mono text-xs"
                value={patchModel}
                onChange={(e) => setPatchModel(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPatchOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handlePatchSubmit}
              disabled={patchMutation.isPending}
            >
              {patchMutation.isPending ? "提交中…" : "提交补丁"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
