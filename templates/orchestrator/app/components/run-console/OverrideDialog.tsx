import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { NodeRunDetail } from "@/hooks/use-runs";

// D5 — Edit & re-run node (FRONTEND §4(b) / §10). Edits prompt/model/effort and
// fires `node-override(runId, nodeRunId, patch)` which re-runs ONLY this node +
// its downstream (upstream reused from the journal). The patch is scoped to the
// run, never mutating the shared template.

export interface OverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  node: NodeRunDetail | null;
  /** The node-override mutation (from useRunControls). */
  override: {
    mutate: (
      args: { runId: string; nodeRunId: string; patch: Record<string, string> },
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void },
    ) => void;
    isPending: boolean;
  };
}

type Effort = "" | "low" | "medium" | "high";

export function OverrideDialog({
  open,
  onOpenChange,
  runId,
  node,
  override,
}: OverrideDialogProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<Effort>("");

  // Seed the form from the focused node each time the dialog opens.
  useEffect(() => {
    if (open) {
      setModel(node?.model ?? "");
      setEffort("");
      setPrompt("");
    }
  }, [open, node?.id, node?.model]);

  function onSubmit() {
    if (!node) return;
    const patch: Record<string, string> = {};
    if (prompt.trim()) patch.prompt = prompt.trim();
    if (model.trim() && model.trim() !== (node.model ?? "")) {
      patch.model = model.trim();
    }
    if (effort) patch.effort = effort;
    if (Object.keys(patch).length === 0) {
      toast.error(t("runs.overrideEmpty"));
      return;
    }
    override.mutate(
      { runId, nodeRunId: node.id, patch },
      {
        onSuccess: () => {
          toast.success(t("runs.overrideStarted"));
          onOpenChange(false);
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("runs.controlError")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("runs.overrideTitle")}</DialogTitle>
          <DialogDescription>
            {node?.title ?? t("runs.overrideSubtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="override-prompt">{t("runs.overridePrompt")}</Label>
            <Textarea
              id="override-prompt"
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("runs.overridePromptPlaceholder")}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="override-model">{t("runs.overrideModel")}</Label>
              <Input
                id="override-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="claude-opus-4-8"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("runs.overrideEffort")}</Label>
              <Select
                value={effort || "keep"}
                onValueChange={(v) =>
                  setEffort(v === "keep" ? "" : (v as Effort))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">{t("runs.overrideKeep")}</SelectItem>
                  <SelectItem value="low">{t("flow.effort.low")}</SelectItem>
                  <SelectItem value="medium">
                    {t("flow.effort.medium")}
                  </SelectItem>
                  <SelectItem value="high">{t("flow.effort.high")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={override.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={override.isPending || !node}>
            {t("runs.overrideSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
