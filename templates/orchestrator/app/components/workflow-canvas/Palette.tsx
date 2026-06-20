import { useTranslation } from "react-i18next";
import { IconLock } from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useNodeDefs } from "@/hooks/use-library";
import { NODE_TYPE_META, PALETTE_NODE_TYPES } from "@/lib/node-meta";
import type { NodeType } from "../../../shared/types";

// The editor's left pane (FRONTEND §6 "Palette, two tabs"). Drag a Nodes-tab
// primitive or a Library-tab node_def onto the canvas. Drag uses the HTML5
// dataTransfer channel; the canvas reads the payload on drop. Library nodes show
// a lock glyph (config inherited from the def, overridable per-use).

export const DND_MIME = "application/x-orchestrator-node";

export interface PaletteDragPayload {
  kind: "type" | "library";
  /** primitive NodeType (kind=type) */
  nodeType?: NodeType;
  /** node_def key/kind/title (kind=library) */
  defKey?: string;
  defKind?: string;
  defTitle?: string;
}

function setDrag(e: React.DragEvent, payload: PaletteDragPayload) {
  e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "move";
}

export function Palette() {
  const { t } = useTranslation();
  const { data: defs = [], isLoading } = useNodeDefs();

  return (
    <Tabs defaultValue="nodes" className="flex h-full min-h-0 flex-col">
      <TabsList className="mx-3 mt-3 grid w-auto grid-cols-2">
        <TabsTrigger value="nodes">{t("flow.tabNodes")}</TabsTrigger>
        <TabsTrigger value="library">{t("flow.tabLibrary")}</TabsTrigger>
      </TabsList>

      <TabsContent value="nodes" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="grid gap-1.5 p-3">
            {PALETTE_NODE_TYPES.map((type) => {
              const meta = NODE_TYPE_META[type];
              const Icon = meta.icon;
              return (
                <button
                  key={type}
                  type="button"
                  draggable
                  onDragStart={(e) =>
                    setDrag(e, { kind: "type", nodeType: type })
                  }
                  className="flex cursor-grab items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-left text-sm transition-colors hover:border-foreground/20 hover:bg-accent/40 active:cursor-grabbing"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">
                    {t(`flow.nodeType.${meta.labelKey}`)}
                  </span>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </TabsContent>

      <TabsContent value="library" className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="grid gap-1.5 p-3">
            {isLoading ? (
              <>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </>
            ) : defs.length === 0 ? (
              <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                {t("flow.libraryEmpty")}
              </p>
            ) : (
              defs.map((def) => (
                <button
                  key={def.id}
                  type="button"
                  draggable
                  onDragStart={(e) =>
                    setDrag(e, {
                      kind: "library",
                      defKey: def.key,
                      defKind: def.kind,
                      defTitle: def.title,
                    })
                  }
                  className="flex cursor-grab items-center gap-2.5 rounded-md border border-border bg-card px-2.5 py-2 text-left text-sm transition-colors hover:border-foreground/20 hover:bg-accent/40 active:cursor-grabbing"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">
                      {def.title || def.key}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {def.key} · {def.kind}
                    </span>
                  </span>
                  <IconLock
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label={t("flow.libraryLocked")}
                  />
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}
