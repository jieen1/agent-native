import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import {
  IconArrowLeft,
  IconChevronDown,
  IconPlayerPlay,
  IconPlayerStop,
  IconRefresh,
  IconTrash,
} from "@tabler/icons-react";
import { sendToAgentChat } from "@agent-native/core/client";
import { toast } from "sonner";
import {
  useDeleteTask,
  useRunOrchestrator,
  useStopTask,
  useTask,
} from "@/hooks/use-orchestrator";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import type { StepRun } from "../../shared/types";

function StepCard({ step }: { step: StepRun }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasBody = !!(step.output || step.error);
  return (
    <li className="rounded-lg border border-border bg-card">
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left disabled:cursor-default"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {step.ordering + 1}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{step.title}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{step.assignee}</span>
            {step.model ? <span>· {step.model}</span> : null}
            {step.engine ? <span>· {step.engine}</span> : null}
          </div>
        </div>
        <StatusBadge status={step.status} />
        {hasBody ? (
          <IconChevronDown
            className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        ) : null}
      </button>
      {open && hasBody ? (
        <div className="border-t border-border px-4 py-3 text-sm">
          {step.error ? (
            <pre className="whitespace-pre-wrap break-words text-xs text-red-600 dark:text-red-400">
              {step.error}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap break-words text-xs text-foreground/90">
              {step.output}
            </pre>
          )}
        </div>
      ) : null}
    </li>
  );
}

export default function TaskDetailRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data, isLoading } = useTask(id);
  const runOrchestrator = useRunOrchestrator();
  const stopTask = useStopTask();
  const deleteTask = useDeleteTask();

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          ← {t("task.back")}
        </Link>
      </div>
    );
  }

  const { task, workflow, stepRuns } = data;
  const isRunning = task.status === "running";
  const hasWorkflow = !!task.workflowId;

  function handleRun() {
    if (!id) return;
    runOrchestrator.mutate(
      { taskId: id },
      {
        onSuccess: (res: unknown) => {
          const instruction =
            (res as { instruction?: string } | null)?.instruction ??
            `Execute orchestrator task ${id}.`;
          sendToAgentChat({
            message: instruction,
            submit: true,
            openSidebar: true,
          });
          toast.success(t("task.runStarted"));
        },
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Failed to run"),
      },
    );
  }

  function handleStop() {
    if (!id) return;
    stopTask.mutate({ taskId: id });
  }

  function handleDelete() {
    if (!id) return;
    deleteTask.mutate(
      { id },
      { onSuccess: () => navigate("/") },
    );
  }

  const doneCount = stepRuns.filter((s) => s.status === "done").length;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <Link
        to="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <IconArrowLeft className="size-4" />
        {t("task.back")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              {task.title}
            </h1>
            <StatusBadge status={task.status} />
          </div>
          {task.description ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {task.description}
            </p>
          ) : null}
          {workflow ? (
            <Link
              to={`/workflows/${workflow.id}`}
              className="mt-1 inline-block text-xs text-muted-foreground hover:underline"
            >
              {t("tasks.workflowLabel")}: {workflow.name}
            </Link>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button variant="outline" size="sm" onClick={handleStop}>
              <IconPlayerStop className="size-4" />
              {t("task.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleRun}
              disabled={!hasWorkflow || runOrchestrator.isPending}
            >
              {stepRuns.length > 0 ? (
                <IconRefresh className="size-4" />
              ) : (
                <IconPlayerPlay className="size-4" />
              )}
              {stepRuns.length > 0 ? t("task.rerun") : t("task.run")}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={handleDelete}>
            <IconTrash className="size-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

      <section className="mt-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("task.steps")}</h2>
          {stepRuns.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {t("task.progress")}: {doneCount}/{stepRuns.length}
            </span>
          ) : null}
        </div>
        {stepRuns.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            {hasWorkflow ? t("task.noSteps") : t("task.noWorkflow")}
          </div>
        ) : (
          <ul className="grid gap-2">
            {stepRuns.map((step) => (
              <StepCard key={step.id} step={step} />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold">{t("task.result")}</h2>
        <div className="rounded-lg border border-border bg-card p-4 text-sm">
          {task.result ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-foreground/90">
              {task.result}
            </pre>
          ) : (
            <p className="text-muted-foreground">{t("task.noResult")}</p>
          )}
        </div>
      </section>
    </div>
  );
}
