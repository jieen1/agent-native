import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import { IconFolders } from "@tabler/icons-react";
import { APP_TITLE } from "@/lib/app-config";
import { useWorkItems } from "@/hooks/use-work-items";
import {
  useProjects,
  useProjectSchemes,
  type ProjectDetail,
} from "@/hooks/use-projects";
import { useTemplates } from "@/hooks/use-templates";
import { useQueueStatus } from "@/hooks/use-queue";
import { BoardView } from "@/components/board/BoardView";
import { EmptyState } from "@/components/board/EmptyState";

export function meta() {
  return [{ title: `${APP_TITLE} — Board` }];
}

// Board route (FRONTEND §2) — the PM kanban over ALL projects. Reads each
// project's resolved scheme set in one call (list-project-schemes) so the
// columns derive correctly per work-item type; passes everything to the
// reusable <BoardView>.
export default function BoardRoute() {
  const { t } = useTranslation();
  const { data: items = [], isLoading, error } = useWorkItems();
  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: projectSchemes = [] } = useProjectSchemes();
  const { data: templates = [] } = useTemplates();
  const { data: queue } = useQueueStatus();
  const navigate = useActionMutation("navigate", {});

  // Write application_state so the agent knows the user is on the board.
  useEffect(() => {
    navigate.mutate({ view: "board" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schemesByProject = useMemo(() => {
    const map: Record<string, ProjectDetail["schemes"]> = {};
    for (const p of projectSchemes) map[p.id] = p.schemes;
    return map;
  }, [projectSchemes]);

  const keyByProject = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of projects) map[p.id] = p.key;
    return map;
  }, [projects]);

  if (!projectsLoading && projects.length === 0) {
    return (
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
        <EmptyState
          icon={IconFolders}
          title={t("board.noProjectTitle")}
          description={t("board.noProjectDescription")}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-4 py-5 sm:px-6">
      <header className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {t("board.title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("board.subtitle")}
        </p>
      </header>
      <div className="min-h-0 flex-1">
        <BoardView
          items={items}
          isLoading={isLoading}
          error={error}
          schemesByProject={schemesByProject}
          keyByProject={keyByProject}
          workflows={templates}
          concurrencyDegree={queue?.concurrencyDegree ?? 1}
        />
      </div>
    </div>
  );
}
