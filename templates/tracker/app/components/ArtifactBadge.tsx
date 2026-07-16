import type { SprintArtifact } from "@shared/types";
import { IconFileText } from "@tabler/icons-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Producer badge (agent vs. human) for a versioned artifact.
 *
 * Shared between the per-sprint "产物" section (SprintDetailPage), the
 * per-work-item "产物" panel (ArtifactsPanel), and the Inbox "关联产物" card
 * so every surface speaks the same agent/human visual vocabulary — matches
 * docs/sdlc-product-design/prototypes/s4-work-item.html's `.badge.b-agent`
 * treatment — instead of each screen inventing its own tone.
 */
export function ArtifactBadge({ kind }: { kind: string }) {
  const isHuman = kind === "human";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold",
        isHuman
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
          : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      )}
    >
      {isHuman ? "人工" : "智能体"}
    </span>
  );
}

export function ArtifactViewDialog({
  artifact,
  open,
  onClose,
}: {
  artifact: SprintArtifact | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!artifact) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <IconFileText className="size-4 shrink-0 text-muted-foreground" />
            {artifact.name}
            <ArtifactBadge kind={artifact.producedByKind} />
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              v{artifact.version}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-96 overflow-y-auto p-1">
          {artifact.content ? (
            <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">
              {artifact.content}
            </pre>
          ) : (
            <p className="text-sm italic text-muted-foreground">（内容为空）</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
