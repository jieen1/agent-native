import type { SprintArtifact } from "@shared/types";
import {
  IconBook2,
  IconFileDiff,
  IconFileText,
  IconUpload,
  IconVersions,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";

import { ArtifactBadge, ArtifactViewDialog } from "@/components/ArtifactBadge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCreateSprintArtifact } from "@/hooks/use-tracker";

/** Naive line-level diff (added/removed/unchanged) — good enough for a
 *  side-glance "what changed", not a full Myers diff. Both artifact
 *  versions arrive already fetched (get-sprint-artifact), no new action. */
function diffLines(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const setA = new Set(a);
  const setB = new Set(b);
  const rows: Array<{ kind: "same" | "added" | "removed"; text: string }> = [];
  for (const line of a) {
    if (!setB.has(line)) rows.push({ kind: "removed", text: line });
  }
  for (const line of b) {
    rows.push({ kind: setA.has(line) ? "same" : "added", text: line });
  }
  return rows;
}

export function ArtifactToolRow({
  sprintId,
  docKey,
  kind,
  versions,
  latest,
}: {
  sprintId: string;
  docKey: string;
  kind: string;
  versions: SprintArtifact[];
  latest: SprintArtifact | undefined;
}) {
  const [importOpen, setImportOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);

  const previous =
    versions.length >= 2 ? versions[versions.length - 2] : undefined;

  return (
    <div className="ml-auto flex items-center gap-1.5">
      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5"
        title="不走访谈，直接粘贴/上传现成文档定稿"
        onClick={() => setImportOpen(true)}
      >
        <IconUpload className="size-3.5" />
        手工导入
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="gap-1.5"
        disabled={!latest}
        title="查看 agent 实际读到的纯文本版"
        onClick={() => setViewerOpen(true)}
      >
        <IconFileText className="size-3.5" />
        agent 视图
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled
        title={
          latest?.contentRef
            ? "在 content 打开（发布管道）"
            : "在 content 打开：发布管道属 R5 范围，本期未接入"
        }
      >
        <IconBook2 className="size-3.5" />
        在 content 打开
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={versions.length === 0}
        onClick={() => setChainOpen(true)}
      >
        <IconVersions className="size-3.5" />
        版本链
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="gap-1.5"
        disabled={!previous || !latest}
        onClick={() => setDiffOpen(true)}
      >
        <IconFileDiff className="size-3.5" />
        与上版对比
      </Button>

      <ImportArtifactDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        sprintId={sprintId}
        docKey={docKey}
        kind={kind}
      />
      <ArtifactViewDialog
        artifact={latest ?? null}
        open={viewerOpen}
        onClose={() => setViewerOpen(false)}
      />
      <VersionChainDialog
        open={chainOpen}
        onOpenChange={setChainOpen}
        versions={versions}
      />
      {previous && latest ? (
        <DiffDialog
          open={diffOpen}
          onOpenChange={setDiffOpen}
          before={previous}
          after={latest}
        />
      ) : null}
    </div>
  );
}

function ImportArtifactDialog({
  open,
  onOpenChange,
  sprintId,
  docKey,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sprintId: string;
  docKey: string;
  kind: string;
}) {
  const [content, setContent] = useState("");
  const createArtifact = useCreateSprintArtifact();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>手工导入 · {docKey}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          不走访谈，直接粘贴现成文档定稿为一个新版本（producedByKind = human）。
        </p>
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={14}
          placeholder="粘贴 Markdown 内容…"
          className="font-mono text-xs"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!content.trim() || createArtifact.isPending}
            onClick={() =>
              createArtifact.mutate(
                {
                  sprintId,
                  docKey,
                  kind,
                  name: docKey,
                  producedByKind: "human",
                  content,
                },
                {
                  onSuccess: () => {
                    setContent("");
                    onOpenChange(false);
                  },
                },
              )
            }
          >
            导入为新版本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionChainDialog({
  open,
  onOpenChange,
  versions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: SprintArtifact[];
}) {
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>版本链</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
          {ordered.map((v) => (
            <div
              key={v.id}
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
            >
              <span className="font-mono text-xs text-muted-foreground">
                v{v.version}
              </span>
              <ArtifactBadge kind={v.producedByKind} />
              <span className="ml-auto text-xs text-muted-foreground">
                {new Date(v.createdAt).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DiffDialog({
  open,
  onOpenChange,
  before,
  after,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  before: SprintArtifact;
  after: SprintArtifact;
}) {
  const rows = useMemo(
    () => diffLines(before.content, after.content),
    [before.content, after.content],
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            与上版对比 · v{before.version} → v{after.version}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border font-mono text-xs">
          {rows.map((row, i) => (
            <div
              key={i}
              className={
                row.kind === "added"
                  ? "bg-success/10 px-2 py-0.5 text-success"
                  : row.kind === "removed"
                    ? "bg-destructive/10 px-2 py-0.5 text-destructive line-through"
                    : "px-2 py-0.5 text-muted-foreground"
              }
            >
              {row.kind === "added"
                ? "+ "
                : row.kind === "removed"
                  ? "- "
                  : "  "}
              {row.text || " "}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
