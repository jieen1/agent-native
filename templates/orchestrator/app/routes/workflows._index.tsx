import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import {
  IconArrowBigUpLines,
  IconPlus,
  IconSitemap,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import { useTemplates } from "@/hooks/use-templates";
import { useSaveTemplate } from "@/hooks/use-template";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PromoteRunDialog } from "@/components/dialogs/PromoteRunDialog";
import { graphForSave } from "@/components/workflow-canvas/WorkflowCanvas";
import { starterModel } from "@/lib/workflow-graph-model";

export function meta() {
  return [{ title: `${APP_TITLE} — Workflows` }];
}

// Workflow / template catalog (FRONTEND §5). Lists v2 templates (list-templates);
// "New workflow" creates a minimal start→end v2 template via save-template and
// jumps into the React-Flow editor. The legacy v1 list-workflows surface is
// retained elsewhere but the editor flow is fully v2 now (P4a).
export default function WorkflowsRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: templates = [], isLoading } = useTemplates();
  const saveTemplate = useSaveTemplate();
  const navAction = useActionMutation("navigate", {});
  const [promoteOpen, setPromoteOpen] = useState(false);

  useEffect(() => {
    navAction.mutate({ view: "workflows" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function createWorkflow() {
    // A minimal valid starter graph (start → end); the editor opens on it.
    // skipFinalizeGate keeps the blank starter from getting the delivery gate
    // auto-injected before the user has authored anything.
    const graph = graphForSave(starterModel());
    saveTemplate.mutate(
      {
        name: t("workflows.namePlaceholder"),
        description: "",
        graph,
        skipFinalizeGate: true,
      },
      {
        onSuccess: (res: unknown) => {
          const id = (res as { id?: string } | null)?.id;
          if (id) navigate(`/workflows/${id}`);
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
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
            disabled={saveTemplate.isPending}
          >
            <IconPlus className="size-4" />
            {t("workflows.newWorkflow")}
          </Button>
        </div>
      </header>

      {isLoading ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Skeleton className="h-20 w-full rounded-lg" />
            </li>
          ))}
        </ul>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {t("workflows.empty")}
        </div>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {templates.map((wf) => (
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
                  <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t("flow.nodeCount", { count: wf.nodeCount })}</span>
                    <span>·</span>
                    <span>v{wf.version}</span>
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
