import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { IconArrowBigUpLines, IconPlus, IconSitemap } from "@tabler/icons-react";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import { useSaveWorkflow, useWorkflows } from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { PromoteRunDialog } from "@/components/dialogs/PromoteRunDialog";

export function meta() {
  return [{ title: `${APP_TITLE} — Workflows` }];
}

const STARTER_STEPS = [
  {
    key: "research",
    title: "Research",
    assignee: "local",
    model: "claude-opus-4-8",
    prompt: "Gather the key facts and context for the task.",
    dependsOn: [],
  },
  {
    key: "draft",
    title: "Draft",
    assignee: "local",
    model: "claude-opus-4-8",
    prompt: "Produce a first draft using the research output.",
    dependsOn: ["research"],
  },
  {
    key: "review",
    title: "Review",
    assignee: "local",
    model: "claude-opus-4-8",
    prompt: "Critique and refine the draft into the final deliverable.",
    dependsOn: ["draft"],
  },
];

export default function WorkflowsRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: workflows = [], isLoading } = useWorkflows();
  const saveWorkflow = useSaveWorkflow();
  const [promoteOpen, setPromoteOpen] = useState(false);

  function createWorkflow() {
    saveWorkflow.mutate(
      {
        name: t("workflows.namePlaceholder"),
        description: "",
        steps: STARTER_STEPS,
      },
      {
        onSuccess: (res: unknown) => {
          const id = (res as { id?: string } | null)?.id;
          if (id) navigate(`/workflows/${id}`);
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
            {t("workflows.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("workflows.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPromoteOpen(true)}
          >
            <IconArrowBigUpLines className="size-4" />
            {t("dialog.promoteTitle")}
          </Button>
          <Button
            size="sm"
            onClick={createWorkflow}
            disabled={saveWorkflow.isPending}
          >
            <IconPlus className="size-4" />
            {t("workflows.newWorkflow")}
          </Button>
        </div>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : workflows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {t("workflows.empty")}
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {workflows.map((wf) => (
            <li key={wf.id}>
              <Link
                to={`/workflows/${wf.id}`}
                className="flex h-full items-start gap-3 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/20 hover:bg-accent/40"
              >
                <IconSitemap className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{wf.name}</p>
                  {wf.description ? (
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {wf.description}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("workflows.steps", { count: wf.stepCount })}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <PromoteRunDialog open={promoteOpen} onOpenChange={setPromoteOpen} />
    </div>
  );
}
