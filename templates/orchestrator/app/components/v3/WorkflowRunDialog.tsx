import { useActionMutation } from "@agent-native/core/client";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type { WorkflowListRow } from "./workflow-library-types";

export interface WorkflowRunDialogProps {
  template: WorkflowListRow | null;
  onOpenChange: (open: boolean) => void;
  onRunStarted: (runId: string) => void;
}

/**
 * Minimal "新建 run" flow (04 §4 card hover action). This is a lightweight
 * first pass — a raw JSON inputs textarea validated by workflowRun's own
 * ajv check — not the full inputSchema-driven form the §5 editor's future
 * `RunOnceDialog` (`试运行`) is meant to be; that's a separate, larger
 * feature (dynamic form generation from JSON Schema) out of this task's scope.
 */
export function WorkflowRunDialog({
  template,
  onOpenChange,
  onRunStarted,
}: WorkflowRunDialogProps) {
  const [inputsJson, setInputsJson] = useState("{}");
  const runAction = useActionMutation("workflowRun" as any, {});

  const handleClose = (open: boolean) => {
    if (!open) setInputsJson("{}");
    onOpenChange(open);
  };

  const handleSubmit = () => {
    if (!template) return;
    let inputs: unknown;
    try {
      inputs = inputsJson.trim() ? JSON.parse(inputsJson) : {};
    } catch {
      toast.error("inputs 不是合法 JSON");
      return;
    }
    runAction.mutate(
      { template: template.name, inputs },
      {
        onSuccess: (result: any) => {
          toast.success(`已启动 run ${result.runId}`);
          handleClose(false);
          onRunStarted(result.runId);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "启动运行失败");
        },
      },
    );
  };

  return (
    <Dialog open={!!template} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>新建 run</DialogTitle>
          <DialogDescription>
            从模板 <span className="font-mono">{template?.name}</span> (v
            {template?.version}) 启动一次运行。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="run-inputs">inputs (JSON)</Label>
          <Textarea
            id="run-inputs"
            className="min-h-32 font-mono text-xs"
            value={inputsJson}
            onChange={(e) => setInputsJson(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={runAction.isPending}>
            <IconPlayerPlay className="mr-1 size-4" />
            {runAction.isPending ? "启动中…" : "启动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
