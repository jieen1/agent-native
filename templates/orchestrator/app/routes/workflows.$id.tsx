import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { IconArrowLeft, IconDeviceFloppy, IconTrash } from "@tabler/icons-react";
import { toast } from "sonner";
import {
  useDeleteWorkflow,
  useSaveWorkflow,
  useWorkflow,
} from "@/hooks/use-orchestrator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { validateWorkflowDag, type WorkflowStep } from "../../shared/types";

export default function WorkflowEditorRoute() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data, isLoading } = useWorkflow(id);
  const saveWorkflow = useSaveWorkflow();
  const deleteWorkflow = useDeleteWorkflow();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [stepsText, setStepsText] = useState("[]");
  const [stepsError, setStepsError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (data?.workflow && !loaded) {
      setName(data.workflow.name);
      setDescription(data.workflow.description);
      setStepsText(JSON.stringify(data.workflow.steps, null, 2));
      setLoaded(true);
    }
  }, [data, loaded]);

  function validate(text: string): WorkflowStep[] | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setStepsError(t("workflows.invalidJson"));
      return null;
    }
    if (!Array.isArray(parsed)) {
      setStepsError(t("workflows.invalidJson"));
      return null;
    }
    const dag = validateWorkflowDag(parsed as WorkflowStep[]);
    if (!dag.ok) {
      setStepsError(dag.error ?? "Invalid DAG");
      return null;
    }
    setStepsError(null);
    return parsed as WorkflowStep[];
  }

  function handleSave() {
    if (!id) return;
    const steps = validate(stepsText);
    if (!steps) return;
    saveWorkflow.mutate(
      { id, name: name.trim() || t("common.untitled"), description, steps },
      {
        onSuccess: () => toast.success(t("workflows.saved")),
        onError: (e: unknown) =>
          toast.error(e instanceof Error ? e.message : "Failed"),
      },
    );
  }

  function handleDelete() {
    if (!id) return;
    deleteWorkflow.mutate({ id }, { onSuccess: () => navigate("/workflows") });
  }

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <Link
        to="/workflows"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <IconArrowLeft className="size-4" />
        {t("workflows.title")}
      </Link>

      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <label className="text-sm font-medium">
            {t("workflows.nameLabel")}
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("workflows.namePlaceholder")}
          />
        </div>

        <div className="grid gap-1.5">
          <label className="text-sm font-medium">
            {t("workflows.descLabel")}
          </label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>

        <div className="grid gap-1.5">
          <label className="text-sm font-medium">
            {t("workflows.stepsLabel")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("workflows.stepsHint")}
          </p>
          <Textarea
            value={stepsText}
            onChange={(e) => {
              setStepsText(e.target.value);
              setStepsError(null);
            }}
            rows={18}
            spellCheck={false}
            className="font-mono text-xs"
          />
          {stepsError ? (
            <p className="text-xs text-red-600 dark:text-red-400">
              {stepsError}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={handleDelete}>
            <IconTrash className="size-4" />
            {t("common.delete")}
          </Button>
          <Button onClick={handleSave} disabled={saveWorkflow.isPending}>
            <IconDeviceFloppy className="size-4" />
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
