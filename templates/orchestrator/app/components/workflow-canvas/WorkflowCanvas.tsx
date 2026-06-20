import { useCallback, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type OnSelectionChangeParams,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTranslation } from "react-i18next";
import {
  IconCode,
  IconDeviceFloppy,
  IconLayoutGrid,
  IconPlayerPlay,
  IconChecks,
  IconCopyPlus,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import type { TemplateListItem } from "@/hooks/use-templates";
import type { Edge, Node, NodeType } from "../../../shared/types";
import {
  addEdge,
  addNode,
  graphForSave,
  makeLibraryNode,
  makeNode,
  removeEdge,
  removeNode,
  setPosition,
  toFlowEdges,
  toFlowNodes,
  updateEdge,
  updateNode,
  validateGraph,
  type FlowNode,
  type WorkflowGraphModel,
} from "@/lib/workflow-graph-model";
import { isContainerType } from "@/lib/node-meta";
import { cn } from "@/lib/utils";
import { nodeTypes } from "./nodes";
import { edgeTypes } from "./WhenEdge";
import { Palette, DND_MIME, type PaletteDragPayload } from "./Palette";
import { Inspector } from "./Inspector";
import { ValidationBanner } from "./ValidationBanner";
import { JsonView } from "./JsonView";

// ONE canvas, two modes (FRONTEND §6.3). P4a wires mode="edit"; mode="run" is a
// clean seam consumed by P4b (the run overlay tints nodes by NodeRun status and
// disables editing). The whole editor is built around ONE in-memory
// WorkflowGraphModel — the canvas, the inspector, and the JSON view all read and
// write that single object; React Flow nodes/edges are derived from it on render.

export interface WorkflowCanvasProps {
  mode: "edit" | "run";
  model: WorkflowGraphModel;
  onModelChange: (model: WorkflowGraphModel) => void;
  templates?: TemplateListItem[];
  // ── edit-mode toolbar wiring ──
  onSave?: () => void;
  onSaveAsNew?: () => void;
  onRunOnce?: () => void;
  saving?: boolean;
  /** run-mode seam: status tints keyed by graph node id (P4b fills this). */
  runStatusByNodeId?: Record<string, string>;
  /** run-mode seam: loop iteration counter per node id (0 outside loops). */
  iterationByNodeId?: Record<string, number>;
  /** run-mode seam: true when a node was dynamically added at run time. */
  dynamicByNodeId?: Record<string, boolean>;
  /** run-mode: notified when a node is clicked (writes application_state). */
  onSelectNode?: (nodeId: string | null) => void;
}

function CanvasInner({
  mode,
  model,
  onModelChange,
  templates = [],
  onSave,
  onSaveAsNew,
  onRunOnce,
  saving,
  runStatusByNodeId,
  iterationByNodeId,
  dynamicByNodeId,
  onSelectNode,
}: WorkflowCanvasProps) {
  const { t } = useTranslation();
  const editable = mode === "edit";
  const { screenToFlowPosition } = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);

  // The SINGLE validator — the exact function save-template calls (re-exported
  // from shared/graph-validator via the model module). Recomputed on every edit.
  const validation = useMemo(() => validateGraph(model.graph), [model.graph]);

  // Derive React Flow nodes/edges from the in-memory model on every render.
  const flowNodes = useMemo<FlowNode[]>(() => {
    const base = toFlowNodes(model, { selectedId: selectedNodeId, editable });
    if (!runStatusByNodeId && !iterationByNodeId && !dynamicByNodeId) {
      return base;
    }
    return base.map((n) => ({
      ...n,
      data: {
        ...n.data,
        runStatus: runStatusByNodeId?.[n.id],
        iteration: iterationByNodeId?.[n.id],
        dynamic: dynamicByNodeId?.[n.id],
      },
    }));
  }, [
    model,
    selectedNodeId,
    editable,
    runStatusByNodeId,
    iterationByNodeId,
    dynamicByNodeId,
  ]);

  const flowEdges = useMemo(
    () => toFlowEdges(model, { editable }),
    [model, editable],
  );

  const selectedNode = useMemo<Node | null>(
    () => model.graph.nodes.find((n) => n.id === selectedNodeId) ?? null,
    [model.graph.nodes, selectedNodeId],
  );
  const selectedEdge = useMemo<Edge | null>(
    () => model.graph.edges.find((e) => e.id === selectedEdgeId) ?? null,
    [model.graph.edges, selectedEdgeId],
  );

  const nodeIds = useMemo(
    () => model.graph.nodes.map((n) => n.id),
    [model.graph.nodes],
  );

  // ── interactions (edit mode) ──────────────────────────────────────────────

  const onConnect = useCallback(
    (c: Connection) => {
      if (!editable || !c.source || !c.target) return;
      onModelChange(addEdge(model, c.source, c.target));
    },
    [editable, model, onModelChange],
  );

  const onNodeDragStop = useCallback(
    (_e: unknown, node: FlowNode) => {
      if (!editable) return;
      onModelChange(setPosition(model, node.id, node.position));
    },
    [editable, model, onModelChange],
  );

  const onSelectionChange = useCallback(
    ({ nodes, edges }: OnSelectionChangeParams) => {
      const node = nodes[0];
      const edge = edges[0];
      setSelectedNodeId(node ? node.id : null);
      setSelectedEdgeId(!node && edge ? edge.id : null);
      onSelectNode?.(node ? node.id : null);
    },
    [onSelectNode],
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  // Which container (if any) does this drop point fall inside? Used so a node
  // dropped over a parallel/loop/fanout frame becomes its child (parentNode).
  const containerAt = useCallback(
    (pos: XYPosition): string | undefined => {
      for (const n of model.graph.nodes) {
        if (!isContainerType(n.type)) continue;
        const p = model.positions[n.id];
        if (!p) continue;
        // container frames default to ~320×220 until resized
        if (
          pos.x >= p.x &&
          pos.x <= p.x + 320 &&
          pos.y >= p.y &&
          pos.y <= p.y + 220
        ) {
          return n.id;
        }
      }
      return undefined;
    },
    [model],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!editable) return;
      e.preventDefault();
      const raw = e.dataTransfer.getData(DND_MIME);
      if (!raw) return;
      let payload: PaletteDragPayload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const parentId = containerAt(flowPos);
      const node =
        payload.kind === "library"
          ? makeLibraryNode(
              payload.defKey ?? "node",
              payload.defKind ?? "agent",
              payload.defTitle ?? payload.defKey ?? "node",
            )
          : makeNode(payload.nodeType as NodeType);
      // child position is relative to the parent frame origin
      const pos = parentId
        ? {
            x: flowPos.x - (model.positions[parentId]?.x ?? 0),
            y: flowPos.y - (model.positions[parentId]?.y ?? 0),
          }
        : flowPos;
      const next = addNode(model, node, pos, parentId);
      onModelChange(next);
      setSelectedNodeId(node.id);
      setSelectedEdgeId(null);
    },
    [editable, screenToFlowPosition, containerAt, model, onModelChange],
  );

  // ── inspector patch wiring ────────────────────────────────────────────────

  const patchNode = useCallback(
    (patch: Partial<Node>) => {
      if (!selectedNodeId) return;
      onModelChange(updateNode(model, selectedNodeId, patch));
    },
    [selectedNodeId, model, onModelChange],
  );
  const patchEdge = useCallback(
    (patch: Partial<Edge>) => {
      if (!selectedEdgeId) return;
      onModelChange(updateEdge(model, selectedEdgeId, patch));
    },
    [selectedEdgeId, model, onModelChange],
  );
  const removeSelectedNode = useCallback(() => {
    if (!selectedNodeId) return;
    onModelChange(removeNode(model, selectedNodeId));
    setSelectedNodeId(null);
  }, [selectedNodeId, model, onModelChange]);
  const removeSelectedEdge = useCallback(() => {
    if (!selectedEdgeId) return;
    onModelChange(removeEdge(model, selectedEdgeId));
    setSelectedEdgeId(null);
  }, [selectedEdgeId, model, onModelChange]);

  const blockedSave = !validation.ok;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      {editable ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <Button
            size="sm"
            onClick={onSave}
            disabled={saving || blockedSave}
            title={blockedSave ? t("flow.saveBlocked") : undefined}
          >
            <IconDeviceFloppy className="size-4" />
            {t("common.save")}
          </Button>
          <Button size="sm" variant="outline" onClick={onSaveAsNew}>
            <IconCopyPlus className="size-4" />
            {t("flow.saveAsNew")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRunOnce}
            disabled={blockedSave}
          >
            <IconPlayerPlay className="size-4" />
            {t("flow.runOnce")}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <IconChecks className="size-3.5" />
              {validation.ok
                ? t("flow.validClean")
                : t("flow.validErrors", { count: validation.errors.length })}
            </span>
            <Button
              size="sm"
              variant={showJson ? "default" : "outline"}
              onClick={() => setShowJson((s) => !s)}
            >
              {showJson ? (
                <IconLayoutGrid className="size-4" />
              ) : (
                <IconCode className="size-4" />
              )}
              {showJson ? t("flow.canvasView") : t("flow.jsonView")}
            </Button>
          </div>
        </div>
      ) : null}

      {/* validation banner */}
      {editable && (!validation.ok || validation.warnings.length > 0) ? (
        <div className="border-b border-border px-3 py-2">
          <ValidationBanner result={validation} />
        </div>
      ) : null}

      {/* three-pane body */}
      <div className="flex min-h-0 flex-1">
        {editable && !showJson ? (
          <aside className="hidden w-52 shrink-0 border-r border-border md:block">
            <Palette />
          </aside>
        ) : null}

        <div className="relative min-w-0 flex-1" ref={wrapperRef}>
          {showJson ? (
            <JsonView model={model} onChange={onModelChange} />
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onConnect={onConnect}
              onNodeDragStop={onNodeDragStop}
              onSelectionChange={onSelectionChange}
              onDrop={onDrop}
              onDragOver={onDragOver}
              nodesDraggable={editable}
              nodesConnectable={editable}
              elementsSelectable
              fitView
              proOptions={{ hideAttribution: true }}
              className={cn(!editable && "pointer-events-auto")}
            >
              <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
              <Controls showInteractive={editable} />
              <MiniMap pannable zoomable className="!hidden lg:!block" />
            </ReactFlow>
          )}
        </div>

        {editable && !showJson ? (
          <aside className="hidden w-72 shrink-0 border-l border-border lg:block">
            <Inspector
              node={selectedNode}
              selectedEdge={selectedEdge}
              nodeIds={nodeIds}
              templates={templates}
              onPatchNode={patchNode}
              onPatchEdge={patchEdge}
              onRemoveNode={removeSelectedNode}
              onRemoveEdge={removeSelectedEdge}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

/** Public component — wraps the inner canvas in a ReactFlowProvider so
 *  `screenToFlowPosition` (drop coordinates) and the store are available. */
export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

/** Re-export the save-shaped graph helper so the route can persist the model. */
export { graphForSave };
