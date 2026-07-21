import { IconCertificate, IconEye, IconFileText } from "@tabler/icons-react";
/**
 * "产物" — durable outputs a stage produced (test evidence, briefs, reports,
 * …), one `artifact-row` per item. Matches the prototype's dedicated 产物
 * section (docs/sdlc-product-design/prototypes/s4-work-item.html, ~464-485):
 * icon + title + agent/human badge + version chip + a short content
 * reference + a "查看详情" eye button.
 *
 * Backed by the real `tracker_artifacts` table (server/db/schema.ts) via the
 * already-existing `list-artifacts` action / `useArtifacts` hook — neither
 * had a work-item-level UI consumer before this panel (only
 * SprintDetailPage's sprint-scoped `tracker_sprint_artifacts` did).
 *
 * Split into a thin data-fetching `ArtifactsPanel` and a prop-driven
 * `ArtifactsSection` so the rendering logic is unit-testable without mounting
 * react-query (same shape as RunEvidenceList/CurrentRunPanel).
 */
import { useState } from "react";

import { ArtifactBadge } from "@/components/ArtifactBadge";
import { fmtDateTime } from "@/components/tracker-format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useArtifacts } from "@/hooks/use-tracker";

export interface WorkItemArtifact {
  id: string;
  workItemId: string;
  stageId: string;
  stageName: string;
  kind: string;
  name: string;
  version: number;
  contentRef: string | null;
  producedByKind: "agent" | "human" | string;
  supersedes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Icon per artifact kind — test/evidence-flavored kinds get the prototype's
 *  "certificate" glyph (its 复现测试证据 row uses ti-certificate); everything
 *  else falls back to the generic file icon every other row-leading icon on
 *  this page already uses (DocumentsPanel, LinksPanel, MetaRow). No new icon
 *  vocabulary introduced. */
export function artifactKindIcon(kind: string) {
  return /测试|证据|evidence|regression/i.test(kind)
    ? IconCertificate
    : IconFileText;
}

function ArtifactViewDialog({
  artifact,
  open,
  onClose,
}: {
  artifact: WorkItemArtifact | null;
  open: boolean;
  onClose: () => void;
}) {
  if (!artifact) return null;
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {artifact.name}
            <ArtifactBadge kind={artifact.producedByKind} />
            <span className="text-xs font-normal text-muted-foreground">
              v{artifact.version}
            </span>
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-muted-foreground">类型</span>
            <span>{artifact.kind}</span>
          </div>
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-muted-foreground">阶段</span>
            <span>{artifact.stageName}</span>
          </div>
          {artifact.supersedes ? (
            <div className="flex justify-between gap-3 text-xs">
              <span className="text-muted-foreground">取代</span>
              <span>旧版本</span>
            </div>
          ) : null}
          <div className="flex justify-between gap-3 text-xs">
            <span className="text-muted-foreground">生成时间</span>
            <span>{fmtDateTime(artifact.createdAt)}</span>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-2.5">
            {artifact.contentRef ? (
              <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground/90">
                {artifact.contentRef}
              </p>
            ) : (
              <p className="text-xs italic text-muted-foreground">
                （无内容引用）
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ArtifactRow({
  artifact,
  onView,
}: {
  artifact: WorkItemArtifact;
  onView: () => void;
}) {
  const Icon = artifactKindIcon(artifact.kind);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/40 px-3 py-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs font-medium">{artifact.name}</span>
      <ArtifactBadge kind={artifact.producedByKind} />
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        v{artifact.version}
      </span>
      {artifact.supersedes ? (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          取代旧版本
        </span>
      ) : null}
      {artifact.contentRef ? (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {artifact.contentRef}
        </span>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto h-6 w-6 shrink-0 p-0"
        onClick={onView}
        title="查看详情"
      >
        <IconEye className="size-3.5" />
      </Button>
    </div>
  );
}

export interface ArtifactsSectionProps {
  artifacts: WorkItemArtifact[];
  isLoading: boolean;
}

/** Prop-driven rendering — pure enough to unit test without react-query. */
export function ArtifactsSection({
  artifacts,
  isLoading,
}: ArtifactsSectionProps) {
  const [selected, setSelected] = useState<WorkItemArtifact | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <IconFileText className="size-3.5 text-muted-foreground" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          产物{artifacts.length > 0 ? ` (${artifacts.length})` : ""}
        </h2>
      </div>
      <div className="space-y-2">
        {isLoading ? (
          <Skeleton
            className="h-10 w-full rounded-lg"
            data-testid="artifacts-skeleton"
          />
        ) : artifacts.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground/60">
            暂无产物 —— 阶段执行产出证据/文档后会展示在这里。
          </p>
        ) : (
          artifacts.map((a) => (
            <ArtifactRow
              key={a.id}
              artifact={a}
              onView={() => {
                setSelected(a);
                setOpen(true);
              }}
            />
          ))
        )}
      </div>
      <ArtifactViewDialog
        artifact={selected}
        open={open}
        onClose={() => {
          setOpen(false);
          setSelected(null);
        }}
      />
    </section>
  );
}

/** Data-fetching wrapper used by WorkItemDetailPage. */
export function ArtifactsPanel({ workItemId }: { workItemId: string }) {
  const { data, isLoading } = useArtifacts(workItemId);
  const byStage: Record<string, WorkItemArtifact[]> = data?.byStage ?? {};
  const artifacts = Object.values(byStage).flat();
  return <ArtifactsSection artifacts={artifacts} isLoading={isLoading} />;
}
