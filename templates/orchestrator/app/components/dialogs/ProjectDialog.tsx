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
import { Spinner } from "@/components/ui/spinner";
import {
  useCreateProject,
  useUpdateProject,
  type ProjectDetail,
} from "@/hooks/use-projects";

// D3 — New / edit project (FRONTEND §10). name / key / repo {remote,branch,
// workingDir} / environments. Submits create-project or update-project. Esc /
// overlay cancels; errors keep the dialog open and toast.
export interface ProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pass the project to edit; omit for create mode. */
  project?: ProjectDetail | null;
  onSaved?: (id: string) => void;
}

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
}: ProjectDialogProps) {
  const { t } = useTranslation();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const isEdit = !!project;
  const pending = createProject.isPending || updateProject.isPending;

  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [description, setDescription] = useState("");
  const [workingDir, setWorkingDir] = useState("");
  const [gitRemote, setGitRemote] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("");
  const [environments, setEnvironments] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(project?.name ?? "");
    setKey(project?.key ?? "");
    setDescription(project?.description ?? "");
    setWorkingDir(project?.workingDir ?? "");
    setGitRemote(project?.gitRemote ?? "");
    setDefaultBranch(project?.defaultBranch ?? "");
    setEnvironments((project?.environments ?? []).join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  function parseEnvs(): string[] | undefined {
    const list = environments
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return list.length > 0 ? list : undefined;
  }

  function submit() {
    if (!name.trim()) {
      toast.error(t("common.nameRequired"));
      return;
    }
    if (!isEdit && !key.trim()) {
      toast.error(t("dialog.requiredField"));
      return;
    }
    const onError = (e: unknown) =>
      toast.error(e instanceof Error ? e.message : t("common.actionFailed"));

    if (isEdit && project) {
      updateProject.mutate(
        {
          id: project.id,
          name: name.trim(),
          description: description.trim(),
          workingDir: workingDir.trim(),
          gitRemote: gitRemote.trim() || null,
          defaultBranch: defaultBranch.trim() || null,
          environments: parseEnvs() ?? null,
        },
        {
          onSuccess: () => {
            onOpenChange(false);
            onSaved?.(project.id);
            toast.success(t("common.saved"));
          },
          onError,
        },
      );
      return;
    }

    createProject.mutate(
      {
        name: name.trim(),
        key: key.trim(),
        description: description.trim() || undefined,
        workingDir: workingDir.trim() || undefined,
        gitRemote: gitRemote.trim() || undefined,
        defaultBranch: defaultBranch.trim() || undefined,
        environments: parseEnvs(),
      },
      {
        onSuccess: (res: unknown) => {
          onOpenChange(false);
          const id = (res as { id?: string })?.id;
          if (id) onSaved?.(id);
          toast.success(t("common.created"));
        },
        onError,
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t("dialog.editProjectTitle")
              : t("dialog.newProjectTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {isEdit
              ? t("dialog.editProjectTitle")
              : t("dialog.newProjectTitle")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldName")}</Label>
              <Input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldKey")}</Label>
              <Input
                value={key}
                disabled={isEdit}
                onChange={(e) => setKey(e.target.value.toUpperCase())}
                placeholder="PAY"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("common.description")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldWorkingDir")}</Label>
            <Input
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              placeholder={key || "project-dir"}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldRepoRemote")}</Label>
              <Input
                value={gitRemote}
                onChange={(e) => setGitRemote(e.target.value)}
                placeholder="git@github.com:org/repo.git"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("dialog.fieldDefaultBranch")}</Label>
              <Input
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="main"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>{t("dialog.fieldEnvironments")}</Label>
            <Input
              value={environments}
              onChange={(e) => setEnvironments(e.target.value)}
              placeholder="dev, SIT, UAT, prod"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? <Spinner className="size-4" /> : null}
            {isEdit ? t("common.save") : t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
