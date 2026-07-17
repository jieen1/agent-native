import {
  useActionMutation,
  useActionQuery,
  callAction,
} from "@agent-native/core/client";
import {
  IconArrowLeft,
  IconCircleCheck,
  IconDeviceFloppy,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

import { DispatchGradeBadge } from "./DispatchGradeBadge";
import { DispatchGradeCheckPanel } from "./DispatchGradeCheckPanel";
import {
  blankNode,
  groupErrorsByNode,
  nextNodeId,
  renameNodeId,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./workflow-dag-types";
import type {
  DispatchGradeLintResult,
  WorkflowVersionRow,
} from "./workflow-library-types";
import { WorkflowDagPreview } from "./WorkflowDagPreview";
import { WorkflowDiffDialog } from "./WorkflowDiffDialog";
import { WorkflowNodeDetail } from "./WorkflowNodeDetail";
import { WorkflowNodeList } from "./WorkflowNodeList";
import { WorkflowVersionChain } from "./WorkflowVersionChain";

interface LocationPrefill {
  name?: string;
  description?: string;
  dag?: { nodes: WorkflowNode[] };
}

export interface WorkflowEditorProps {
  /** Existing template id — omit/null for "create a new template" mode. */
  templateId?: string | null;
}

const DEFAULT_INPUT_SCHEMA = { type: "object", properties: {} };
const VALIDATE_DEBOUNCE_MS = 400;

export function WorkflowEditor({ templateId }: WorkflowEditorProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const prefill = (location.state as LocationPrefill | null) ?? null;

  const isEdit = !!templateId;
  const {
    data: loaded,
    isLoading,
    error: loadError,
  } = useActionQuery(
    "workflowGet" as any,
    { idOrName: templateId },
    { enabled: isEdit },
  ) as {
    data?: {
      id: string;
      name: string;
      version: number;
      description: string | null;
      dag: unknown;
      inputSchema: unknown;
    };
    isLoading: boolean;
    error?: unknown;
  };

  const { data: agentDefs = [] } = useActionQuery(
    "list-agent-defs" as any,
    {},
    undefined,
  ) as { data?: Array<{ name: string }> };
  const agentOptions = useMemo(
    () => agentDefs.map((a) => ({ name: a.name })),
    [agentDefs],
  );

  // ── Version lineage + diff-vs-previous (r4 doc §4.5 gap #3 — same data/
  // components the library page already renders, s8b-workflow-detail.html
  // §7). Only meaningful once a saved template is loaded — a brand-new
  // unsaved template has no version history yet. ───────────────────────────
  const { data: versions = [], isLoading: versionsLoading } = useActionQuery(
    "workflowVersions" as any,
    { name: loaded?.name ?? "" },
    { enabled: isEdit && !!loaded?.name },
  ) as { data?: WorkflowVersionRow[]; isLoading: boolean };
  const [diffOpen, setDiffOpen] = useState(false);

  const saveAction = useActionMutation("workflowSave" as any, {});

  // ── Editable draft state ────────────────────────────────────────────────
  const [name, setName] = useState(prefill?.name ?? "");
  const [description, setDescription] = useState(prefill?.description ?? "");
  const [nodes, setNodes] = useState<WorkflowNode[]>(prefill?.dag?.nodes ?? []);
  const [inputSchema, setInputSchema] = useState<unknown>(DEFAULT_INPUT_SCHEMA);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    prefill?.dag?.nodes?.[0]?.id ?? null,
  );
  const initializedFromLoad = useRef(false);

  useEffect(() => {
    if (!loaded || initializedFromLoad.current) return;
    initializedFromLoad.current = true;
    setName(loaded.name);
    setDescription(loaded.description ?? "");
    const loadedNodes = Array.isArray((loaded.dag as any)?.nodes)
      ? ((loaded.dag as any).nodes as WorkflowNode[])
      : [];
    setNodes(loadedNodes);
    setInputSchema(loaded.inputSchema ?? DEFAULT_INPUT_SCHEMA);
    setSelectedNodeId(loadedNodes[0]?.id ?? null);
  }, [loaded]);

  // ── Live validation (debounced) ─────────────────────────────────────────
  const [validation, setValidation] = useState<{
    ok: boolean;
    errors: string[];
  } | null>(null);
  const [validating, setValidating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setValidating(true);
    const timer = setTimeout(async () => {
      try {
        const result = await callAction<{ ok: boolean; errors: string[] }>(
          "validateDag" as any,
          { dag: { nodes } },
        );
        if (!cancelled) setValidation(result);
      } catch {
        // Swallow transient validate failures — Save still runs the real
        // check server-side and will surface a hard error if truly invalid.
      } finally {
        if (!cancelled) setValidating(false);
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes]);

  // ── Live dispatch-grade lint (debounced, 04 §4.2 — the 7-rule check) ────
  const [dispatchGrade, setDispatchGrade] =
    useState<DispatchGradeLintResult | null>(null);
  const [dispatchGradeLoading, setDispatchGradeLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDispatchGradeLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await callAction<DispatchGradeLintResult>(
          "dagDispatchGradeLint" as any,
          { dag: { nodes }, inputSchema },
        );
        if (!cancelled) setDispatchGrade(result);
      } catch {
        // Same fail-soft posture as the validateDag debounce above — a
        // transient lint failure must not block editing.
      } finally {
        if (!cancelled) setDispatchGradeLoading(false);
      }
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nodes, inputSchema]);

  const { byNode: errorsByNode, global: globalErrors } = useMemo(
    () => groupErrorsByNode(validation?.errors ?? []),
    [validation],
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const otherNodeIds = useMemo(
    () => nodes.filter((n) => n.id !== selectedNodeId).map((n) => n.id),
    [nodes, selectedNodeId],
  );

  // ── Node list actions ────────────────────────────────────────────────────
  const handleAddNode = (type: WorkflowNodeType) => {
    const id = nextNodeId(
      nodes.map((n) => n.id),
      type,
    );
    const node = blankNode(type, id);
    setNodes((prev) => [...prev, node]);
    setSelectedNodeId(id);
  };

  const handleDeleteNode = (nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  };

  const handleReorder = (fromIndex: number, toIndex: number) => {
    setNodes((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const handleChangeNode = (next: WorkflowNode) => {
    setNodes((prev) => prev.map((n) => (n.id === selectedNodeId ? next : n)));
  };

  const handleRenameId = (newId: string) => {
    if (!selectedNodeId) return;
    if (nodes.some((n) => n.id === newId)) {
      toast.error(`节点 ID "${newId}" 已存在`);
      return;
    }
    setNodes((prev) => renameNodeId(prev, selectedNodeId, newId));
    setSelectedNodeId(newId);
  };

  // ── Raw JSON tab ─────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<"visual" | "raw">("visual");
  const [rawDraft, setRawDraft] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);

  const openRawTab = () => {
    setRawDraft(JSON.stringify({ nodes }, null, 2));
    setRawError(null);
    setActiveTab("raw");
  };

  const handleRawChange = (text: string) => {
    setRawDraft(text);
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.nodes)) {
        setRawError('必须是包含 "nodes" 数组的对象');
        return;
      }
      setRawError(null);
      setNodes(parsed.nodes);
    } catch (e) {
      setRawError(e instanceof Error ? e.message : "无效 JSON");
    }
  };

  // ── Validate + Save ──────────────────────────────────────────────────────
  const handleValidateClick = async () => {
    try {
      const result = await callAction<{ ok: boolean; errors: string[] }>(
        "validateDag" as any,
        { dag: { nodes } },
      );
      setValidation(result);
      if (result.ok) toast.success("DAG 校验通过");
      else toast.error(`发现 ${result.errors.length} 个问题`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "校验失败");
    }
  };

  const handleSave = () => {
    if (!name.trim()) {
      toast.error("请输入模板名称");
      return;
    }
    saveAction.mutate(
      {
        name: name.trim(),
        dag: { nodes },
        inputSchema,
        description: description.trim() || undefined,
      },
      {
        onSuccess: (result: any) => {
          toast.success(isEdit ? "已保存新版本" : "模板已创建");
          navigate(`/workflows/${result.id}`, { replace: true });
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : "保存失败");
        },
      },
    );
  };

  // ── Render ───────────────────────────────────────────────────────────────

  if (isEdit && isLoading) {
    return (
      <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 sm:py-8">
        <Skeleton className="mb-4 h-5 w-48" />
        <Skeleton className="h-[680px] w-full rounded-lg" />
      </div>
    );
  }

  if (isEdit && (loadError || !loaded)) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          未找到该工作流模板，或加载失败。
        </div>
        <Button asChild variant="ghost" size="sm" className="mt-4 -ml-2">
          <Link to="/workflows">
            <IconArrowLeft className="size-4" />
            工作流列表
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-7 px-2">
          <Link to="/workflows">
            <IconArrowLeft className="size-3.5" />
            工作流列表
          </Link>
        </Button>
        <span className="text-muted-foreground/50">/</span>
        <span className="font-medium text-foreground">
          {name || (isEdit ? "未命名模板" : "新建模板")}
          {isEdit && loaded ? ` v${loaded.version}` : ""}
        </span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="模板名称"
            className="h-8 w-64 border-transparent bg-transparent text-base font-semibold hover:border-input hover:bg-background focus-visible:border-input focus-visible:bg-background"
            aria-label="模板名称"
          />
          {isEdit && loaded ? (
            <Badge variant="secondary" className="font-mono">
              v{loaded.version}
            </Badge>
          ) : null}
          {validation && !validation.ok ? (
            <Badge variant="destructive" className="gap-1">
              <IconAlertTriangle className="size-3" />
              {validation.errors.length} 个问题
            </Badge>
          ) : validation?.ok ? (
            <Badge
              variant="secondary"
              className="gap-1 text-emerald-700 dark:text-emerald-400"
            >
              <IconCircleCheck className="size-3" />
              有效
            </Badge>
          ) : null}
          {dispatchGrade ? (
            <DispatchGradeBadge
              result={dispatchGrade}
              onLocateNode={setSelectedNodeId}
            />
          ) : null}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleValidateClick}
              disabled={validating}
            >
              <IconCircleCheck className="size-3.5" />
              校验
            </Button>
            <Button asChild variant="ghost" size="sm">
              <Link to="/workflows">取消</Link>
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={saveAction.isPending}
            >
              <IconDeviceFloppy className="size-3.5" />
              {saveAction.isPending ? "保存中…" : "保存"}
            </Button>
          </div>
        </div>

        {globalErrors.length > 0 ? (
          <div className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {globalErrors.join(" · ")}
          </div>
        ) : null}

        {isEdit && loaded ? (
          <div className="border-b border-border bg-card px-4 py-3">
            <WorkflowVersionChain
              name={loaded.name}
              versions={versions}
              isLoading={versionsLoading}
              onOpenDiff={() => setDiffOpen(true)}
            />
          </div>
        ) : null}

        <Tabs
          value={activeTab}
          onValueChange={(v) =>
            v === "raw" ? openRawTab() : setActiveTab("visual")
          }
        >
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
            <TabsList className="h-8">
              <TabsTrigger value="visual" className="text-xs">
                可视化
              </TabsTrigger>
              <TabsTrigger value="raw" className="text-xs">
                Raw JSON
              </TabsTrigger>
            </TabsList>
            <span className="text-xs text-muted-foreground">
              Raw JSON 与可视化编辑器自动同步，可直接编辑。
            </span>
          </div>

          <TabsContent value="visual" className="m-0 overflow-x-auto">
            <div className="grid h-[680px] min-w-[900px] grid-cols-[200px_minmax(180px,1fr)_280px_240px]">
              <div className="border-r border-border">
                <WorkflowNodeList
                  nodes={nodes}
                  selectedNodeId={selectedNodeId}
                  errorsByNode={errorsByNode}
                  onSelectNode={setSelectedNodeId}
                  onDeleteNode={handleDeleteNode}
                  onReorder={handleReorder}
                  onAddNode={handleAddNode}
                />
              </div>
              <div className="min-w-0 border-r border-border">
                <WorkflowDagPreview
                  nodes={nodes}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={setSelectedNodeId}
                  errorsByNode={errorsByNode}
                />
              </div>
              <div className="min-w-0 border-r border-border">
                <WorkflowNodeDetail
                  node={selectedNode}
                  otherNodeIds={otherNodeIds}
                  agents={agentOptions}
                  errors={
                    selectedNode ? (errorsByNode[selectedNode.id] ?? []) : []
                  }
                  onChange={handleChangeNode}
                  onRenameId={handleRenameId}
                />
              </div>
              <DispatchGradeCheckPanel
                result={dispatchGrade}
                isLoading={dispatchGradeLoading && !dispatchGrade}
                onLocateNode={setSelectedNodeId}
              />
            </div>
          </TabsContent>

          <TabsContent value="raw" className="m-0 p-4">
            <Textarea
              value={rawDraft}
              onChange={(e) => handleRawChange(e.target.value)}
              spellCheck={false}
              rows={28}
              className="font-mono text-xs"
            />
            {rawError ? (
              <p className="mt-2 text-xs text-destructive">{rawError}</p>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>

      {isEdit && loaded ? (
        <WorkflowDiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          name={loaded.name}
          versions={versions}
        />
      ) : null}
    </div>
  );
}
