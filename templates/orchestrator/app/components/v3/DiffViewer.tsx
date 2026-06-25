import { useMemo, useState } from "react";
import {
  IconFileDiff,
  IconChevronRight,
  IconPlus,
  IconMinus,
  IconRefresh,
} from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { V3DiffFile } from "@/hooks/use-v3-workspace";

// ── Per-line classification for color coding ─────────────────────────────────

type LineKind = "add" | "del" | "hunk" | "meta" | "context";

function classifyLine(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("new file") ||
    line.startsWith("deleted file") ||
    line.startsWith("rename ") ||
    line.startsWith("similarity ") ||
    line.startsWith("Binary files")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

const LINE_CLASS: Record<LineKind, string> = {
  add: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  hunk: "bg-sky-500/10 text-sky-700 dark:text-sky-300 font-medium",
  meta: "text-muted-foreground",
  context: "text-foreground/80",
};

const STATUS_BADGE: Record<string, { label: string; className: string }> = {
  A: {
    label: "added",
    className:
      "bg-emerald-500/10 text-emerald-600 border-emerald-500/30 dark:text-emerald-400",
  },
  M: {
    label: "modified",
    className:
      "bg-amber-500/10 text-amber-600 border-amber-500/30 dark:text-amber-400",
  },
  D: {
    label: "deleted",
    className: "bg-red-500/10 text-red-600 border-red-500/30 dark:text-red-400",
  },
  R: {
    label: "renamed",
    className:
      "bg-violet-500/10 text-violet-600 border-violet-500/30 dark:text-violet-400",
  },
};

// ── One file's diff card ─────────────────────────────────────────────────────

function FileDiffCard({
  file,
  defaultOpen,
}: {
  file: V3DiffFile;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const lines = useMemo(
    () => (file.patch ? file.patch.replace(/\n$/, "").split("\n") : []),
    [file.patch],
  );
  const status = STATUS_BADGE[file.status] ?? STATUS_BADGE.M;
  // Total bar width is split between additions (green) and deletions (red).
  const total = file.additions + file.deletions;
  const addPct = total > 0 ? Math.round((file.additions / total) * 100) : 0;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
      >
        <IconChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground">
          {file.path}
        </span>
        <Badge
          variant="outline"
          className={cn("h-5 shrink-0 px-1.5 text-[10px]", status.className)}
        >
          {status.label}
        </Badge>
        <span className="flex shrink-0 items-center gap-2 font-mono text-xs">
          {file.additions > 0 ? (
            <span className="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
              <IconPlus className="size-3" />
              {file.additions}
            </span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="flex items-center gap-0.5 text-red-600 dark:text-red-400">
              <IconMinus className="size-3" />
              {file.deletions}
            </span>
          ) : null}
          {/* Add/del proportion bar */}
          {total > 0 ? (
            <span className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-red-500/40 sm:block">
              <span
                className="block h-full bg-emerald-500"
                style={{ width: `${addPct}%` }}
              />
            </span>
          ) : null}
        </span>
      </button>

      {open ? (
        lines.length > 0 ? (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full border-collapse font-mono text-xs">
              <tbody>
                {lines.map((line, i) => {
                  const kind = classifyLine(line);
                  // The +/- sign lives in the gutter; strip it from the content
                  // so we don't render a doubled "+ +import …".
                  const content =
                    kind === "add" || kind === "del" ? line.slice(1) : line;
                  return (
                    <tr
                      key={i}
                      className={cn("leading-relaxed", LINE_CLASS[kind])}
                    >
                      <td className="w-8 select-none border-r border-border/50 px-2 text-center text-[11px] font-semibold text-muted-foreground/70">
                        {kind === "add" ? "+" : kind === "del" ? "−" : ""}
                      </td>
                      <td className="whitespace-pre px-3">
                        {content.length ? content : " "}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="border-t border-border px-3 py-3 text-xs text-muted-foreground">
            No textual patch for this change (binary or rename with no content
            change).
          </div>
        )
      ) : null}
    </div>
  );
}

// ── DiffViewer ───────────────────────────────────────────────────────────────

export interface DiffViewerProps {
  files: V3DiffFile[] | undefined;
  rawDiff: string | undefined;
  base?: string;
  isLoading: boolean;
  error?: unknown;
  available: boolean;
  onRefresh?: () => void;
}

export function DiffViewer({
  files,
  rawDiff,
  base,
  isLoading,
  error,
  available,
  onRefresh,
}: DiffViewerProps) {
  const totals = useMemo(() => {
    const list = files ?? [];
    return {
      files: list.length,
      additions: list.reduce((s, f) => s + f.additions, 0),
      deletions: list.reduce((s, f) => s + f.deletions, 0),
    };
  }, [files]);

  // Workspace not live (destroyed/destroying) — diff is unavailable, say so.
  if (!available) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
        The diff is only available while the workspace checkout exists.
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        Failed to load the diff for this workspace.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  const hasFiles = (files?.length ?? 0) > 0;
  const hasRaw = !!rawDiff && rawDiff.trim() !== "";

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <IconFileDiff className="size-4 text-muted-foreground" />
          {totals.files} {totals.files === 1 ? "file" : "files"} changed
        </span>
        {totals.additions > 0 ? (
          <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
            +{totals.additions}
          </span>
        ) : null}
        {totals.deletions > 0 ? (
          <span className="font-mono text-xs text-red-600 dark:text-red-400">
            −{totals.deletions}
          </span>
        ) : null}
        {base ? (
          <Badge
            variant="secondary"
            className="font-mono text-[10px]"
            title="Diff base"
          >
            vs {base.length > 12 ? base.slice(0, 12) : base}
          </Badge>
        ) : null}
        {onRefresh ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 px-2 text-xs"
            onClick={onRefresh}
          >
            <IconRefresh className="mr-1 size-3" />
            Refresh
          </Button>
        ) : null}
      </div>

      {hasFiles ? (
        <div className="space-y-2">
          {files!.map((f, i) => (
            <FileDiffCard key={f.path} file={f} defaultOpen={i === 0} />
          ))}
        </div>
      ) : hasRaw ? (
        // Fallback: a raw patch with no per-file split (e.g. the VM path).
        <pre className="overflow-x-auto rounded-lg border border-border bg-muted/20 p-4 font-mono text-xs leading-relaxed whitespace-pre">
          {rawDiff}
        </pre>
      ) : (
        <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          No changes — this workspace matches its base branch.
        </div>
      )}
    </div>
  );
}
