import { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { IconPlus } from "@tabler/icons-react";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import {
  useCreateTask,
  useTasks,
  useWorkflows,
} from "@/hooks/use-orchestrator";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function meta() {
  return [{ title: `${APP_TITLE} — Tasks` }];
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function TasksRoute() {
  const { t } = useTranslation();
  const { data: tasks = [], isLoading } = useTasks();
  const { data: workflows = [] } = useWorkflows();
  const createTask = useCreateTask();

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [workflowId, setWorkflowId] = useState<string>("none");

  function submit() {
    if (!title.trim()) return;
    createTask.mutate(
      {
        title: title.trim(),
        description: description.trim(),
        workflowId: workflowId === "none" ? undefined : workflowId,
      },
      {
        onSuccess: () => {
          setOpen(false);
          setTitle("");
          setDescription("");
          setWorkflowId("none");
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Failed"),
      },
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {t("tasks.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("tasks.subtitle")}
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <IconPlus className="size-4" />
              {t("tasks.newTask")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("tasks.newTask")}</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-2">
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">
                  {t("tasks.nameLabel")}
                </label>
                <Input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t("tasks.namePlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
                  }}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">
                  {t("tasks.descLabel")}
                </label>
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("tasks.descPlaceholder")}
                  rows={3}
                />
              </div>
              <div className="grid gap-1.5">
                <label className="text-sm font-medium">
                  {t("tasks.workflowLabel")}
                </label>
                <Select value={workflowId} onValueChange={setWorkflowId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("tasks.workflowNone")}
                    </SelectItem>
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
                onClick={() => setOpen(false)}
                disabled={createTask.isPending}
              >
                {t("common.cancel")}
              </Button>
              <Button
                onClick={submit}
                disabled={!title.trim() || createTask.isPending}
              >
                {t("common.create")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : tasks.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{t("tasks.empty")}</p>
        </div>
      ) : (
        <ul className="grid gap-2">
          {tasks.map((task) => (
            <li key={task.id}>
              <Link
                to={`/tasks/${task.id}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{task.title}</p>
                  {task.description ? (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {task.description}
                    </p>
                  ) : null}
                </div>
                <span className="hidden text-xs text-muted-foreground sm:block">
                  {fmtDate(task.updatedAt)}
                </span>
                <StatusBadge status={task.status} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
