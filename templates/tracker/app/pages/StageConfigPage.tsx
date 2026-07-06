import { useState } from "react";
import { Link, useParams } from "react-router";
import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useProjects } from "@/hooks/use-tracker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconDeviceFloppy,
  IconInfoCircle,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import type {
  OrchestratorWorkflowSummary,
  StageConfigResponse,
  StageFlow,
  StageVocabularyEntry,
} from "@shared/types";

// The 5 work-item types the Type Assignment tab lets an admin route to a
// flow. 集合 (epic, a container of children) and from-audit (a special
// audit-triggered path) are intentionally excluded — neither creates a
// standalone plannedStages via create-work-item.ts's type-assignment lookup
// the way these 5 do.
const ASSIGNABLE_TYPES = ["需求", "任务", "缺陷", "测试", "生产问题"];

const NONE_VALUE = "__none__";

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

// ---------------------------------------------------------------------------
// Info banner — shown above all 3 tabs, exact copy from the approved design.
// ---------------------------------------------------------------------------
function StageConfigBanner() {
  return (
    <Alert className="mb-5">
      <IconInfoCircle className="size-4" />
      <AlertDescription>
        此处的改动仅对<strong>新建</strong>
        的工作项生效；已在进行中的工作项将继续使用创建时分配的阶段顺序，不会被追溯改变。
      </AlertDescription>
    </Alert>
  );
}

// ---------------------------------------------------------------------------
// Tab 1: Stage Vocabulary
// ---------------------------------------------------------------------------
function VocabRow({
  entry,
  onSave,
  saving,
}: {
  entry: StageVocabularyEntry;
  onSave: (patch: {
    description: string;
    requireArtifacts: boolean;
    requireApproval: boolean;
    requireGraphValid: boolean;
  }) => void;
  saving: boolean;
}) {
  const [description, setDescription] = useState(entry.description);
  const [requireArtifacts, setRequireArtifacts] = useState(
    entry.requireArtifacts,
  );
  const [requireApproval, setRequireApproval] = useState(entry.requireApproval);
  const [requireGraphValid, setRequireGraphValid] = useState(
    entry.requireGraphValid,
  );

  const dirty =
    description !== entry.description ||
    requireArtifacts !== entry.requireArtifacts ||
    requireApproval !== entry.requireApproval ||
    requireGraphValid !== entry.requireGraphValid;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="min-w-[120px] pt-1 text-[15px] font-semibold">
            {entry.name}
          </div>
          <div className="flex flex-shrink-0 gap-5">
            <div className="flex flex-col items-center gap-1.5">
              <Switch
                checked={requireArtifacts}
                onCheckedChange={setRequireArtifacts}
              />
              <span className="text-center text-[10.5px] leading-tight text-muted-foreground">
                需要
                <br />
                交付物
              </span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Switch
                checked={requireApproval}
                onCheckedChange={setRequireApproval}
              />
              <span className="text-center text-[10.5px] leading-tight text-muted-foreground">
                需要
                <br />
                审批
              </span>
            </div>
            <div className="flex flex-col items-center gap-1.5">
              <Switch
                checked={requireGraphValid}
                onCheckedChange={setRequireGraphValid}
              />
              <span className="text-center text-[10.5px] leading-tight text-muted-foreground">
                需要
                <br />
                图有效
              </span>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">阶段说明</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="这个阶段的目的是什么？"
            className="text-sm"
          />
        </div>
        {dirty ? (
          <div className="flex justify-end">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={saving}
              onClick={() =>
                onSave({
                  description,
                  requireArtifacts,
                  requireApproval,
                  requireGraphValid,
                })
              }
            >
              {saving ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconDeviceFloppy className="size-3.5" />
              )}
              保存
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VocabularyTab({
  projectId,
  vocabulary,
  isLoading,
}: {
  projectId: string;
  vocabulary: StageVocabularyEntry[];
  isLoading: boolean;
}) {
  const qc = useQueryClient();
  const [savingName, setSavingName] = useState<string | null>(null);
  const updateVocabulary = useActionMutation("update-stage-vocabulary", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-stage-config"] });
      toast.success("阶段词汇已保存");
      setSavingName(null);
    },
    onError: (err: unknown) => {
      toast.error(messageOf(err, "保存失败"));
      setSavingName(null);
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {vocabulary.map((entry) => (
        <VocabRow
          key={entry.name}
          entry={entry}
          saving={updateVocabulary.isPending && savingName === entry.name}
          onSave={(patch) => {
            setSavingName(entry.name);
            updateVocabulary.mutate({ projectId, name: entry.name, ...patch });
          }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 2: Flows
// ---------------------------------------------------------------------------
function DispatchTemplateSelect({
  value,
  workflows,
  onChange,
}: {
  value: string;
  workflows: OrchestratorWorkflowSummary[];
  onChange: (next: string) => void;
}) {
  // If the orchestrator's workflow list couldn't be fetched (or is empty),
  // fall back to free text so a template name can still be configured.
  if (workflows.length === 0) {
    return (
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="无分发（留空）"
        className="h-8 font-mono text-xs"
      />
    );
  }
  const knownIds = new Set(workflows.map((w) => w.id));
  return (
    <Select
      value={value ? value : NONE_VALUE}
      onValueChange={(v) => onChange(v === NONE_VALUE ? "" : v)}
    >
      <SelectTrigger className="h-8 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE}>无分发</SelectItem>
        {/* Preserve an existing value even if it's no longer in the fetched list. */}
        {value && !knownIds.has(value) ? (
          <SelectItem value={value}>{value}</SelectItem>
        ) : null}
        {workflows.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FlowCard({
  flow,
  usedByTypes,
  workflows,
  onSaveDispatchTemplate,
  onDelete,
  deleting,
}: {
  flow: StageFlow;
  usedByTypes: string[];
  workflows: OrchestratorWorkflowSummary[];
  onSaveDispatchTemplate: (stageName: string, template: string) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <Card>
      <CardContent className="p-4">
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex flex-1 items-center gap-2 text-left text-sm font-semibold"
              >
                {open ? (
                  <IconChevronDown className="size-4 flex-shrink-0 text-muted-foreground" />
                ) : (
                  <IconChevronRight className="size-4 flex-shrink-0 text-muted-foreground" />
                )}
                <span>{flow.name}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {flow.stageNames.length} 个阶段
                  {usedByTypes.length > 0
                    ? ` · 用于 ${usedByTypes.join("、")}`
                    : ""}
                </span>
              </button>
            </CollapsibleTrigger>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 flex-shrink-0 text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
              aria-label="删除流程"
            >
              <IconTrash className="size-3.5" />
            </Button>
          </div>
          <CollapsibleContent className="mt-3.5 border-t border-border pt-3.5">
            <div className="mb-4 flex flex-wrap items-center gap-1.5">
              {flow.stageNames.map((name, i) => (
                <span
                  key={`${name}-${i}`}
                  className="flex items-center gap-1.5"
                >
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium">
                    {name}
                  </span>
                  {i < flow.stageNames.length - 1 ? (
                    <IconArrowRight className="size-3.5 text-muted-foreground/60" />
                  ) : null}
                </span>
              ))}
            </div>
            <div className="mb-2 text-xs text-muted-foreground">
              配置工作项进入每个阶段时要分发的工作流模板
            </div>
            <div className="flex flex-col gap-2">
              {flow.stageNames.map((name, i) => (
                <div
                  key={`${name}-${i}`}
                  className="grid grid-cols-[24px_1fr_200px] items-center gap-3 rounded-md bg-muted/40 px-2.5 py-2"
                >
                  <span className="text-center text-[11px] text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="text-sm">{name}</span>
                  <DispatchTemplateSelect
                    value={flow.dispatchTemplates?.[name] ?? ""}
                    workflows={workflows}
                    onChange={(next) => onSaveDispatchTemplate(name, next)}
                  />
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除流程</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除流程「{flow.name}
              」吗？使用此流程的工作项类型分配将被清除（恢复为默认逻辑）。已创建的工作项不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleting}
              onClick={() => {
                onDelete();
                setConfirmDelete(false);
              }}
            >
              {deleting ? (
                <IconLoader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function NewFlowBuilder({
  projectId,
  vocabulary,
}: {
  projectId: string;
  vocabulary: StageVocabularyEntry[];
}) {
  const qc = useQueryClient();
  const [chosen, setChosen] = useState<string[]>([]);
  const [flowName, setFlowName] = useState("");
  const [customStage, setCustomStage] = useState("");

  const saveFlow = useActionMutation("save-stage-flow", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-stage-config"] });
      toast.success("流程已创建");
      setChosen([]);
      setFlowName("");
    },
    onError: (err: unknown) => toast.error(messageOf(err, "创建流程失败")),
  });

  const availableNames = vocabulary
    .map((v) => v.name)
    .filter((n) => !chosen.includes(n));

  function addToChosen(name: string) {
    if (!chosen.includes(name)) setChosen((prev) => [...prev, name]);
  }
  function removeFromChosen(name: string) {
    setChosen((prev) => prev.filter((n) => n !== name));
  }
  function move(index: number, dir: -1 | 1) {
    setChosen((prev) => {
      const next = [...prev];
      const target = index + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }
  function addCustomStage() {
    const name = customStage.trim();
    if (!name) return;
    addToChosen(name);
    setCustomStage("");
  }
  function handleCreate() {
    if (!flowName.trim() || chosen.length === 0) return;
    saveFlow.mutate({ projectId, name: flowName.trim(), stageNames: chosen });
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-1 text-sm font-semibold">+ 新建流程</div>
        <p className="mb-3.5 text-xs text-muted-foreground">
          从阶段词汇中选择并排序，组成一个新的可复用流程。
        </p>
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              可选阶段
            </div>
            <div className="flex min-h-[140px] flex-col gap-1.5 rounded-md border border-border p-2.5">
              {availableNames.length === 0 ? (
                <div className="p-2 text-xs text-muted-foreground">
                  全部阶段词汇均已加入
                </div>
              ) : (
                availableNames.map((name) => (
                  <div
                    key={name}
                    className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2.5 py-1.5 text-sm"
                  >
                    <span>{name}</span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      aria-label="加入流程"
                      onClick={() => addToChosen(name)}
                    >
                      <IconChevronRight className="size-3.5" />
                    </Button>
                  </div>
                ))
              )}
              <div className="mt-1 flex gap-1.5">
                <Input
                  value={customStage}
                  onChange={(e) => setCustomStage(e.target.value)}
                  placeholder="自定义阶段名…"
                  className="h-7 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustomStage();
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 flex-shrink-0 gap-1 px-2 text-xs"
                  onClick={addCustomStage}
                >
                  <IconPlus className="size-3.5" />
                  添加
                </Button>
              </div>
            </div>
          </div>
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              已选顺序
            </div>
            <div className="flex min-h-[140px] flex-col gap-1.5 rounded-md border border-border p-2.5">
              {chosen.length === 0 ? (
                <div className="p-2 text-xs text-muted-foreground">
                  从左侧选择阶段加入流程
                </div>
              ) : (
                chosen.map((name, i) => (
                  <div
                    key={`${name}-${i}`}
                    className="flex items-center justify-between gap-2 rounded bg-muted/50 px-2.5 py-1.5 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 text-right text-[11px] text-muted-foreground">
                        {i + 1}
                      </span>
                      {name}
                    </span>
                    <span className="flex gap-0.5">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label="上移"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <IconChevronUp className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label="下移"
                        disabled={i === chosen.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <IconChevronDown className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6"
                        aria-label="移除"
                        onClick={() => removeFromChosen(name)}
                      >
                        <IconX className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label className="text-xs">流程名称</Label>
            <Input
              value={flowName}
              onChange={(e) => setFlowName(e.target.value)}
              placeholder="例如：紧急发布流程"
            />
          </div>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={
              saveFlow.isPending || !flowName.trim() || chosen.length === 0
            }
            onClick={handleCreate}
          >
            {saveFlow.isPending ? (
              <IconLoader2 className="size-3.5 animate-spin" />
            ) : (
              <IconPlus className="size-3.5" />
            )}
            创建流程
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function FlowsTab({
  projectId,
  flows,
  vocabulary,
  typeAssignment,
  workflows,
  isLoading,
}: {
  projectId: string;
  flows: StageFlow[];
  vocabulary: StageVocabularyEntry[];
  typeAssignment: Record<string, string>;
  workflows: OrchestratorWorkflowSummary[];
  isLoading: boolean;
}) {
  const qc = useQueryClient();
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["action", "get-stage-config"] });

  const saveFlow = useActionMutation("save-stage-flow", {
    onSuccess: invalidate,
    onError: (err: unknown) => toast.error(messageOf(err, "保存分发模板失败")),
  });
  const deleteFlow = useActionMutation("delete-stage-flow", {
    onSuccess: () => {
      invalidate();
      toast.success("流程已删除");
    },
    onError: (err: unknown) => toast.error(messageOf(err, "删除流程失败")),
  });

  if (isLoading) {
    return <Skeleton className="h-40 w-full rounded-xl" />;
  }

  const typesForFlow = (flowId: string) =>
    Object.entries(typeAssignment)
      .filter(([, v]) => v === flowId)
      .map(([type]) => type);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {flows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            暂无流程，在下方创建第一个流程
          </div>
        ) : (
          flows.map((flow) => (
            <FlowCard
              key={flow.id}
              flow={flow}
              usedByTypes={typesForFlow(flow.id)}
              workflows={workflows}
              deleting={deleteFlow.isPending}
              onDelete={() => deleteFlow.mutate({ projectId, id: flow.id })}
              onSaveDispatchTemplate={(stageName, template) =>
                saveFlow.mutate({
                  projectId,
                  id: flow.id,
                  name: flow.name,
                  stageNames: flow.stageNames,
                  dispatchTemplates: { [stageName]: template },
                })
              }
            />
          ))
        )}
      </div>
      <NewFlowBuilder projectId={projectId} vocabulary={vocabulary} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab 3: Type Assignment
// ---------------------------------------------------------------------------
function TypeAssignmentTab({
  projectId,
  flows,
  typeAssignment,
  isLoading,
}: {
  projectId: string;
  flows: StageFlow[];
  typeAssignment: Record<string, string>;
  isLoading: boolean;
}) {
  const qc = useQueryClient();
  const updateAssignment = useActionMutation("update-stage-type-assignment", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "get-stage-config"] });
    },
    onError: (err: unknown) => toast.error(messageOf(err, "更新类型分配失败")),
  });

  if (isLoading) {
    return <Skeleton className="h-52 w-full rounded-xl" />;
  }

  return (
    <div>
      <p className="mb-3.5 text-sm text-muted-foreground">
        不同工作项类型使用不同流程 —
        新建工作项时，系统按其类型选择下面配置的流程，并在创建时把该流程的阶段顺序写入该工作项。
      </p>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>工作项类型</TableHead>
              <TableHead>使用的流程</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ASSIGNABLE_TYPES.map((type) => (
              <TableRow key={type}>
                <TableCell>
                  <Badge variant="outline">{type}</Badge>
                </TableCell>
                <TableCell className="max-w-[280px]">
                  <Select
                    value={typeAssignment[type] ?? NONE_VALUE}
                    onValueChange={(v) =>
                      updateAssignment.mutate({
                        projectId,
                        type,
                        flowId: v === NONE_VALUE ? null : v,
                      })
                    }
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE_VALUE}>未配置（默认）</SelectItem>
                      {flows.map((flow) => (
                        <SelectItem key={flow.id} value={flow.id}>
                          {flow.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export function StageConfigPage() {
  const { id = "" } = useParams();
  const { data: projectsData, isLoading: projectsLoading } = useProjects();
  const projects = Array.isArray(projectsData) ? projectsData : [];
  const project = projects.find((p) => p.id === id);

  const { data: config, isLoading: configLoading } = useActionQuery(
    "get-stage-config",
    { projectId: id },
    { enabled: !!id },
  ) as { data?: StageConfigResponse; isLoading: boolean };

  const { data: workflowsData } = useActionQuery(
    "list-orchestrator-workflows",
    {},
    { enabled: !!id },
  ) as { data?: OrchestratorWorkflowSummary[] };

  const vocabulary = config?.vocabulary ?? [];
  const flows = config?.flows ?? [];
  const typeAssignment = config?.typeAssignment ?? {};
  const workflows = Array.isArray(workflowsData) ? workflowsData : [];

  return (
    <div className="mx-auto max-w-4xl p-5 sm:p-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-4 gap-1.5">
        <Link to={`/projects/${id}`}>
          <IconArrowLeft className="size-4" /> 返回项目设置
        </Link>
      </Button>

      {projectsLoading && !project ? (
        <div className="space-y-4">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      ) : !project ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">
          项目不存在或无权访问
        </div>
      ) : (
        <>
          <div className="mb-1 flex items-center gap-3">
            <span className="inline-flex h-6 items-center rounded bg-muted px-2 font-mono text-xs font-semibold text-muted-foreground">
              {(project as any).key}
            </span>
            <h1 className="text-xl font-semibold">{project.name} · 阶段配置</h1>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">
            配置该项目的阶段词汇、可复用的执行流程，以及不同工作项类型使用的流程。
          </p>

          <StageConfigBanner />

          <Tabs defaultValue="vocab">
            <TabsList className="mb-4">
              <TabsTrigger value="vocab">阶段词汇</TabsTrigger>
              <TabsTrigger value="flows">流程</TabsTrigger>
              <TabsTrigger value="assign">类型分配</TabsTrigger>
            </TabsList>
            <TabsContent value="vocab">
              <VocabularyTab
                projectId={id}
                vocabulary={vocabulary}
                isLoading={configLoading}
              />
            </TabsContent>
            <TabsContent value="flows">
              <FlowsTab
                projectId={id}
                flows={flows}
                vocabulary={vocabulary}
                typeAssignment={typeAssignment}
                workflows={workflows}
                isLoading={configLoading}
              />
            </TabsContent>
            <TabsContent value="assign">
              <TypeAssignmentTab
                projectId={id}
                flows={flows}
                typeAssignment={typeAssignment}
                isLoading={configLoading}
              />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
