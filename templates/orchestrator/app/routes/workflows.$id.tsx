import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useActionMutation } from "@agent-native/core/client";
import {
  IconArrowLeft,
  IconDeviceFloppy,
  IconTrash,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import {
  useDeleteTemplate,
  useSaveTemplate,
  useTemplate,
} from "@/hooks/use-template";
import { useTemplates } from "@/hooks/use-templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/board/ConfirmDialog";
import {
  WorkflowCanvas,
  graphForSave,
} from "@/components/workflow-canvas/WorkflowCanvas";
import { RunOnceDialog } from "@/components/workflow-canvas/RunOnceDialog";
import {
  modelFromGraph,
  starterModel,
  type WorkflowGraphModel,
} from "@/lib/workflow-graph-model";

export function meta() {
  return [{ title: `${APP_TITLE} — Workflow editor` }];
}

// P4a — the v2 React-Flow DAG editor (FRONTEND §6). Replaces the v1.5 raw-JSON
// <Textarea>; the JSON box is now reachable only as the canvas's JSON-view
// fallback (both edit the SAME in-memory model). Reads get-template, writes
// save-template / delete-template. The whole editor is built around one
// WorkflowGraphModel — canvas, inspector, and JSON view all read/write it.
export default function WorkflowEditorRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data, isLoading, error } = useTemplate(id);
  const { data: templates = [] } = useTemplates();
  const saveTemplate = useSaveTemplate();
  const deleteTemplate = useDeleteTemplate();
  const navAction = useActionMutation("navigate", {});

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [model, setModel] = useState<WorkflowGraphModel | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runOnceOpen, setRunOnceOpen] = useState(false);
  const loadedFor = useRef<string | null>(null);

  // Write application_state so the agent's view-screen knows the editor is open.
  useEffect(() => {
    if (id) navAction.mutate({ view: "workflow", id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Seed the in-memory model from the loaded template exactly once per id.
  useEffect(() => {
    if (!data || loadedFor.current === data.id) return;
    setName(data.name);
    setDescription(data.description);
    setModel(modelFromGraph(data.graph));
    loadedFor.current = data.id;
  }, [data]);

  // A brand-new (just-created) template may have an empty graph; give it a
  // minimal start→end starter so the canvas is never blank.
  useEffect(() => {
    if (model && model.graph.nodes.length === 0) {
      setModel(starterModel());
    }
  }, [model]);

  function persist(asNew: boolean) {
    if (!model) return;
    const graph = graphForSave(model);
    saveTemplate.mutate(
      {
        id: asNew ? undefined : id,
        name: name.trim() || t("common.untitled"),
        description,
        graph,
      },
      {
        onSuccess: (res: unknown) => {
          const newId = (res as { id?: string } | null)?.id;
          const warnings = (res as { warnings?: string[] } | null)?.warnings;
          if (warnings && warnings.length > 0) {
            toast.warning(
              t("flow.savedWithWarnings", { count: warnings.length }),
            );
          } else {
            toast.success(t("flow.saved"));
          }
          if (asNew && newId && newId !== id) {
            navigate(`/workflows/${newId}`);
          }
        },
        onError: (e: unknown) =>
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          ),
      },
    );
  }

  function handleDelete() {
    if (!id) return;
    deleteTemplate.mutate(
      { id },
      {
        onSuccess: () => {
          setDeleteOpen(false);
          navigate("/workflows");
        },
        onError: (e: unknown) => {
          setDeleteOpen(false);
          toast.error(
            e instanceof Error ? e.message : t("common.actionFailed"),
          );
        },
      },
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 text-center text-sm text-muted-foreground">
        {t("flow.loadError")}
        <div className="mt-4">
          <Button asChild variant="outline" size="sm">
            <Link to="/workflows">{t("workflows.title")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header: back · name · description · delete */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Button asChild variant="ghost" size="sm">
          <Link to="/workflows">
            <IconArrowLeft className="size-4" />
            {t("workflows.title")}
          </Link>
        </Button>
        {isLoading || !model ? (
          <Skeleton className="h-8 w-56" />
        ) : (
          <>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("workflows.namePlaceholder")}
              className="h-8 max-w-xs font-medium"
            />
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("workflows.descLabel")}
              className="hidden h-8 max-w-sm text-sm text-muted-foreground md:block"
            />
            {data?.version ? (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                v{data.version}
              </span>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto text-muted-foreground"
              onClick={() => setDeleteOpen(true)}
            >
              <IconTrash className="size-4" />
              {t("common.delete")}
            </Button>
          </>
        )}
      </header>

      {/* the editor canvas */}
      <div className="min-h-0 flex-1">
        {isLoading || !model ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <IconDeviceFloppy className="size-4 animate-pulse" />
              {t("common.loading")}
            </div>
          </div>
        ) : (
          <WorkflowCanvas
            mode="edit"
            model={model}
            onModelChange={setModel}
            templates={templates}
            saving={saveTemplate.isPending}
            onSave={() => persist(false)}
            onSaveAsNew={() => persist(true)}
            onRunOnce={() => setRunOnceOpen(true)}
          />
        )}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("flow.deleteTitle")}
        description={t("flow.deleteBody")}
        confirmLabel={t("common.delete")}
        pending={deleteTemplate.isPending}
        onConfirm={handleDelete}
      />

      {id ? (
        <RunOnceDialog
          open={runOnceOpen}
          onOpenChange={setRunOnceOpen}
          templateId={id}
          templateName={name}
        />
      ) : null}
    </div>
  );
}
