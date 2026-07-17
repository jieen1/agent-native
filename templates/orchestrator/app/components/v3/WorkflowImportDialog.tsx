import { useActionMutation } from "@agent-native/core/client";
import { IconCode } from "@tabler/icons-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface WorkflowImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (id: string) => void;
}

const PLACEHOLDER = `{
  "nodes": [
    { "type": "agent", "id": "dev", "agent": "vllm", "prompt": "..." }
  ]
}`;

/**
 * "导入 JSON" (04 §4 page-header action). Accepts either a bare DAG object
 * (`{ "nodes": [...] }`) paired with the Name field below, or a full export
 * shape (`{ name, dag, inputSchema?, description? }`) — the name field then
 * pre-fills from the pasted JSON but stays editable/required.
 */
export function WorkflowImportDialog({
  open,
  onOpenChange,
  onImported,
}: WorkflowImportDialogProps) {
  const [name, setName] = useState("");
  const [json, setJson] = useState("");
  const saveAction = useActionMutation("workflowSave" as any, {});

  const handleClose = (next: boolean) => {
    if (!next) {
      setName("");
      setJson("");
    }
    onOpenChange(next);
  };

  const handlePaste = (value: string) => {
    setJson(value);
    if (name.trim()) return;
    try {
      const parsed = JSON.parse(value);
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.name === "string"
      ) {
        setName(parsed.name);
      }
    } catch {
      // not valid JSON yet — leave name as-is, workflowSave will surface the error on submit
    }
  };

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("请输入模板名称");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      toast.error(
        e instanceof Error ? `JSON 解析失败：${e.message}` : "JSON 解析失败",
      );
      return;
    }
    const payload =
      parsed && typeof parsed === "object" && "dag" in (parsed as object)
        ? (parsed as {
            dag: unknown;
            inputSchema?: unknown;
            description?: string;
          })
        : { dag: parsed };

    saveAction.mutate(
      { name: trimmedName, ...payload },
      {
        onSuccess: (result: any) => {
          toast.success("模板已导入");
          handleClose(false);
          onImported(result.id);
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : "导入失败");
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>导入 JSON</DialogTitle>
          <DialogDescription>
            粘贴一个 DAG JSON（或 {"{ name, dag, inputSchema, description }"}{" "}
            完整导出），保存为新工作流模板。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="import-name">模板名称</Label>
            <Input
              id="import-name"
              placeholder="例如 my-custom-pipeline"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-json">DAG JSON</Label>
            <Textarea
              id="import-json"
              className="min-h-40 font-mono text-xs"
              placeholder={PLACEHOLDER}
              value={json}
              onChange={(e) => handlePaste(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleClose(false)}>
            取消
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !json.trim() || saveAction.isPending}
          >
            <IconCode className="mr-1 size-4" />
            {saveAction.isPending ? "导入中…" : "导入"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
