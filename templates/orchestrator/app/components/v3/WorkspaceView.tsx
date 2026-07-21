import { useActionMutation } from "@agent-native/core/client";
import {
  IconArrowLeft,
  IconBrandGithub,
  IconGitBranch,
  IconClockHour3,
  IconFileDiff,
  IconFile,
  IconFolder,
  IconPlayerStop,
  IconRefresh,
  IconStack2,
  IconRobot,
  IconExternalLink,
  IconHierarchy3,
  IconPointerSearch,
  IconServer,
  IconUser,
} from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useWorkspace,
  useWorkspaceDiff,
  useWorkspaceFiles,
  useWorkspaceFile,
  useWorkspaceRuns,
  type V3SpawnLite,
} from "@/hooks/use-v3-workspace";
import { cn } from "@/lib/utils";

import { DiffViewer } from "./DiffViewer";
import { fmtDateTime, agentPresentation } from "./v3-format";
import { V3StatusBadge } from "./V3StatusBadge";

// ── Workspace state → colored badge ──────────────────────────────────────────

const STATE_BADGE: Record<string, string> = {
  provisioning:
    "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-700",
  ready:
    "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-700",
  busy: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-700",
  destroying:
    "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-700",
  destroyed: "bg-muted text-muted-foreground border-border",
  error:
    "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/40 dark:text-red-300 dark:border-red-700",
};

const STATE_DOT: Record<string, string> = {
  provisioning: "bg-amber-500 animate-pulse",
  ready: "bg-emerald-500",
  busy: "bg-blue-500 animate-pulse",
  destroying: "bg-orange-500 animate-pulse",
  destroyed: "bg-zinc-400",
  error: "bg-red-500",
};

function isLiveState(state: string | undefined): boolean {
  return state !== undefined && state !== "destroyed" && state !== "destroying";
}

/** True when a string looks like an email address (owner identity). */
function looksLikeEmail(value: string | null | undefined): boolean {
  return !!value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Present a workspace owner cleanly. The owner identity (`ownerId`) is the real
 * user's email or a run id; `ownerKind` ("user" / "run") is its category. We
 * never surface the legacy "cc" placeholder. Returns the primary label to show
 * plus an optional category badge and a tooltip with the raw id.
 */
function ownerPresentation(
  ownerKind: string | null | undefined,
  ownerId: string | null | undefined,
): { label: string; kind: string | null; title: string | null } {
  const id = ownerId?.trim() ?? "";
  const kind = ownerKind?.trim() ?? "";
  const isPlaceholder = (v: string) => v === "" || v === "cc";

  // A real identity (email or run id) is the source of truth for the label.
  if (!isPlaceholder(id)) {
    if (looksLikeEmail(id)) {
      return { label: id, kind: kind === "run" ? "run" : "user", title: id };
    }
    if (kind === "run") {
      return { label: id, kind: "run", title: id };
    }
    return {
      label: id,
      kind: kind && !isPlaceholder(kind) ? kind : null,
      title: id,
    };
  }

  // No usable identity → unknown (never the "cc" token).
  return { label: "—", kind: null, title: null };
}

/** Turn a clone/remote URL into a browsable GitHub URL (strips `.git`). */
function githubHref(repoUrl: string | null | undefined): string | null {
  if (!repoUrl) return null;
  const clean = repoUrl.trim().replace(/\.git$/, "");
  if (/^https?:\/\//.test(clean) && /github\.com/.test(clean)) return clean;
  return null;
}

/** Build a GitHub link to the branch's tree, when both are present + github. */
function branchHref(
  repoUrl: string | null | undefined,
  branch: string | null | undefined,
): string | null {
  const base = githubHref(repoUrl);
  if (!base || !branch) return null;
  return `${base}/tree/${encodeURIComponent(branch)}`;
}

// ── Stat chip (matches RunView) ──────────────────────────────────────────────

function StatChip({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof IconStack2;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card/50 px-3 py-1.5">
      <Icon
        className={cn("size-4 shrink-0", tone ?? "text-muted-foreground")}
      />
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-sm font-semibold text-foreground">
          {value}
        </span>
      </div>
    </div>
  );
}

// ── Metadata row ─────────────────────────────────────────────────────────────

function MetaRow({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof IconUser;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="w-24 shrink-0 pt-px text-xs text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

// ── Files panel (clean tree + click-to-preview) ──────────────────────────────

function FilesPanel({
  workspaceId,
  enabled,
}: {
  workspaceId: string;
  enabled: boolean;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const {
    data: filesData,
    isLoading,
    error,
    refetch,
  } = useWorkspaceFiles(workspaceId, undefined, enabled);
  const {
    data: fileContent,
    isLoading: contentLoading,
    error: contentError,
  } = useWorkspaceFile(workspaceId, selectedPath);

  if (!enabled) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
        文件浏览器仅在工作区检出存在时可用。
      </div>
    );
  }

  return (
    <div className="grid min-h-[320px] gap-4 lg:grid-cols-[minmax(200px,260px)_1fr]">
      {/* Tree */}
      <div className="flex max-h-[520px] flex-col overflow-hidden rounded-lg border border-border">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-card px-3 py-2">
          <IconFolder className="size-3.5 text-muted-foreground" />
          <span className="font-mono text-xs font-medium">工作区根目录</span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto size-6 p-0"
            onClick={() => refetch()}
          >
            <IconRefresh className="size-3" />
            <span className="sr-only">刷新文件</span>
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {error ? (
            <div className="p-3 text-xs text-destructive">无法列出文件。</div>
          ) : isLoading ? (
            <div className="space-y-1.5 p-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
            </div>
          ) : !filesData?.files.length ? (
            <div className="p-3 text-xs text-muted-foreground">
              未找到文件。
            </div>
          ) : (
            <ul className="py-1">
              {filesData.files.map((f) => {
                const isDir = f.endsWith("/");
                const clean = isDir ? f.slice(0, -1) : f;
                const name = clean.split("/").pop() ?? clean;
                return (
                  <li key={f}>
                    <button
                      type="button"
                      disabled={isDir}
                      className={cn(
                        "flex w-full items-center gap-1.5 px-3 py-1.5 text-left font-mono text-xs transition-colors",
                        isDir
                          ? "cursor-default text-muted-foreground"
                          : "hover:bg-muted/50",
                        selectedPath === clean
                          ? "bg-muted font-medium text-foreground"
                          : "text-foreground/80",
                      )}
                      onClick={() =>
                        !isDir &&
                        setSelectedPath((prev) =>
                          prev === clean ? null : clean,
                        )
                      }
                    >
                      {isDir ? (
                        <IconFolder className="size-3.5 shrink-0 text-sky-500" />
                      ) : (
                        <IconFile className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="truncate" title={name}>
                        {name}
                        {isDir ? "/" : ""}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </div>

      {/* Preview */}
      <div className="min-w-0">
        {!selectedPath ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/20 px-6 text-center">
            <div className="rounded-full bg-muted/50 p-2.5">
              <IconPointerSearch className="size-5 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">未选择文件</p>
            <p className="max-w-[240px] text-xs text-muted-foreground">
              在文件树中点击某个文件以预览其内容。
            </p>
          </div>
        ) : contentError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            无法读取此文件。
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border">
            <div className="shrink-0 border-b border-border bg-card px-3 py-2 font-mono text-xs text-muted-foreground">
              {selectedPath.split("/").pop()}
            </div>
            {contentLoading ? (
              <div className="space-y-1.5 p-4">
                {Array.from({ length: 10 }).map((_, i) => (
                  <Skeleton key={i} className="h-3 w-full" />
                ))}
              </div>
            ) : (
              <pre className="max-h-[480px] overflow-auto whitespace-pre p-4 font-mono text-xs leading-relaxed text-foreground/90">
                {fileContent?.content || "(空文件)"}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Related runs panel ───────────────────────────────────────────────────────

interface RelatedRun {
  runId: string;
  agents: string[];
  spawnCount: number;
  latestAt: string | null;
}

function RunsPanel({ workspaceId }: { workspaceId: string }) {
  const { data: spawns, isLoading, error } = useWorkspaceRuns(workspaceId);

  const runs = useMemo((): RelatedRun[] => {
    const matched = (spawns ?? []).filter(
      (s: V3SpawnLite) => s.workspaceId === workspaceId && s.runId,
    );
    const byRun = new Map<string, RelatedRun>();
    for (const s of matched) {
      const key = s.runId as string;
      const existing = byRun.get(key);
      const agent = s.agentName ?? "—";
      const ts = s.completedAt ?? s.startedAt ?? null;
      if (existing) {
        existing.spawnCount += 1;
        if (!existing.agents.includes(agent)) existing.agents.push(agent);
        if (ts && (!existing.latestAt || ts > existing.latestAt)) {
          existing.latestAt = ts;
        }
      } else {
        byRun.set(key, {
          runId: key,
          agents: [agent],
          spawnCount: 1,
          latestAt: ts,
        });
      }
    }
    return [...byRun.values()].sort((a, b) =>
      (b.latestAt ?? "").localeCompare(a.latestAt ?? ""),
    );
  }, [spawns, workspaceId]);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        无法加载相关运行。
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
        尚无运行使用过此工作区。
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {runs.map((run) => (
        <Link
          key={run.runId}
          to={`/runs/${run.runId}`}
          className="flex items-center gap-3 rounded-lg border border-border bg-card p-3 transition-colors hover:border-foreground/30 hover:bg-muted/30"
        >
          <div className="rounded-md bg-muted/60 p-2">
            <IconHierarchy3 className="size-4 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono text-sm font-medium text-foreground">
              {run.runId}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {run.agents.map((a) => {
                const pres = agentPresentation(a);
                return (
                  <Badge
                    key={a}
                    variant="outline"
                    className={cn("h-5 px-1.5 text-[10px]", pres.className)}
                  >
                    <IconRobot className="mr-1 size-3" />
                    {pres.label}
                  </Badge>
                );
              })}
              <span className="font-mono text-[11px] text-muted-foreground">
                {run.spawnCount} 次生成
              </span>
            </div>
          </div>
          {run.latestAt ? (
            <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:block">
              {fmtDateTime(run.latestAt)}
            </span>
          ) : null}
          <IconExternalLink className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}

// ── WorkspaceView ────────────────────────────────────────────────────────────

export interface WorkspaceViewProps {
  workspaceId: string;
}

export function WorkspaceView({ workspaceId }: WorkspaceViewProps) {
  const navigate = useNavigate();
  const { data: ws, isLoading, error } = useWorkspace(workspaceId);
  const live = isLiveState(ws?.state);
  const diff = useWorkspaceDiff(workspaceId, ws?.state);
  const { data: spawns } = useWorkspaceRuns(workspaceId);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"diff" | "files" | "runs">("diff");

  const destroy = useActionMutation("workspaceDestroy" as any, {});

  const relatedRunCount = useMemo(() => {
    const ids = new Set<string>();
    for (const s of spawns ?? []) {
      if (s.workspaceId === workspaceId && s.runId) ids.add(s.runId);
    }
    return ids.size;
  }, [spawns, workspaceId]);

  const ghHref = githubHref(ws?.repoUrl);
  const brHref = branchHref(ws?.repoUrl, ws?.branch);
  const repoLabel = useMemo(() => {
    if (!ws?.repoUrl) return null;
    const m = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(ws.repoUrl);
    return m ? m[1] : ws.repoUrl.replace(/^https?:\/\//, "");
  }, [ws?.repoUrl]);

  // ── Loading / error ──
  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="mt-4 h-8 w-72" />
        <Skeleton className="mt-2 h-4 w-96" />
        <div className="mt-4 flex gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-32 rounded-lg" />
          ))}
        </div>
        <Skeleton className="mt-6 h-40 w-full rounded-lg" />
      </div>
    );
  }

  if (error || !ws) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/workspaces">
            <IconArrowLeft className="size-4" />
            工作区
          </Link>
        </Button>
        <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          未找到工作区或加载失败。
        </div>
      </div>
    );
  }

  const shortId = ws.id.slice(0, 8);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Back link */}
      <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3">
        <Link to="/workspaces">
          <IconArrowLeft className="size-4" />
          Workspaces
        </Link>
      </Button>

      {/* ── Header ── */}
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight sm:text-2xl">
              {shortId}
            </h1>
            <Badge
              variant="outline"
              className={cn(
                "gap-1.5 font-normal",
                STATE_BADGE[ws.state] ?? STATE_BADGE.error,
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  STATE_DOT[ws.state] ?? "bg-zinc-400",
                )}
              />
              {ws.state}
            </Badge>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {repoLabel ? (
              ghHref ? (
                <a
                  href={ghHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 hover:text-foreground hover:underline"
                  title={ws.repoUrl ?? undefined}
                >
                  <IconBrandGithub className="size-3.5" />
                  {repoLabel}
                </a>
              ) : (
                <span
                  className="flex items-center gap-1"
                  title={ws.repoUrl ?? undefined}
                >
                  <IconBrandGithub className="size-3.5" />
                  {repoLabel}
                </span>
              )
            ) : null}
            {ws.branch ? (
              brHref ? (
                <a
                  href={brHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 font-mono text-xs hover:text-foreground hover:underline"
                >
                  <IconGitBranch className="size-3.5" />
                  {ws.branch}
                </a>
              ) : (
                <span className="flex items-center gap-1 font-mono text-xs">
                  <IconGitBranch className="size-3.5" />
                  {ws.branch}
                </span>
              )
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {ghHref ? (
            <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
              <a href={ghHref} target="_blank" rel="noopener noreferrer">
                <IconBrandGithub className="size-4" />
                仓库
                <IconExternalLink className="size-3 opacity-60" />
              </a>
            </Button>
          ) : null}
          {live ? (
            <Button
              size="sm"
              variant="destructive"
              className="h-8"
              onClick={() => setConfirmOpen(true)}
              disabled={destroy.isPending}
            >
              <IconPlayerStop className="mr-1.5 size-4" />
              销毁
            </Button>
          ) : null}
        </div>
      </header>

      {/* ── Stat chips ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatChip
          icon={IconFileDiff}
          label="变更文件数"
          value={live ? String(diff.data?.files.length ?? 0) : "—"}
          tone="text-sky-500"
        />
        <StatChip
          icon={IconStack2}
          label="净变更行数"
          value={
            live && diff.data
              ? `+${diff.data.files.reduce((s, f) => s + f.additions, 0)} −${diff.data.files.reduce((s, f) => s + f.deletions, 0)}`
              : "—"
          }
          tone="text-emerald-500"
        />
        <StatChip
          icon={IconHierarchy3}
          label="相关运行"
          value={String(relatedRunCount)}
          tone="text-violet-500"
        />
      </div>

      {/* ── Metadata card ── */}
      <section className="mb-6 divide-y divide-border rounded-lg border border-border bg-card">
        <MetaRow icon={IconUser} label="所有者">
          {(() => {
            const owner = ownerPresentation(ws.ownerKind, ws.ownerId);
            return (
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium" title={owner.title ?? undefined}>
                  {owner.label}
                </span>
                {owner.kind ? (
                  <Badge
                    variant="outline"
                    className="h-5 px-1.5 text-[10px] font-normal capitalize text-muted-foreground"
                  >
                    {owner.kind}
                  </Badge>
                ) : null}
              </span>
            );
          })()}
        </MetaRow>
        <MetaRow icon={ws.vmName ? IconServer : IconFolder} label="位置">
          {ws.vmName ? (
            <span className="font-mono text-xs">虚拟机 · {ws.vmName}</span>
          ) : (
            <span className="font-mono text-xs text-foreground/80">
              主机 · /workspaces/{ws.id}
            </span>
          )}
        </MetaRow>
        <MetaRow icon={IconClockHour3} label="创建于">
          <span>{fmtDateTime(ws.createdAt)}</span>
          {(() => {
            // Never surface the legacy "cc"/"cc:cc" placeholder as a creator.
            const by = ws.createdBy?.trim();
            const clean =
              by && by !== "cc" && by !== "cc:cc"
                ? by.replace(/^cc:/, "")
                : null;
            return clean ? (
              <span className="ml-2 text-xs text-muted-foreground">
                由 {clean}
              </span>
            ) : null;
          })()}
        </MetaRow>
        {ws.destroyedAt ? (
          <MetaRow icon={IconPlayerStop} label="销毁于">
            <span>{fmtDateTime(ws.destroyedAt)}</span>
          </MetaRow>
        ) : null}
        <MetaRow icon={IconFile} label="工作区 ID">
          <span className="font-mono text-xs text-muted-foreground">
            {ws.id}
          </span>
        </MetaRow>
      </section>

      {/* ── Tabs: Changes / Files / Runs ── */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
      >
        <TabsList className="mb-4">
          <TabsTrigger value="diff" className="gap-1.5">
            <IconFileDiff className="size-4" />
            变更
            {live && diff.data?.files.length ? (
              <Badge
                variant="secondary"
                className="ml-1 h-4 px-1 font-mono text-[10px]"
              >
                {diff.data.files.length}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="files" className="gap-1.5">
            <IconFile className="size-4" />
            文件
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <IconHierarchy3 className="size-4" />
            运行
            {relatedRunCount > 0 ? (
              <Badge
                variant="secondary"
                className="ml-1 h-4 px-1 font-mono text-[10px]"
              >
                {relatedRunCount}
              </Badge>
            ) : null}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="diff" className="mt-0">
          <DiffViewer
            files={diff.data?.files}
            rawDiff={diff.data?.diff}
            base={diff.data?.base}
            isLoading={diff.isLoading}
            error={diff.error}
            available={live}
            onRefresh={() => diff.refetch()}
          />
        </TabsContent>

        <TabsContent value="files" className="mt-0">
          <FilesPanel workspaceId={ws.id} enabled={live} />
        </TabsContent>

        <TabsContent value="runs" className="mt-0">
          <RunsPanel workspaceId={ws.id} />
        </TabsContent>
      </Tabs>

      {/* ── Destroy confirmation ── */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>销毁工作区?</DialogTitle>
            <DialogDescription>
              这将移除工作区检出并将其标记为已销毁。此操作无法撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={destroy.isPending}
              onClick={() => {
                destroy.mutate(
                  { workspaceId: ws.id },
                  {
                    onSuccess: () => {
                      setConfirmOpen(false);
                      navigate("/workspaces");
                    },
                    onError: () => setConfirmOpen(false),
                  },
                );
              }}
            >
              {destroy.isPending ? "销毁中…" : "销毁"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
