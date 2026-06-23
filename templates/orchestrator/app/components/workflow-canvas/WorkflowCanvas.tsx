// V3: @xyflow/react removed. Graph editor replaced with JSON view.
// Re-export graphForSave from the model module (same function).
import { JsonView } from "./JsonView";
export { graphForSave } from "@/lib/workflow-graph-model";
import type { WorkflowGraphModel } from "@/lib/workflow-graph-model";

export interface WorkflowCanvasProps {
  mode: "edit" | "run";
  model: WorkflowGraphModel;
  onModelChange: (model: WorkflowGraphModel) => void;
  templates?: unknown[];
  onSave?: () => void;
  onSaveAsNew?: () => void;
  onRunOnce?: () => void;
  saving?: boolean;
  runStatusByNodeId?: Record<string, string>;
  iterationByNodeId?: Record<string, number>;
  dynamicByNodeId?: Record<string, boolean>;
  onSelectNode?: (nodeId: string | null) => void;
}

export function WorkflowCanvas({ model, onModelChange }: WorkflowCanvasProps) {
  return <JsonView model={model} onChange={onModelChange} />;
}
