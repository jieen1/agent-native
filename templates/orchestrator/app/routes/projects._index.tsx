import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import {
  IconBrandGit,
  IconFolder,
  IconFolders,
  IconPlus,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useProjects } from "@/hooks/use-projects";
import { useWorkItems } from "@/hooks/use-work-items";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/board/EmptyState";
import { ProjectDialog } from "@/components/dialogs/ProjectDialog";

export function meta() {
  return [{ title: `${APP_TITLE} — 项目` }];
}

// Projects list (FRONTEND §3). Grid of project cards: name, key, repo-linked
// icon, open-item count, default-workflow name. + New project → D3.
export default function ProjectsRoute() {
  const { t } = useTranslation();
  const { data: projects = [], isLoading } = useProjects();
  const { data: items = [] } = useWorkItems();
  const navigate = useActionMutation("navigate", {});
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    navigate.mutate({ view: "projects" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openCountFor(projectId: string): number {
    return items.filter(
      (i) =>
        i.projectId === projectId &&
        i.statusCategory !== "completed" &&
        i.statusCategory !== "cancelled",
    ).length;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
            {t("projects.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("projects.subtitle")}
          </p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <IconPlus className="size-4" />
          {t("projects.newProject")}
        </Button>
      </header>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={IconFolders}
          title={t("projects.emptyTitle")}
          description={t("projects.emptyDescription")}
          action={
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <IconPlus className="size-4" />
              {t("projects.newProject")}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="group flex flex-col gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:border-foreground/20 hover:bg-accent/30"
            >
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <IconFolder className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="font-mono text-xs text-muted-foreground">
                    {p.key}
                  </p>
                </div>
                {p.hasRepo ? (
                  <IconBrandGit
                    className="size-4 text-muted-foreground"
                    aria-label={t("projects.repoLinked")}
                  />
                ) : null}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{t("projects.openItems", { count: openCountFor(p.id) })}</span>
                {p.defaultWorkflowId ? (
                  <span className="truncate">{t("projects.defaultWorkflow")}</span>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}

      <ProjectDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
