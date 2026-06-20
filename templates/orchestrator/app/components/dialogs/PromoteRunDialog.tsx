import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { usePromoteRun } from "@/hooks/use-templates";
import { useRuns } from "@/hooks/use-runs";

// D9 — Promote run → template (FRONTEND §10 / §5). Pick a completed run, distill
// its executed graph into a NEW template via promote-run-to-template.
export interface PromoteRunDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPromoted?: (templateId: string) => void;
}

export function PromoteRunDialog({
  open,
  onOpenChange,
  onPromoted,
}: PromoteRunDialogProps) {
  const { t } = useTranslation();
  const { data: runs = [] } = useRuns();
  const promote = usePromoteRun();

  const completed = runs.filter((r) => r.status === "done");
  const [runId, setRunId] = useState("");
  const [name, setName] = useState("");

  useEffect(() => {
    if (!open) return;
    setRunId(completed[0]?.id ?? "");
    setName("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function submit() {
    if (!runId) return;
    promote.mutate(
      { runId, name: name.trim() || undefined },
      {
        onSuccess: (res: unknown) => {
          onOpenChange(false);
          const id = (res as { id?: string })?.id;
          if (id) onPromoted?.(id);
          toast.success(t("dialog.promoted"));
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
          <DialogTitle>{t("dialog.promoteTitle")}</DialogTitle>
          <DialogDescription>{t("dialog.promoteSubtitle")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>{t("dialog.promoteRun")}</Label>
            {completed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t("dialog.promoteEmpty")}
              </p>
            ) : (
              <Select value={runId} onValueChange={setRunId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {completed.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label>
              {t("dialog.promoteName")}{" "}
              <span className="text-muted-foreground">
                ({t("common.optional")})
              </span>
            </Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={promote.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={promote.isPending || !runId}
          >
            {promote.isPending ? <Spinner className="size-4" /> : null}
            {t("dialog.promoteSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
