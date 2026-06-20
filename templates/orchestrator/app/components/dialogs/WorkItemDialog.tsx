import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { useCreateWorkItem } from "@/hooks/use-work-items";
import { useProjects } from "@/hooks/use-projects";
import type { TemplateListItem } from "@/hooks/use-templates";

const WORK_ITEM_TYPES = [
  "requirement",
  "bug",
  "prod-issue",
  "task",
] as const;

// D1 — New work item (FRONTEND §10). project ▾ / type / title / description /
// priority / optional workflow. Submits create-work-item. Optimistic-by-list:
// the create hook invalidates the board so the new card appears. Esc/overlay
// cancels; primary spins only while in flight; errors keep the dialog open.
export interface WorkItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-select (and lock) a project — used from the project-detail page. */
  projectId?: string;
  /** Workflow-template options for the optional workflow picker. */
  workflows?: TemplateListItem[];
  onCreated?: (id: string) => void;
}

export function WorkItemDialog({
  open,
  onOpenChange,
  projectId,
  workflows = [],
  onCreated,
}: WorkItemDialogProps) {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjects();
  const createWorkItem = useCreateWorkItem();

  const [project, setProject] = useState<string>(projectId ?? "");
  const [type, setType] = useState<(typeof WORK_ITEM_TYPES)[number]>("task");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("2");
  const [workflowId, setWorkflowId] = useState<string>("auto");

  // Reset on open; honor a locked projectId or default to the first project.
  useEffect(() => {
    if (!open) return;
    setProject(projectId ?? projects[0]?.id ?? "");
    setType("task");
    setTitle("");
    setDescription("");
    setPriority("2");
    setWorkflowId("auto");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId]);

  function submit() {
    if (!project) {
      toast.error(t("dialog.requiredField"));
      return;
    }
    if (!title.trim()) return;
    createWorkItem.mutate(
      {
        projectId: project,
        type,
        title: title.trim(),
        description: description.trim() || undefined,
        priority: Number(priority) - 2, // p2 = normal = 0
        workflowId: workflowId === "auto" ? undefined : workflowId,
      },
      {
        onSuccess: (res: unknown) => {
          onOpenChange(false);
          const id = (res as { id?: string })?.id;
          if (id) onCreated?.(id);
          toast.success(t("common.created"));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : t("common.actionFailed")),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialog.newWorkItemTitle")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialog.newWorkItemTitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          {!projectId ? (
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldProject")}</Label>
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
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldType")}</Label>
              <Select
                value={type}
                onValueChange={(v) =>
                  setType(v as (typeof WORK_ITEM_TYPES)[number])
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ITEM_TYPES.map((ty) => (
                    <SelectItem key={ty} value={ty}>
                      {t(`wtype.${ty}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldPriority")}</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">{t("priority.p0")}</SelectItem>
                  <SelectItem value="1">{t("priority.p1")}</SelectItem>
                  <SelectItem value="2">{t("priority.p2")}</SelectItem>
                  <SelectItem value="3">{t("priority.p3")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldTitle")}</Label>
            <Input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("dialog.titlePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldDescription")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("dialog.descPlaceholder")}
              rows={3}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>
              {t("dialog.fieldWorkflow")}{" "}
              <span className="text-muted-foreground">
                ({t("common.optional")})
              </span>
            </Label>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("dialog.workflowAuto")}</SelectItem>
                {workflows.map((wf) => (
                  <SelectItem key={wf.id} value={wf.id}>
                    {wf.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={createWorkItem.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={!title.trim() || !project || createWorkItem.isPending}
          >
            {createWorkItem.isPending ? <Spinner className="size-4" /> : null}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
