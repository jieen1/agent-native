import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import {
  IconArrowLeft,
  IconBrandGit,
  IconSettings,
} from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useProject } from "@/hooks/use-projects";
import { useWorkItems } from "@/hooks/use-work-items";
import { useTemplates } from "@/hooks/use-templates";
import { useQueueStatus } from "@/hooks/use-queue";
import { Button } from "@/components/ui/button";
import { BoardView } from "@/components/board/BoardView";
import { EmptyState } from "@/components/board/EmptyState";
import { ProjectDialog } from "@/components/dialogs/ProjectDialog";
import { IconFolderOff } from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — Project` }];
}

// Project detail (FRONTEND §3). Header strip (name · key · repo · default
// workflow) + a project-scoped copy of the Board (filtered to this project) +
// the settings gear → D3 (edit mode).
export default function ProjectDetailRoute() {
  const { t } = useTranslation();
  const { id } = useParams();
  const { data: project, isLoading, error } = useProject(id);
  const {
    data: items = [],
    isLoading: itemsLoading,
    error: itemsError,
  } = useWorkItems(id ? { projectId: id } : {});
  const { data: templates = [] } = useTemplates();
  const { data: queue } = useQueueStatus();
  const navigate = useActionMutation("navigate", {});
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    if (id) navigate.mutate({ view: "project", id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!id) return null;

  if (!isLoading && (error || !project)) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
        <EmptyState icon={IconFolderOff} title={t("project.notFound")} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-4 py-5 sm:px-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/projects">
              <IconArrowLeft className="size-4" />
              {t("projects.title")}
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold tracking-tight sm:text-xl">
              {project?.name ?? t("common.loading")}
            </h1>
            <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
              <span>{project?.key}</span>
              {project?.gitRemote ? (
                <span className="inline-flex items-center gap-1">
                  <IconBrandGit className="size-3" />
                  {project.defaultBranch ?? "main"}
                </span>
              ) : null}
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSettingsOpen(true)}
          disabled={!project}
        >
          <IconSettings className="size-4" />
          {t("project.settings")}
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        <BoardView
          items={items}
          isLoading={itemsLoading}
          error={itemsError}
          project={project ?? null}
          workflows={templates}
          concurrencyDegree={queue?.concurrencyDegree ?? 1}
        />
      </div>

      <ProjectDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        project={project ?? null}
      />
    </div>
  );
}
