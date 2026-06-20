// Node-type presentation metadata — the ONE place that maps a v2 NodeType to its
// icon, i18n label key, and structural traits (container? terminal?). Both the
// editor palette and the shared <NodeCard> read this, so a node's icon and label
// are identical everywhere (FRONTEND §C5 "a shared icon map"). Adding a node type
// is a one-line edit here.

import {
  IconArrowsSplit2,
  IconChecklist,
  IconCirclePlus,
  IconFlag,
  IconFlagCheck,
  IconGitBranch,
  IconHandStop,
  IconLayersSubtract,
  IconRepeat,
  IconRobot,
  IconTool,
  IconUsers,
  type Icon,
} from "@tabler/icons-react";
import type { NodeType } from "../../shared/types";

export interface NodeTypeMeta {
  type: NodeType;
  /** i18n key suffix under the `flow.nodeType.*` tree. */
  labelKey: string;
  icon: Icon;
  /** Container nodes render as React Flow group/parent frames. */
  container: boolean;
  /** start/end are auto-managed terminals — not draggable from the palette. */
  terminal: boolean;
}

export const NODE_TYPE_META: Record<NodeType, NodeTypeMeta> = {
  start: {
    type: "start",
    labelKey: "start",
    icon: IconFlag,
    container: false,
    terminal: true,
  },
  agent: {
    type: "agent",
    labelKey: "agent",
    icon: IconRobot,
    container: false,
    terminal: false,
  },
  tool: {
    type: "tool",
    labelKey: "tool",
    icon: IconTool,
    container: false,
    terminal: false,
  },
  parallel: {
    type: "parallel",
    labelKey: "parallel",
    icon: IconUsers,
    container: true,
    terminal: false,
  },
  fanout: {
    type: "fanout",
    labelKey: "fanout",
    icon: IconLayersSubtract,
    container: true,
    terminal: false,
  },
  join: {
    type: "join",
    labelKey: "join",
    icon: IconArrowsSplit2,
    container: false,
    terminal: false,
  },
  branch: {
    type: "branch",
    labelKey: "branch",
    icon: IconGitBranch,
    container: false,
    terminal: false,
  },
  loop: {
    type: "loop",
    labelKey: "loop",
    icon: IconRepeat,
    container: true,
    terminal: false,
  },
  subworkflow: {
    type: "subworkflow",
    labelKey: "subworkflow",
    icon: IconChecklist,
    container: false,
    terminal: false,
  },
  human: {
    type: "human",
    labelKey: "human",
    icon: IconHandStop,
    container: false,
    terminal: false,
  },
  end: {
    type: "end",
    labelKey: "end",
    icon: IconFlagCheck,
    container: false,
    terminal: true,
  },
};

/** Palette-draggable primitive types (start/end are auto-managed terminals). */
export const PALETTE_NODE_TYPES: NodeType[] = (
  Object.values(NODE_TYPE_META) as NodeTypeMeta[]
)
  .filter((m) => !m.terminal)
  .map((m) => m.type);

/** A library node dropped from the Library tab shows this icon + a lock glyph. */
export const LIBRARY_NODE_ICON = IconCirclePlus;

export function isContainerType(type: NodeType): boolean {
  return NODE_TYPE_META[type]?.container ?? false;
}
