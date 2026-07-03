import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { useActionQuery, useActionMutation } from "@agent-native/core/client";
import { toast } from "sonner";
import { APP_TITLE } from "@/lib/app-config";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { STATUS_DOT } from "@/components/v3/v3-format";
import {
  IconBrain,
  IconPlus,
  IconSend,
  IconTool,
  IconChevronRight,
  IconUser,
  IconCheck,
  IconAlertTriangle,
  IconLoader2,
  IconArrowBackUp,
  IconCpu,
  IconSearch,
  IconDots,
  IconEdit,
  IconArchive,
  IconArchiveOff,
  IconTrash,
  IconX,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — 大脑` }];
}

const POLL_MS = 1500;
// The context panel polls on a slower cadence than the 1.5s transcript poll.
// `brain-usage` is now a CHEAP, DB-only read (model + context fill) — it makes
// NO Anthropic call, so this poll never drives an /oauth/usage hit. Account
// usage is owned solely by the global sidebar indicator.
const CONTEXT_POLL_MS = 30000;

// Accepted model ids/aliases for the switch Select (kept in sync with
// server/brain/brain-model.ts). Radix Select forbids an empty-string item value,
// so "CLI default" uses a sentinel mapped back to "" at the action boundary.
const DEFAULT_MODEL_VALUE = "__default__";
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT_MODEL_VALUE, label: "CLI 默认" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
  { value: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)" },
  { value: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M)" },
  { value: "claude-opus-4-5", label: "Opus 4.5" },
  { value: "claude-sonnet-5", label: "Sonnet 5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-sonnet-4-5[1m]", label: "Sonnet 4.5 (1M)" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

// Session-list status filter options. Values match the brain-threads action's
// `status` enum, plus a synthetic "archived" pill that flips includeArchived.
type StatusFilter =
  | "all"
  | "running"
  | "queued"
  | "done"
  | "error"
  | "archived";
const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "running", label: "运行中" },
  { value: "queued", label: "排队中" },
  { value: "done", label: "完成" },
  { value: "error", label: "失败" },
  { value: "archived", label: "已归档" },
];

/** Chinese label for a thread's own status. */
const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  queued: "排队中",
  done: "完成",
  error: "失败",
  idle: "空闲",
};
function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

type Severity = "normal" | "warning" | "critical";

// Per-session CONTEXT only. The account-level subscription usage (5h / weekly /
// plan tier) moved to the single GLOBAL sidebar indicator (`account-usage`), so
// the brain page no longer fetches /oauth/usage. `brain-usage` is now a cheap,
// DB-only read of the thread's model + context fill.
interface BrainUsage {
  model: string | null;
  actualModel?: string | null;
  configuredModel: string | null;
  context: {
    used: number | null;
    window: number | null;
    pct: number | null;
    windowDerived?: boolean;
  };
}

/** Bar fill color by severity. */
function severityBar(sev: Severity): string {
  if (sev === "critical") return "bg-red-500";
  if (sev === "warning") return "bg-amber-500";
  return "bg-emerald-500";
}

/** Compact integer formatting: 1000000 → "1M", 248531 → "248.5K". */
function formatTokens(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(2)}M`;
  }
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/**
 * Relative "age" for the session rail + transcript (e.g. "刚刚", "5分钟前",
 * "3小时前", "昨天", then a short calendar date). Pair with absoluteTime() in a
 * `title` attribute so hovering reveals the full timestamp.
 */
function relativeAge(iso: string | null): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨天";
  if (d < 7) return `${d}天前`;
  return new Date(then).toLocaleDateString("zh-CN", {
    month: "short",
    day: "numeric",
  });
}

/** Full absolute timestamp for a `title` tooltip (e.g. "2026年6月26日 14:08:31"). */
function absoluteTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Display label for a model id, stripping the [1m] suffix for readability. */
function modelLabel(model: string | null): string {
  if (!model) return "默认";
  const opt = MODEL_OPTIONS.find((o) => o.value === model);
  if (opt) return opt.label;
  // e.g. "claude-opus-4-8[1m]" → "Opus 4.8 (1M)"
  const base = model.replace(/^claude-/, "").replace(/\[1m\]$/i, "");
  const oneM = /\[1m\]$/i.test(model);
  const pretty = base
    .replace(/-/g, " ")
    .replace(/\b(opus|sonnet|haiku)\b/i, (w) => w[0].toUpperCase() + w.slice(1))
    .replace(/(\d) (\d)/, "$1.$2");
  return oneM ? `${pretty} (1M)` : pretty;
}

interface BrainThreadSummary {
  id: string;
  title: string;
  sessionId: string | null;
  hasSession: boolean;
  status: string;
  model: string | null;
  workspaceId: string | null;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface BrainEvent {
  id: string;
  seq: number;
  type: string;
  text: string | null;
  toolName: string | null;
  toolUseId: string | null;
  toolInput: unknown;
  toolResult: unknown;
  createdAt: string | null;
}

interface BrainThreadDetail {
  thread: {
    id: string;
    title: string;
    sessionId: string | null;
    status: string;
    workspaceId: string | null;
    cwd: string | null;
    error: string | null;
    updatedAt: string | null;
  };
  events: BrainEvent[];
}

function isThreadRunning(status: string | undefined): boolean {
  return status === "running";
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Short MCP tool name for display: mcp__orchestrator__runState → runState. */
function shortToolName(name: string | null): string {
  if (!name) return "tool";
  const parts = name.split("__");
  return parts[parts.length - 1] || name;
}

function isMcpTool(name: string | null): boolean {
  return !!name && name.startsWith("mcp__");
}

export default function BrainRoute() {
  const [searchParams] = useSearchParams();
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [showRepo, setShowRepo] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // ── Session-management UI state (search + status filter) ──
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Inline rename (rail) state.
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  // Delete confirmation target (the thread row awaiting hard-delete).
  const [deleteTarget, setDeleteTarget] = useState<BrainThreadSummary | null>(
    null,
  );

  // Open a thread from the ?thread=<id> query param (e.g. a tracker dispatch
  // hand-off navigates here). Only adopt it once so the user can still switch
  // threads from the rail without the URL snapping them back.
  const queryThreadId = searchParams.get("thread");
  const adoptedQueryThread = useRef(false);
  useEffect(() => {
    if (adoptedQueryThread.current) return;
    if (queryThreadId && queryThreadId.trim()) {
      adoptedQueryThread.current = true;
      setActiveThreadId(queryThreadId.trim());
    }
  }, [queryThreadId]);

  // The "已归档" pill is a synthetic filter: it sets includeArchived and asks the
  // action to return every status (archived rows can be done/error/etc).
  const isArchivedView = statusFilter === "archived";
  const debouncedSearch = useDebouncedValue(search.trim(), 250);

  const { data: threads = [], refetch: refetchThreads } = useActionQuery(
    "brain-threads" as any,
    {
      search: debouncedSearch || undefined,
      status: isArchivedView ? "all" : statusFilter,
      includeArchived: isArchivedView,
    },
    { refetchInterval: POLL_MS },
  ) as { data?: BrainThreadSummary[]; refetch: () => void };

  // In the archived view, show ONLY archived rows (the action returns archived +
  // non-archived when includeArchived is true).
  const visibleThreads = useMemo(
    () => (isArchivedView ? threads.filter((t) => t.archived) : threads),
    [threads, isArchivedView],
  );

  const { data: detail } = useActionQuery(
    "brain-thread" as any,
    activeThreadId ? { threadId: activeThreadId } : { threadId: "" },
    {
      enabled: !!activeThreadId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const d = query.state.data as BrainThreadDetail | undefined;
        return isThreadRunning(d?.thread?.status) ? POLL_MS : false;
      },
    },
  ) as { data?: BrainThreadDetail };

  const send = useActionMutation("brain-send" as any, {});
  const setTitle = useActionMutation("set-brain-thread-title" as any, {});
  const setArchived = useActionMutation("set-brain-thread-archived" as any, {});
  const deleteThread = useActionMutation("delete-brain-thread" as any, {});

  // Per-session CONTEXT panel — cheap DB-only poll of the active thread's model
  // + context fill. NO Anthropic call (account usage is the global sidebar
  // indicator). Reads the active thread's model/context when one is open.
  const { data: usage, refetch: refetchUsage } = useActionQuery(
    "brain-usage" as any,
    activeThreadId ? { threadId: activeThreadId } : {},
    { refetchInterval: CONTEXT_POLL_MS },
  ) as { data?: BrainUsage; refetch: () => void };

  const setModel = useActionMutation("set-brain-model" as any, {});

  // Fetch allowed model tier so the model Select only shows permitted options.
  const { data: tierData } = useActionQuery(
    "get-brain-model-tier" as any,
    {},
    { refetchInterval: 60_000 },
  ) as { data?: { tier: string; allowedModels: { id: string }[] } };
  const allowedModelValues = useMemo(() => {
    if (!tierData?.allowedModels) return new Set<string>();
    return new Set<string>(tierData.allowedModels.map((m) => m.id));
  }, [tierData]);

  const events = detail?.events ?? [];
  const threadStatus = detail?.thread?.status;
  const running = isThreadRunning(threadStatus) || send.isPending;
  const hasSession = !!detail?.thread?.sessionId;

  // Auto-scroll the transcript to the bottom as events stream in.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, threadStatus]);

  useEffect(() => {
    if (!renamingThreadId) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [renamingThreadId]);

  async function handleSend() {
    const text = message.trim();
    if (!text || send.isPending) return;
    const payload: Record<string, unknown> = { message: text };
    if (activeThreadId) payload.threadId = activeThreadId;
    if (!activeThreadId && showRepo && repo.trim()) {
      payload.repo = repo.trim();
      if (baseBranch.trim()) payload.baseBranch = baseBranch.trim();
    }
    try {
      const result = (await send.mutateAsync(payload)) as {
        threadId: string;
      };
      setMessage("");
      setActiveThreadId(result.threadId);
      refetchThreads();
    } catch {
      // The error surfaces on the thread (status=error) once it polls.
    }
  }

  function startNewSession() {
    setActiveThreadId(null);
    setMessage("");
    setRepo("");
    setBaseBranch("");
    setShowRepo(false);
  }

  async function handleModelChange(value: string) {
    // Map the "CLI default" sentinel back to the empty string the action expects.
    const model = value === DEFAULT_MODEL_VALUE ? "" : value;
    try {
      await setModel.mutateAsync({ model });
      // Reflect the pending switch immediately; the resolved init model lands on
      // the next brain turn.
      refetchUsage();
    } catch {
      // The Select snaps back to the server value on the next 30s poll.
    }
  }

  // ── Session management handlers ──
  function startRename(thread: BrainThreadSummary) {
    setRenameDraft(thread.title);
    setRenamingThreadId(thread.id);
  }

  function cancelRename() {
    setRenamingThreadId(null);
    setRenameDraft("");
  }

  async function commitRename() {
    const threadId = renamingThreadId;
    const title = renameDraft.trim();
    setRenamingThreadId(null);
    setRenameDraft("");
    if (!threadId || !title) return;
    try {
      await setTitle.mutateAsync({ threadId, title });
      refetchThreads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "重命名失败。");
    }
  }

  function handleRenameSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void commitRename();
  }

  async function handleArchive(thread: BrainThreadSummary, archived: boolean) {
    try {
      await setArchived.mutateAsync({ threadId: thread.id, archived });
      toast.success(archived ? "会话已归档。" : "已取消归档。");
      refetchThreads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "归档操作失败。");
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    try {
      await deleteThread.mutateAsync({ threadId: target.id });
      toast.success("会话已删除。");
      if (activeThreadId === target.id) setActiveThreadId(null);
      refetchThreads();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败。");
    } finally {
      setDeleteTarget(null);
    }
  }

  // The Select shows the configured override when set, else the live model.
  // An empty / unknown override maps to the "CLI default" sentinel (Radix Select
  // forbids an empty-string item value).
  const selectModelValue = usage?.configuredModel
    ? MODEL_OPTIONS.some((o) => o.value === usage.configuredModel)
      ? (usage.configuredModel as string)
      : DEFAULT_MODEL_VALUE
    : usage?.model && MODEL_OPTIONS.some((o) => o.value === usage.model)
      ? (usage.model as string)
      : DEFAULT_MODEL_VALUE;

  const composerPlaceholder = activeThreadId
    ? hasSession
      ? "在本会话中继续 —— 恢复同一个 Claude Code 会话…"
      : "向该会话发送后续消息…"
    : "为编排器大脑描述一个任务(它会自行决定怎么做 —— DAG、spawnOnce 或直接执行)…";

  const isFiltered = statusFilter !== "all" || search.trim().length > 0;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full">
      {/* Left rail: search + filter + thread list + new session */}
      <aside className="hidden w-72 shrink-0 flex-col border-r bg-muted/20 md:flex">
        <div className="flex items-center justify-between border-b px-3 py-3">
          <div className="flex items-center gap-2">
            <IconBrain className="h-4 w-4 text-violet-500" />
            <span className="text-sm font-semibold">大脑会话</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={startNewSession}
          >
            <IconPlus className="h-3.5 w-3.5" />
            新建
          </Button>
        </div>

        {/* Search box */}
        <div className="border-b px-3 py-2">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索会话(标题或 ID)…"
              className="h-8 pl-8 pr-7 text-xs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="清除搜索"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <IconX className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>

          {/* Status filter pills */}
          <div className="mt-2 flex flex-wrap gap-1">
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                  statusFilter === f.value
                    ? "bg-violet-500 text-white"
                    : "bg-muted text-muted-foreground hover:bg-accent"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {visibleThreads.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {isFiltered
                ? "没有符合条件的会话。"
                : "还没有会话。发送一个任务来开始。"}
            </p>
          ) : (
            <ul className="space-y-1">
              {visibleThreads.map((t) => {
                const isActive = t.id === activeThreadId;
                const isRenaming = t.id === renamingThreadId;
                return (
                  <li key={t.id}>
                    <div
                      className={`group relative flex flex-col gap-1 rounded-md px-2 py-2 transition-colors ${
                        isActive ? "bg-accent" : "hover:bg-accent/50"
                      }`}
                    >
                      {isRenaming ? (
                        <form onSubmit={handleRenameSubmit}>
                          <Input
                            ref={renameInputRef}
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            onBlur={() => void commitRename()}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                e.preventDefault();
                                cancelRename();
                              }
                            }}
                            maxLength={200}
                            aria-label="重命名会话"
                            className="h-7 text-xs"
                          />
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => setActiveThreadId(t.id)}
                            className="flex w-full flex-col gap-1 pr-6 text-left"
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`h-2 w-2 shrink-0 rounded-full ${
                                  STATUS_DOT[t.status] ?? "bg-slate-400"
                                }`}
                              />
                              <span className="truncate text-xs font-medium">
                                {t.title}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 pl-3.5">
                              <span className="text-[10px] text-muted-foreground">
                                {statusLabel(t.status)}
                              </span>
                              {t.archived ? (
                                <span className="text-[10px] text-muted-foreground">
                                  · 已归档
                                </span>
                              ) : null}
                              {/* Last-active time — relative for scannability, with
                                  the full absolute timestamp on hover. Right-aligned
                                  so it anchors cleanly without crowding the status. */}
                              {t.updatedAt || t.createdAt ? (
                                <span
                                  className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/80"
                                  title={`最后活动:${absoluteTime(
                                    t.updatedAt ?? t.createdAt,
                                  )}${
                                    t.createdAt
                                      ? `\n创建于:${absoluteTime(t.createdAt)}`
                                      : ""
                                  }`}
                                >
                                  {relativeAge(t.updatedAt ?? t.createdAt)}
                                </span>
                              ) : null}
                            </div>
                          </button>

                          {/* Per-thread action menu */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label="会话操作"
                                className="absolute right-1.5 top-2 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                              >
                                <IconDots className="h-4 w-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" side="right">
                              <DropdownMenuItem onSelect={() => startRename(t)}>
                                <IconEdit className="h-4 w-4" />
                                重命名
                              </DropdownMenuItem>
                              {t.archived ? (
                                <DropdownMenuItem
                                  onSelect={() => void handleArchive(t, false)}
                                >
                                  <IconArchiveOff className="h-4 w-4" />
                                  取消归档
                                </DropdownMenuItem>
                              ) : (
                                <DropdownMenuItem
                                  onSelect={() => void handleArchive(t, true)}
                                >
                                  <IconArchive className="h-4 w-4" />
                                  归档
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
                                onSelect={() => setDeleteTarget(t)}
                              >
                                <IconTrash className="h-4 w-4" />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main: transcript + composer */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b">
          <div className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <IconBrain className="h-4 w-4 text-violet-500 md:hidden" />
                {detail?.thread?.title ?? "编排器大脑"}
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                {activeThreadId
                  ? hasSession
                    ? `会话 ${detail?.thread?.sessionId?.slice(0, 8)}`
                    : "新会话 —— 将创建一个 Claude Code 会话"
                  : "Claude Code 会话,以编排器 actions 作为 MCP 工具。"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                >
                  <IconLoader2 className="h-3 w-3 animate-spin" />
                  运行中
                </Badge>
              ) : threadStatus === "error" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                >
                  <IconAlertTriangle className="h-3 w-3" />
                  失败
                </Badge>
              ) : threadStatus === "done" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                >
                  <IconCheck className="h-3 w-3" />
                  完成
                </Badge>
              ) : null}
            </div>
          </div>
          <UsagePanel
            usage={usage}
            selectModelValue={selectModelValue}
            onModelChange={handleModelChange}
            switching={setModel.isPending}
            allowedModelValues={allowedModelValues}
          />
        </header>

        {/* Transcript */}
        <div ref={transcriptRef} className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <IconBrain className="h-10 w-10 text-violet-500/60" />
                <div>
                  <p className="text-sm font-medium">编排器大脑</p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                    给它一个任务。它会自主决定怎么做 —— 编写并运行一个
                    DAG、派发一次性 agent,或直接执行 —— 通过轮询监控,并带着运行
                    / 工作区 / PR 链接汇报。
                  </p>
                </div>
              </div>
            ) : (
              events.map((ev) => <EventRow key={ev.id} event={ev} />)
            )}
            {running ? (
              <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                大脑正在工作…
              </div>
            ) : null}
          </div>
        </div>

        {/* Composer */}
        <div className="border-t bg-background px-4 py-3">
          <div className="mx-auto w-full max-w-3xl space-y-2">
            {!activeThreadId && showRepo ? (
              <div className="flex flex-wrap gap-2">
                <Input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="仓库 URL(可选)—— 会先克隆一个工作区"
                  className="h-8 flex-1 text-xs"
                />
                <Input
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder="基准分支(main)"
                  className="h-8 w-40 text-xs"
                />
              </div>
            ) : null}
            <div className="flex items-end gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder={composerPlaceholder}
                className="min-h-[44px] flex-1 resize-none text-sm"
                rows={2}
              />
              <Button
                onClick={() => void handleSend()}
                disabled={!message.trim() || send.isPending}
                className="h-11 gap-1.5"
              >
                {activeThreadId && hasSession ? (
                  <IconArrowBackUp className="h-4 w-4" />
                ) : (
                  <IconSend className="h-4 w-4" />
                )}
                {activeThreadId && hasSession ? "继续" : "发送"}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground">
                Cmd/Ctrl + Enter 发送。
              </div>
              {!activeThreadId ? (
                <button
                  type="button"
                  onClick={() => setShowRepo((v) => !v)}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  {showRepo ? "隐藏仓库" : "附加仓库"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </main>

      {/* Delete confirmation (shadcn AlertDialog — no browser confirm()) */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个会话?</AlertDialogTitle>
            <AlertDialogDescription>
              这会永久删除会话「{deleteTarget?.title}
              」及其完整记录,无法撤销。运行中的会话不能删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteThread.isPending}>
              取消
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmDelete();
              }}
              disabled={deleteThread.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteThread.isPending ? "删除中…" : "删除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Debounce a value by `delay` ms (used for the session search box). */
function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/**
 * Per-message timestamp — relative for scannability with the full absolute time
 * on hover. `align` matches the bubble side so it sits under it without clutter.
 */
function MessageTime({
  iso,
  align = "left",
}: {
  iso: string | null;
  align?: "left" | "right";
}) {
  if (!iso) return null;
  return (
    <span
      className={`mt-0.5 block text-[10px] tabular-nums text-muted-foreground/70 ${
        align === "right" ? "text-right" : "text-left"
      }`}
      title={absoluteTime(iso)}
    >
      {relativeAge(iso)}
    </span>
  );
}

function EventRow({ event }: { event: BrainEvent }) {
  if (event.type === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="flex max-w-[85%] items-start gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          <span className="whitespace-pre-wrap break-words">{event.text}</span>
          <IconUser className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
        </div>
        <MessageTime iso={event.createdAt} align="right" />
      </div>
    );
  }

  if (event.type === "assistant" || event.type === "result") {
    const isResult = event.type === "result";
    return (
      <div className="flex items-start gap-2">
        <IconBrain
          className={`mt-1 h-4 w-4 shrink-0 ${
            isResult ? "text-emerald-500" : "text-violet-500"
          }`}
        />
        <div className="flex min-w-0 flex-col">
          <div
            className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm ${
              isResult
                ? "border-emerald-500/30 bg-emerald-500/5"
                : "bg-muted/40"
            }`}
          >
            {event.text}
          </div>
          <MessageTime iso={event.createdAt} align="left" />
        </div>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="flex items-start gap-2">
        <IconAlertTriangle className="mt-1 h-4 w-4 shrink-0 text-red-500" />
        <div className="flex min-w-0 flex-col">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
            {event.text}
          </div>
          <MessageTime iso={event.createdAt} align="left" />
        </div>
      </div>
    );
  }

  if (event.type === "tool_use") {
    return <ToolUseRow event={event} />;
  }

  // tool_result rows are folded into their tool_use card visually, but render
  // standalone too in case ordering separates them.
  if (event.type === "tool_result") {
    const text = stringifyValue(event.toolResult);
    if (!text.trim()) return null;
    return (
      <Collapsible>
        <div className="ml-6 rounded-md border border-border/60 bg-background">
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/40">
            <IconChevronRight className="h-3 w-3 transition-transform group-data-[state=open]:rotate-90" />
            工具结果
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="max-h-72 overflow-auto border-t bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">
              {text}
            </pre>
          </CollapsibleContent>
        </div>
      </Collapsible>
    );
  }

  return null;
}

function UsagePanel({
  usage,
  selectModelValue,
  onModelChange,
  switching,
  allowedModelValues,
}: {
  usage: BrainUsage | undefined;
  selectModelValue: string;
  onModelChange: (value: string) => void;
  switching: boolean;
  allowedModelValues: Set<string>;
}) {
  const ctx = usage?.context;
  const ctxPct = ctx?.pct ?? null;
  const ctxSeverity: Severity =
    ctxPct == null
      ? "normal"
      : ctxPct >= 90
        ? "critical"
        : ctxPct >= 70
          ? "warning"
          : "normal";

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t bg-muted/20 px-4 py-2.5">
      {/* Model + switch */}
      <div className="flex items-center gap-2">
        <IconCpu className="h-3.5 w-3.5 shrink-0 text-violet-500" />
        <Select
          value={selectModelValue}
          onValueChange={onModelChange}
          disabled={switching}
        >
          <SelectTrigger className="h-7 w-[150px] gap-1 px-2 text-xs">
            <SelectValue placeholder={modelLabel(usage?.model ?? null)} />
          </SelectTrigger>
          <SelectContent>
            {MODEL_OPTIONS.filter(
              (o) =>
                o.value === DEFAULT_MODEL_VALUE ||
                allowedModelValues.size === 0 ||
                allowedModelValues.has(o.value),
            ).map((o) => (
              <SelectItem key={o.value} value={o.value} className="text-xs">
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {switching ? (
          <IconLoader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {/* Context gauge (per-session, DB-only — no Anthropic call) */}
      <div className="flex min-w-[170px] flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">上下文</span>
          <span className="font-medium tabular-nums">
            {formatTokens(ctx?.used ?? null)} /{" "}
            {ctx?.window === 1_000_000
              ? "1M"
              : formatTokens(ctx?.window ?? null)}
            {ctxPct != null ? (
              <span className="ml-1 text-muted-foreground">({ctxPct}%)</span>
            ) : null}
          </span>
        </div>
        <UsageBar pct={ctxPct ?? 0} severity={ctxSeverity} />
      </div>

      {/* Account-level subscription usage (5h / weekly / plan) now lives in the
          single GLOBAL sidebar indicator — not duplicated per session. */}
      <div className="ml-auto text-[10px] text-muted-foreground">
        账户用量见左侧边栏
      </div>
    </div>
  );
}

function UsageBar({ pct, severity }: { pct: number; severity: Severity }) {
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
      <div
        className={`h-full rounded-full transition-all ${severityBar(severity)}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function ToolUseRow({ event }: { event: BrainEvent }) {
  const name = shortToolName(event.toolName);
  const mcp = isMcpTool(event.toolName);
  const input = stringifyValue(event.toolInput);
  return (
    <Collapsible defaultOpen>
      <div className="ml-6 overflow-hidden rounded-md border border-border/60 bg-card">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/40">
          <IconChevronRight className="h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          <IconTool
            className={`h-3.5 w-3.5 shrink-0 ${
              mcp ? "text-violet-500" : "text-sky-500"
            }`}
          />
          <span className="font-mono font-medium">{name}</span>
          {mcp ? (
            <Badge
              variant="secondary"
              className="h-4 px-1.5 text-[10px] font-normal"
            >
              MCP
            </Badge>
          ) : null}
        </CollapsibleTrigger>
        <CollapsibleContent>
          {input.trim() ? (
            <pre className="max-h-60 overflow-auto border-t bg-muted/40 px-3 py-2 text-[11px] leading-relaxed">
              {input}
            </pre>
          ) : null}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
