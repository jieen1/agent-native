import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
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
import { useProjects } from "@/hooks/use-projects";
import { useCreateWorkItem } from "@/hooks/use-work-items";
import { useRunControls } from "@/hooks/use-runs";

// "Run once…" (FRONTEND §6) — prefills a work item with THIS template, creates
// it, starts the run, and jumps to the run console. If no project exists yet the
// dialog falls back to running the template directly (run-start({templateId})).
// All writes go through actions (create-work-item / run-start) — never raw fetch.

export interface RunOnceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templateId: string;
  templateName: string;
}

export function RunOnceDialog({
  open,
  onOpenChange,
  templateId,
  templateName,
}: RunOnceDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: projects = [] } = useProjects();
  const createWorkItem = useCreateWorkItem();
  const { runStart } = useRunControls();
  const navAction = useActionMutation("navigate", {});

  const [project, setProject] = useState("");
  const [title, setTitle] = useState("");

  useEffect(() => {
    if (!open) return;
    setProject(projects[0]?.id ?? "");
    setTitle(templateName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pending = createWorkItem.isPending || runStart.isPending;

  function onError(e: unknown) {
    toast.error(e instanceof Error ? e.message : t("common.actionFailed"));
  }

  async function submit() {
    try {
      // No project yet → run the template directly (still creates a run).
      if (!project) {
        const res = (await runStart.mutateAsync({
          templateId,
          wait: false,
        })) as { runId?: string };
        onOpenChange(false);
        if (res?.runId) {
          navAction.mutate({ view: "run", id: res.runId });
          navigate(`/runs/${res.runId}`);
        }
        return;
      }

      // §6 path: create a work item bound to this template, run it, open it.
      const created = (await createWorkItem.mutateAsync({
        projectId: project,
        title: title.trim() || templateName,
        type: "task",
        workflowId: templateId,
      })) as { id?: string };
      if (!created?.id) {
        onOpenChange(false);
        return;
      }
      const run = (await runStart.mutateAsync({
        workItemId: created.id,
        wait: false,
      })) as { runId?: string };
      onOpenChange(false);
      navAction.mutate({ view: "item", id: created.id });
      navigate(`/items/${created.id}`);
      if (run?.runId) toast.success(t("board.runStarted"));
    } catch (e) {
      onError(e);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("flow.runOnceTitle")}</DialogTitle>
          <DialogDescription>{t("flow.runOnceSubtitle")}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldProject")}</Label>
            {projects.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("flow.runOnceNoProject")}
              </p>
            ) : (
              <Select value={project} onValueChange={setProject}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.key})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {project ? (
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldTitle")}</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("dialog.titlePlaceholder")}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending}>
            {pending ? <Spinner className="size-4" /> : null}
            {t("flow.runOnceSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
