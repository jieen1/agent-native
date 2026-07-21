import { useActionMutation, useActionQuery } from "@agent-native/core/client";
import { IconClock, IconDeviceFloppy, IconRotate } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { MarkdownPreview } from "./MarkdownPreview";
import { MarkdownSourceEditor } from "./MarkdownSourceEditor";

interface SkillDetail {
  path: string;
  name: string;
  title: string;
  description: string;
  category: string | null;
  content: string;
  fileContent: string;
  hasOverride: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

function formatRelativeTimeZh(iso: string | null): string | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface SkillEditorPaneProps {
  path: string;
  onMutated?: () => void;
}

/** Main content area of the Skills / Runbook editor: header hierarchy
 * (title, one-line description, category badge / last-edited / revert
 * button) plus the split source/preview editor for the selected skill. */
export function SkillEditorPane({ path, onMutated }: SkillEditorPaneProps) {
  const { data, isLoading, error, refetch } = useActionQuery(
    "get-skill" as any,
    { path },
    undefined,
  ) as {
    data?: SkillDetail;
    isLoading: boolean;
    error?: unknown;
    refetch: () => void;
  };

  const saveMutation = useActionMutation("save-skill" as any, {});
  const revertMutation = useActionMutation("revert-skill" as any, {});

  // `content === null` means "not yet initialized for this mount" — this
  // component is remounted with `key={path}` by the parent route whenever
  // the selected skill changes, so this state never leaks across skills and
  // never gets stomped by an unrelated background refetch of the same path.
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (content === null && data) setContent(data.content);
  }, [data, content]);

  const loadedContent = data?.content ?? "";
  const isDirty = content !== null && content !== loadedContent;

  function handleSave() {
    if (content === null) return;
    saveMutation.mutate(
      { path, content },
      {
        onSuccess: () => {
          toast.success("已保存");
          refetch();
          onMutated?.();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : "保存失败");
        },
      },
    );
  }

  function handleRevert() {
    revertMutation.mutate(
      { path },
      {
        onSuccess: (result: unknown) => {
          const reverted = result as { content?: string } | undefined;
          if (reverted?.content !== undefined) setContent(reverted.content);
          toast.success("已恢复为文件默认值");
          refetch();
          onMutated?.();
        },
        onError: (err: unknown) => {
          toast.error(err instanceof Error ? err.message : "恢复失败");
        },
      },
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
        加载技能失败。
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <div className="h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-96 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-64 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  const relativeTime = formatRelativeTimeZh(data.updatedAt);
  const filePath =
    path === "brain-runbook"
      ? "server/brain/brain-session.ts (BRAIN_PROMPT)"
      : `.agents/${path}`;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-2.5 border-b px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight">{data.title}</h2>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">
              {filePath}
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saveMutation.isPending}
          >
            <IconDeviceFloppy className="mr-1 size-4" />
            {saveMutation.isPending ? "保存中…" : "保存"}
          </Button>
        </div>

        {data.description ? (
          <p className="max-w-2xl text-[13.5px] text-foreground/75">
            {data.description}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-4">
          {data.category ? (
            <Badge variant="secondary">{data.category}</Badge>
          ) : null}
          {relativeTime ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <IconClock className="size-3.5" />
              最后编辑于 {relativeTime}
            </span>
          ) : null}
          <div className="flex-1" />
          {data.hasOverride ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={handleRevert}
              disabled={revertMutation.isPending}
            >
              <IconRotate className="mr-1 size-4" />
              {revertMutation.isPending ? "恢复中…" : "恢复为文件默认值"}
            </Button>
          ) : null}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-2">
        <div className="flex min-w-0 flex-col overflow-hidden border-r">
          <div className="shrink-0 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Markdown 源码
          </div>
          <MarkdownSourceEditor value={content ?? ""} onChange={setContent} />
        </div>
        <div className="flex min-w-0 flex-col overflow-hidden">
          <div className="shrink-0 border-b px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            预览
          </div>
          <div className="flex-1 overflow-auto px-6 py-5">
            <MarkdownPreview markdown={content ?? ""} />
          </div>
        </div>
      </div>
    </div>
  );
}
