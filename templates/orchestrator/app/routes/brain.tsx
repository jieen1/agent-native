import { useActionQuery, useActionMutation } from "@agent-native/core/client";
import {
  IconBrain,
  IconPlus,
  IconSend,
  IconTool,
  IconChevronRight,
  IconUser,
  IconCheck,
  IconAlertTriangle,
  IconAlertOctagon,
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
  IconEngine,
  IconIdBadge2,
  IconGauge,
  IconCertificate,
  IconStack2,
  IconClockBolt,
  IconShieldCheck,
  IconFolder,
  IconGitBranch,
  IconClipboardList,
  IconExternalLink,
  IconListDetails,
  IconCornerDownRight,
  IconBell,
  IconRun,
  IconChevronDown,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  STATUS_DOT,
  durationMs,
  fmtDuration,
  statusBadgeClass,
} from "@/components/v3/v3-format";
import { useClaudeStatus } from "@/hooks/use-orchestrator";
import { APP_TITLE } from "@/lib/app-config";

export function meta() {
  return [{ title: `${APP_TITLE} — 大脑` }];
}

const POLL_MS = 1500;
// The context panel + most side-panel cards poll on a slower cadence than the
// 1.5s transcript poll — all of them are cheap, DB-only reads (no Anthropic
// call), but there is no reason to hit the DB every 1.5s for numbers that
// change on the order of minutes.
const CONTEXT_POLL_MS = 30000;
const SIDE_PANEL_POLL_MS = 20000;
const QUEUE_POLL_MS = 10000;

// Accepted model ids for the switch Select (kept in sync with
// server/brain/brain-model.ts). Radix Select forbids an empty-string item value,
// so the unset state uses a sentinel mapped back to "" at the action boundary —
// unset now resolves to DEFAULT_BRAIN_MODEL (Sonnet 5 1M), not the CLI default.
const DEFAULT_MODEL_VALUE = "__default__";
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT_MODEL_VALUE, label: "默认 · Sonnet 5 (1M)" },
  { value: "claude-sonnet-5[1m]", label: "Sonnet 5 (1M)" },
  { value: "claude-opus-4-8", label: "Opus 4.8" },
  { value: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
  { value: "claude-fable-5", label: "Fable 5" },
];

// A saved openai-compatible/vllm runtime_configs row can ALSO drive the brain
// (kept in sync with server/brain/brain-model.ts's RUNTIME_MODEL_PREFIX). The
// model Select merges the caller's own non-claude-code `list-runtime-configs`
// rows into MODEL_OPTIONS as `runtime:<id>` values — see runtimeModelOptions.
const RUNTIME_MODEL_PREFIX = "runtime:";

// Composer template quick-reply chips (04 §6: "新增模板快捷 chips"). Clicking
// one appends the canonical instruction text to the draft message.
const TEMPLATE_CHIPS: { label: string; text: string }[] = [
  { label: "按 issue-pipeline 处理", text: "按 issue-pipeline 处理。" },
  { label: "只分析不动代码", text: "只分析,不要改动任何代码。" },
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
  /** Non-null only when the saved override is a `runtime:<id>` selector. */
  runtimeOverrideId?: string | null;
  context: {
    used: number | null;
    window: number | null;
    pct: number | null;
    windowDerived?: boolean;
  };
}

/** A saved model runtime (list-runtime-configs row) that can drive the brain. */
interface RuntimeConfigRow {
  id: string;
  name: string;
  kind: "vllm" | "openai-compatible" | "claude-code";
  baseUrl: string | null;
  model: string | null;
  models: string[];
  active: boolean;
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

/** Truncate to a single-line preview; callers show the full text behind an expand toggle. */
function truncatePreview(
  text: string,
  max = 160,
): { preview: string; truncated: boolean } {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return { preview: oneLine, truncated: false };
  return { preview: `${oneLine.slice(0, max)}…`, truncated: true };
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
  closingAnomaly: string | null;
  degraded: boolean;
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
    closingAnomaly: string | null;
    monitorIntervalSec: number | null;
    updatedAt: string | null;
  };
  events: BrainEvent[];
}

interface BrainHarnessStatusData {
  harnessRequested: boolean;
  enabled: boolean;
  degradedReason: string | null;
  lastEvent: {
    reason: string | null;
    threadId: string | null;
    ts: string | null;
  } | null;
  eventCount: number;
}

interface ModelRegistryRow {
  id: string;
  realName: string;
  alias: string;
  tier: string | null;
  endpoint: string | null;
  isClaudeWeight: boolean;
  createdAt: string | null;
}

interface AliasChangeEvent {
  id: string;
  alias: string | null;
  previousRealName: string | null;
  newRealName: string | null;
  ts: string | null;
}

interface BrainQueueStatusData {
  brainConcurrency: number;
  running: number;
  queued: number;
  byStatus: Record<string, number>;
  driverAlive: boolean;
  lastTickAt: string | null;
}

interface BrainTaskSlotData {
  status: string | null;
  runId: string | null;
  updatedAt: string | null;
  repo: string | null;
  baseBranch: string | null;
  tags: Record<string, string> | null;
}

interface BrainDisciplineMetricsData {
  deniedFileEdits: number;
  vllmTokensToday: number;
}

interface FallbackEngineData {
  model: string;
  endpointHost: string | null;
  configured: boolean;
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
  // Model-registry registration dialog.
  const [registerOpen, setRegisterOpen] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

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

  const { data: detail, refetch: refetchDetail } = useActionQuery(
    "brain-thread" as any,
    activeThreadId ? { threadId: activeThreadId } : { threadId: "" },
    {
      enabled: !!activeThreadId,
      refetchInterval: (query: { state: { data?: unknown } }) => {
        const d = query.state.data as BrainThreadDetail | undefined;
        return isThreadRunning(d?.thread?.status) ? POLL_MS : false;
      },
    },
  ) as { data?: BrainThreadDetail; refetch: () => void };

  const send = useActionMutation("brain-send" as any, {});
  const setTitle = useActionMutation("set-brain-thread-title" as any, {});
  const setArchived = useActionMutation("set-brain-thread-archived" as any, {});
  const deleteThread = useActionMutation("delete-brain-thread" as any, {});
  const registerModel = useActionMutation("registry-upsert-model" as any, {});
  const setMonitorInterval = useActionMutation(
    "set-brain-monitor-interval" as any,
    {},
  );

  const events = detail?.events ?? [];
  const threadStatus = detail?.thread?.status;
  const running = isThreadRunning(threadStatus) || send.isPending;
  const hasSession = !!detail?.thread?.sessionId;

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

  // The caller's own saved model runtimes (vLLM/OpenAI-compatible endpoints)
  // that can ALSO drive the brain — merged into the model Select below as
  // `runtime:<id>` options, alongside the Claude MODEL_OPTIONS.
  const { data: runtimeConfigs = [] } = useActionQuery(
    "list-runtime-configs" as any,
    {},
    { refetchInterval: 60_000 },
  ) as { data?: RuntimeConfigRow[] };
  const runtimeModelOptions = useMemo(
    () =>
      runtimeConfigs
        .filter((r) => r.kind !== "claude-code")
        .map((r) => ({
          value: `${RUNTIME_MODEL_PREFIX}${r.id}`,
          label: `${r.name} · ${r.model ?? r.baseUrl ?? r.id}`,
        })),
    [runtimeConfigs],
  );
  const allModelOptions = useMemo(
    () => [...MODEL_OPTIONS, ...runtimeModelOptions],
    [runtimeModelOptions],
  );

  // ── Managed Claude Code login (whether the primary "claude-code" engine is
  // actually the one driving turns, vs the sdk-vllm fallback) ──
  const { data: claudeStatus } = useClaudeStatus();

  // ── F7 capability-degradation status (04 §6/§7, SDLC-049) ──
  const { data: harnessStatus } = useActionQuery(
    "get-brain-harness-status" as any,
    {},
    { refetchInterval: SIDE_PANEL_POLL_MS },
  ) as { data?: BrainHarnessStatusData };

  // ── F7 model registry (04 §7, SDLC-054) ──
  const { data: registryModels = [], refetch: refetchModels } = useActionQuery(
    "registry-list-models" as any,
    {},
    { refetchInterval: SIDE_PANEL_POLL_MS },
  ) as { data?: ModelRegistryRow[]; refetch: () => void };
  const { data: aliasEvents } = useActionQuery(
    "registry-alias-events" as any,
    { windowDays: 7 },
    { refetchInterval: SIDE_PANEL_POLL_MS },
  ) as { data?: { events: AliasChangeEvent[]; recentCount: number } };

  // ── Fallback (vLLM/SDK) engine identity ──
  const { data: fallbackEngine } = useActionQuery(
    "get-brain-fallback-engine" as any,
    {},
    { refetchInterval: 60_000 },
  ) as { data?: FallbackEngineData };

  // ── Brain-task concurrency slots (LEVEL-1 queue) ──
  const { data: queueStatus } = useActionQuery(
    "brain-queue-status" as any,
    {},
    { refetchInterval: QUEUE_POLL_MS },
  ) as { data?: BrainQueueStatusData };

  // ── This thread's bound task (repo/baseBranch/tags + run — top context bar
  // + composer's persisted repo/sprint chips + this-thread slot state) ──
  const { data: taskSlot } = useActionQuery(
    "brain-task-slot" as any,
    activeThreadId ? { threadId: activeThreadId } : { threadId: "" },
    {
      enabled: !!activeThreadId,
      refetchInterval: running ? POLL_MS : QUEUE_POLL_MS,
    },
  ) as { data?: BrainTaskSlotData };

  // ── Discipline metrics (04 §6 "memory 红线可观察化") ──
  const { data: disciplineMetrics } = useActionQuery(
    "brain-discipline-metrics" as any,
    activeThreadId ? { threadId: activeThreadId } : { threadId: "" },
    { enabled: !!activeThreadId, refetchInterval: running ? 5000 : false },
  ) as { data?: BrainDisciplineMetricsData };

  // This thread's own workflowRun call count — computed from the ALREADY
  // loaded transcript (the full event history for the thread), not a new
  // server round-trip.
  const workflowRunCount = useMemo(
    () =>
      events.filter(
        (e) =>
          e.type === "tool_use" && shortToolName(e.toolName) === "workflowRun",
      ).length,
    [events],
  );

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

  function applyTemplateChip(text: string) {
    setMessage((prev) => (prev.trim() ? `${prev.trim()}\n${text}` : text));
  }

  async function handleModelChange(value: string) {
    // Map the "CLI default" sentinel back to the empty string the action expects.
    const model = value === DEFAULT_MODEL_VALUE ? "" : value;
    try {
      const result = (await setModel.mutateAsync({ model })) as {
        name?: string;
      };
      // A runtime-config switch echoes the resolved row's real name — show a
      // confirmation toast naming it (Claude switches keep their existing,
      // silent behavior; `name` is only present on the runtime: branch).
      if (result?.name) {
        toast.success(`大脑模型已切换为「${result.name}」。`);
      }
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

  async function handleRegisterSubmit(input: {
    realName: string;
    alias: string;
    tier?: string;
    isClaudeWeight: boolean;
  }) {
    setRegisterError(null);
    try {
      await registerModel.mutateAsync(input);
      toast.success("模型已登记。");
      setRegisterOpen(false);
      refetchModels();
    } catch (err) {
      setRegisterError(err instanceof Error ? err.message : "登记失败。");
    }
  }

  async function handleMonitorIntervalSave(sec: number) {
    if (!activeThreadId) return;
    try {
      await setMonitorInterval.mutateAsync({
        threadId: activeThreadId,
        monitorIntervalSec: sec,
      });
      toast.success("监控间隔已更新。");
      refetchDetail();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新失败。");
    }
  }

  // The Select shows the configured override when set, else the live model.
  // An empty / unknown override maps to the "CLI default" sentinel (Radix Select
  // forbids an empty-string item value). A saved `runtime:<id>` override is
  // checked FIRST, against the live merged runtime option list, so it resolves
  // to that row's real name instead of falling into the "unknown" bucket — if
  // the saved id no longer resolves to a live row (deleted), it falls through
  // to the SAME "unknown override" sentinel every other unrecognized value
  // already gets (server-side loudly logs the degradation separately).
  const selectModelValue = usage?.runtimeOverrideId
    ? allModelOptions.some(
        (o) => o.value === `${RUNTIME_MODEL_PREFIX}${usage.runtimeOverrideId}`,
      )
      ? `${RUNTIME_MODEL_PREFIX}${usage.runtimeOverrideId}`
      : DEFAULT_MODEL_VALUE
    : usage?.configuredModel
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
                              {t.degraded ? (
                                <span
                                  title="本线程曾在能力降级(raw-spawn 兜底)下运行"
                                  className="shrink-0 rounded bg-destructive/10 px-1 py-0 text-[9px] font-medium leading-4 text-destructive"
                                >
                                  降级
                                </span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-1.5 pl-3.5">
                              <span className="text-[10px] text-muted-foreground">
                                {statusLabel(t.status)}
                              </span>
                              {t.closingAnomaly ? (
                                <span
                                  title={t.closingAnomaly}
                                  className="shrink-0 rounded bg-amber-500/15 px-1 py-0 text-[9px] font-medium leading-4 text-amber-700 dark:text-amber-400"
                                >
                                  收尾异常
                                </span>
                              ) : null}
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
              {/* F7 turn-terminal-state contract (04 §6, SDLC-060): a delivered
                  turn whose closing race reported an error stays `done` — the
                  raw anomaly text is inspectable behind this badge instead of
                  the turn being misclassified as failed. */}
              {detail?.thread?.closingAnomaly ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${statusBadgeClass(
                        "queued",
                      )}`}
                    >
                      收尾异常
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 text-xs">
                    <p className="mb-1 font-medium">原始收尾事件(SDLC-060)</p>
                    <p className="mb-2 text-muted-foreground">
                      本轮已产出最终交付摘要,收尾竞态额外报告了一次
                      error_during_execution ——
                      线程按契约保留为「完成」,原始异常文本如下:
                    </p>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] text-muted-foreground">
                      {detail.thread.closingAnomaly}
                    </pre>
                  </PopoverContent>
                </Popover>
              ) : null}
              {running ? (
                <Badge
                  variant="secondary"
                  className={`gap-1 ${statusBadgeClass("running")}`}
                >
                  <IconLoader2 className="h-3 w-3 animate-spin" />
                  运行中
                </Badge>
              ) : threadStatus === "error" ? (
                <Badge
                  variant="secondary"
                  className={`gap-1 ${statusBadgeClass("error")}`}
                >
                  <IconAlertTriangle className="h-3 w-3" />
                  失败
                </Badge>
              ) : threadStatus === "done" ? (
                <Badge
                  variant="secondary"
                  className={`gap-1 ${statusBadgeClass("done")}`}
                >
                  <IconCheck className="h-3 w-3" />
                  完成
                </Badge>
              ) : null}
            </div>
          </div>
          <TaskContextBar taskSlot={taskSlot} />
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
              <Transcript events={events} />
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
            {/* Persisted repo/sprint context chips (this thread's bound task)
                + template quick-reply chips (04 §6). */}
            <div className="flex flex-wrap items-center gap-1.5">
              {activeThreadId && taskSlot?.repo ? (
                <ContextChip icon={IconFolder}>{taskSlot.repo}</ContextChip>
              ) : null}
              {activeThreadId && taskSlot?.baseBranch ? (
                <ContextChip icon={IconGitBranch}>
                  {taskSlot.baseBranch}
                </ContextChip>
              ) : null}
              <span className="ml-auto flex flex-wrap gap-1.5">
                {TEMPLATE_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => applyTemplateChip(c.text)}
                    className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400"
                  >
                    {c.label}
                  </button>
                ))}
              </span>
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

      {/* Right side panel — engine/model, model registry, capability
          degradation, context gauge, discipline metrics, concurrency slots,
          monitor cadence (04 §6). Hidden below xl to keep the transcript
          usable on narrower viewports, matching the left rail's own
          responsive convention. */}
      <aside className="hidden w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-muted/10 p-3 xl:flex">
        <EngineModelCard
          usage={usage}
          selectModelValue={selectModelValue}
          onModelChange={handleModelChange}
          switching={setModel.isPending}
          allowedModelValues={allowedModelValues}
          modelOptions={allModelOptions}
          tier={tierData?.tier ?? null}
          claudeLoggedIn={!!claudeStatus?.loggedIn}
          harnessEnabled={!!harnessStatus?.enabled}
          fallbackEngine={fallbackEngine}
        />
        <ModelRegistryCard
          models={registryModels}
          aliasEvents={aliasEvents}
          onOpenRegister={() => {
            setRegisterError(null);
            setRegisterOpen(true);
          }}
        />
        {harnessStatus?.degradedReason ? (
          <CapabilityDegradedCard status={harnessStatus} />
        ) : null}
        <ContextGaugeCard
          usage={usage}
          hasSession={hasSession}
          sessionId={detail?.thread?.sessionId ?? null}
        />
        <DisciplineMetricsCard
          workflowRunCount={activeThreadId ? workflowRunCount : null}
          metrics={disciplineMetrics}
        />
        <ConcurrencySlotsCard
          queueStatus={queueStatus}
          threadTaskStatus={activeThreadId ? (taskSlot?.status ?? null) : null}
        />
        <MonitorCadenceCard
          threadId={activeThreadId}
          monitorIntervalSec={detail?.thread?.monitorIntervalSec ?? null}
          onSave={handleMonitorIntervalSave}
          saving={setMonitorInterval.isPending}
        />
      </aside>

      <RegisterModelDialog
        open={registerOpen}
        onOpenChange={setRegisterOpen}
        onSubmit={handleRegisterSubmit}
        submitting={registerModel.isPending}
        error={registerError}
      />

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

/** Small icon+label chip (task-context bar + composer's persisted context chips). */
function ContextChip({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 text-[11.5px]">
      <Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Top fixed task-context bar (04 §6: "顶部固定任务上下文条(绑定的 tags:
 * 工作项/repo/baseBranch/run 深链)"). Only rendered once there is real bound
 * data to show — progressive disclosure, not an always-visible empty bar.
 */
function TaskContextBar({ taskSlot }: { taskSlot?: BrainTaskSlotData }) {
  if (!taskSlot) return null;
  const tags = taskSlot.tags ?? {};
  const itemId = tags.item_id ?? tags.itemId ?? null;
  const sprint = tags.sprint_id ?? tags.sprintId ?? tags.sprint ?? null;
  const hasAny = !!(itemId || taskSlot.repo || sprint || taskSlot.runId);
  if (!hasAny) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t px-4 py-2">
      <span className="mr-0.5 text-[11px] text-muted-foreground">
        任务上下文
      </span>
      {itemId ? (
        <ContextChip icon={IconClipboardList}>{itemId}</ContextChip>
      ) : null}
      {taskSlot.repo ? (
        <ContextChip icon={IconFolder}>{taskSlot.repo}</ContextChip>
      ) : null}
      {sprint ? <ContextChip icon={IconRun}>{sprint}</ContextChip> : null}
      {taskSlot.runId ? (
        <Link
          to={`/runs/${taskSlot.runId}`}
          className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 font-mono text-[11px] hover:border-violet-400 hover:text-violet-600 dark:hover:text-violet-400"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              STATUS_DOT[taskSlot.status ?? ""] ?? "bg-zinc-400"
            }`}
          />
          {taskSlot.runId}
          <IconExternalLink className="h-3 w-3" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * The transcript, with consecutive tool_use/tool_result activity collapsed
 * into a single "N 步 · 耗时" TimelineCollapse group (04 §6: "改用统一
 * TimelineCollapse 语汇(与 run 详情一致)") instead of one card per tool call.
 */
function Transcript({ events }: { events: BrainEvent[] }) {
  const items = useMemo(() => groupTranscript(events), [events]);
  return (
    <>
      {items.map((item) =>
        item.kind === "steps" ? (
          <StepsGroup key={item.id} events={item.events} />
        ) : (
          <EventRow key={item.event.id} event={item.event} />
        ),
      )}
    </>
  );
}

type TranscriptItem =
  | { kind: "event"; event: BrainEvent }
  | { kind: "steps"; id: string; events: BrainEvent[] };

function groupTranscript(events: BrainEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let buffer: BrainEvent[] = [];
  function flush() {
    if (buffer.length === 0) return;
    items.push({ kind: "steps", id: `steps-${buffer[0].id}`, events: buffer });
    buffer = [];
  }
  for (const ev of events) {
    if (ev.type === "tool_use" || ev.type === "tool_result") {
      buffer.push(ev);
    } else {
      flush();
      items.push({ kind: "event", event: ev });
    }
  }
  flush();
  return items;
}

interface StepPair {
  toolUse: BrainEvent;
  toolResult?: BrainEvent;
}

/** Pair each tool_use with its matching tool_result (by toolUseId) within one burst. */
function pairSteps(buffer: BrainEvent[]): {
  pairs: StepPair[];
  orphanResults: BrainEvent[];
} {
  const results = new Map<string, BrainEvent>();
  const usedResultIds = new Set<string>();
  for (const ev of buffer) {
    if (ev.type === "tool_result" && ev.toolUseId)
      results.set(ev.toolUseId, ev);
  }
  const pairs = buffer
    .filter((ev): ev is BrainEvent => ev.type === "tool_use")
    .map((toolUse) => {
      const toolResult = toolUse.toolUseId
        ? results.get(toolUse.toolUseId)
        : undefined;
      if (toolResult) usedResultIds.add(toolResult.id);
      return { toolUse, toolResult };
    });
  // Never silently drop evidence: a tool_result with no matching tool_use in
  // this burst (should not normally happen — appendEvent always writes the
  // pair together) still renders as a standalone row.
  const orphanResults = buffer.filter(
    (ev) => ev.type === "tool_result" && !usedResultIds.has(ev.id),
  );
  return { pairs, orphanResults };
}

function StepsGroup({ events }: { events: BrainEvent[] }) {
  const [open, setOpen] = useState(false);
  const { pairs, orphanResults } = useMemo(() => pairSteps(events), [events]);
  const first = events[0];
  const last = events[events.length - 1];
  const duration = fmtDuration(durationMs(first?.createdAt, last?.createdAt));

  return (
    <div className="ml-6 overflow-hidden rounded-md border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent/40"
      >
        <IconListDetails className="h-3.5 w-3.5 shrink-0" />
        <span className="font-semibold text-foreground">{pairs.length} 步</span>
        <span>·</span>
        <span className="font-mono">{duration}</span>
        <IconChevronDown
          className={`ml-auto h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open ? (
        <div className="border-t">
          {pairs.map((pair) => (
            <StepRow key={pair.toolUse.id} pair={pair} />
          ))}
          {orphanResults.map((ev) => (
            <div
              key={ev.id}
              className="flex items-start gap-2 border-b px-3 py-1.5 text-xs last:border-b-0"
            >
              <IconCornerDownRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="whitespace-pre-wrap break-words font-mono text-[11px] text-muted-foreground">
                {stringifyValue(ev.toolResult)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function StepRow({ pair }: { pair: StepPair }) {
  const [expanded, setExpanded] = useState(false);
  const { toolUse, toolResult } = pair;
  const name = shortToolName(toolUse.toolName);
  const mcp = isMcpTool(toolUse.toolName);
  const input = stringifyValue(toolUse.toolInput);
  const resultText = toolResult ? stringifyValue(toolResult.toolResult) : "";
  const { preview, truncated } = truncatePreview(resultText);

  return (
    <div className="border-b px-3 py-1.5 text-xs last:border-b-0">
      <div className="flex items-start gap-2">
        <IconTool
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${mcp ? "text-violet-500" : "text-sky-500"}`}
        />
        <div className="min-w-0 flex-1">
          <span className="font-mono font-semibold">{name}</span>
          {mcp ? (
            <Badge
              variant="secondary"
              className="ml-1.5 h-4 px-1.5 text-[10px] font-normal"
            >
              MCP
            </Badge>
          ) : null}
        </div>
        {input.trim() ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label="展开工具输入"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <IconChevronRight
              className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : null}
      </div>
      {expanded && input.trim() ? (
        <pre className="ml-5 mt-1.5 max-h-60 overflow-auto rounded bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed">
          {input}
        </pre>
      ) : null}
      {toolResult ? (
        <div className="ml-5 mt-1 flex items-start gap-1.5 text-muted-foreground">
          <IconCornerDownRight className="mt-0.5 h-3 w-3 shrink-0" />
          {truncated ? (
            <Collapsible>
              <CollapsibleTrigger className="text-left text-[11px] hover:text-foreground">
                {preview}
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted/40 px-2.5 py-1.5 text-[11px] leading-relaxed text-foreground">
                  {resultText}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <span className="text-[11px]">{preview}</span>
          )}
        </div>
      ) : null}
    </div>
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

  // The SDK/vLLM brain path (sdk-brain-session.ts) emits `system` events (mode
  // banner / MAX_STEPS notice) — previously silently dropped by this renderer.
  if (event.type === "system") {
    return (
      <div className="flex items-center gap-2 py-1 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        <IconBell className="h-3 w-3 shrink-0" />
        <span>{event.text}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // tool_use/tool_result are rendered inside StepsGroup — reaching EventRow with
  // one of these types would mean groupTranscript missed it; render nothing
  // rather than duplicate a card outside its group.
  return null;
}

function EngineModelCard({
  usage,
  selectModelValue,
  onModelChange,
  switching,
  allowedModelValues,
  modelOptions,
  tier,
  claudeLoggedIn,
  harnessEnabled,
  fallbackEngine,
}: {
  usage: BrainUsage | undefined;
  selectModelValue: string;
  onModelChange: (value: string) => void;
  switching: boolean;
  allowedModelValues: Set<string>;
  modelOptions: { value: string; label: string }[];
  tier: string | null;
  claudeLoggedIn: boolean;
  harnessEnabled: boolean;
  fallbackEngine: FallbackEngineData | undefined;
}) {
  // Mirrors brain-session.ts's own engine=... resolution exactly:
  // useSdkBrain = !login.loggedIn; useHarnessBrain = harnessEval.enabled.
  const engineName = claudeLoggedIn ? "claude-code" : "sdk-vllm";
  const engineMode = claudeLoggedIn
    ? harnessEnabled
      ? "acp"
      : "cli-resume"
    : "vllm-sdk";

  return (
    <SpCard>
      <SpTitle icon={IconEngine}>引擎与模型</SpTitle>
      <PropRow label="引擎">
        <HealthDot tone={claudeLoggedIn ? "ok" : "warn"} />
        <b className="font-mono">{engineName}</b>
        <Badge
          variant="secondary"
          className="h-4 px-1.5 font-mono text-[10px] font-normal"
        >
          {engineMode}
        </Badge>
      </PropRow>
      <PropRow label="模型">
        <Select
          value={selectModelValue}
          onValueChange={onModelChange}
          disabled={switching}
        >
          <SelectTrigger className="h-7 w-[150px] gap-1 px-2 text-xs">
            <SelectValue placeholder={modelLabel(usage?.model ?? null)} />
          </SelectTrigger>
          <SelectContent>
            {modelOptions
              .filter(
                (o) =>
                  o.value === DEFAULT_MODEL_VALUE ||
                  o.value.startsWith(RUNTIME_MODEL_PREFIX) ||
                  allowedModelValues.size === 0 ||
                  allowedModelValues.has(o.value),
              )
              .map((o) => (
                <SelectItem key={o.value} value={o.value} className="text-xs">
                  {o.label}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {tier ? (
          <Badge className="h-5 bg-violet-500/10 text-[10px] text-violet-600 dark:text-violet-400">
            tier: {tier}
          </Badge>
        ) : null}
        {switching ? (
          <IconLoader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null}
      </PropRow>
      <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <HealthDot tone={fallbackEngine?.configured ? "ok" : "muted"} />
        <span>
          兜底引擎 sdk-vllm({fallbackEngine?.model ?? "—"})
          {fallbackEngine?.endpointHost
            ? ` · ${fallbackEngine.endpointHost}`
            : ""}{" "}
          · {fallbackEngine?.configured ? "已配置" : "未配置"}
        </span>
      </div>
    </SpCard>
  );
}

function ModelRegistryCard({
  models,
  aliasEvents,
  onOpenRegister,
}: {
  models: ModelRegistryRow[];
  aliasEvents: { events: AliasChangeEvent[]; recentCount: number } | undefined;
  onOpenRegister: () => void;
}) {
  return (
    <SpCard>
      <SpTitle icon={IconIdBadge2}>模型注册表</SpTitle>
      {aliasEvents && aliasEvents.recentCount > 0 ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mb-2 flex w-full items-center gap-1.5 rounded-sm bg-amber-500/15 px-2 py-1 text-left text-[11px] text-amber-700 dark:text-amber-400"
            >
              <IconAlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {aliasEvents.recentCount} 条别名变更(7 天)· 点开时间线
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-80 text-xs">
            <p className="mb-2 font-medium">别名变更时间线</p>
            <ul className="max-h-60 space-y-2 overflow-y-auto">
              {aliasEvents.events.map((e) => (
                <li key={e.id} className="border-b pb-1.5 last:border-b-0">
                  <div className="font-mono text-[11px]">
                    {e.alias} : {e.previousRealName} → {e.newRealName}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {absoluteTime(e.ts)}
                  </div>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      ) : null}
      {models.length === 0 ? (
        <p className="py-2 text-[11.5px] text-muted-foreground">
          尚无登记模型。
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-6 px-0 text-[10px]">真名</TableHead>
              <TableHead className="h-6 px-0 text-[10px]">别名</TableHead>
              <TableHead className="h-6 px-0 text-[10px]">档位</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {models.map((m) => (
              <TableRow key={m.id} className="hover:bg-transparent">
                <TableCell className="px-0 py-1.5 font-mono text-[10.5px]">
                  {m.realName}
                  {m.isClaudeWeight ? (
                    <Badge className="ml-1 h-4 bg-violet-500/10 px-1 text-[9px] text-violet-600 dark:text-violet-400">
                      Claude 权重
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="px-0 py-1.5">
                  <Badge
                    variant="secondary"
                    className="h-4 px-1 font-mono text-[10px] font-normal"
                  >
                    {m.alias}
                  </Badge>
                </TableCell>
                <TableCell className="px-0 py-1.5 text-[10px] text-muted-foreground">
                  {m.tier ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-7 gap-1 text-xs"
        onClick={onOpenRegister}
      >
        <IconPlus className="h-3.5 w-3.5" />
        登记模型
      </Button>
    </SpCard>
  );
}

function RegisterModelDialog({
  open,
  onOpenChange,
  onSubmit,
  submitting,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: {
    realName: string;
    alias: string;
    tier?: string;
    isClaudeWeight: boolean;
  }) => void;
  submitting: boolean;
  error: string | null;
}) {
  const [realName, setRealName] = useState("");
  const [alias, setAlias] = useState("");
  const [tier, setTier] = useState("");
  const [isClaudeWeight, setIsClaudeWeight] = useState(false);

  useEffect(() => {
    if (open) {
      setRealName("");
      setAlias("");
      setTier("");
      setIsClaudeWeight(false);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>登记模型</DialogTitle>
          <DialogDescription>
            写入 v3_model_registry · alias 唯一
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>
              真名<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              value={realName}
              onChange={(e) => setRealName(e.target.value)}
              placeholder="如 ThinkingCap-Qwen3.6-27B"
            />
          </div>
          <div className="space-y-1">
            <Label>
              别名<span className="ml-0.5 text-destructive">*</span>
            </Label>
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="如 qwen3.6"
            />
          </div>
          <div className="space-y-1">
            <Label>档位</Label>
            <Input
              value={tier}
              onChange={(e) => setTier(e.target.value)}
              placeholder="如 本地 / sonnet"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch
              checked={isClaudeWeight}
              onCheckedChange={setIsClaudeWeight}
            />
            Claude 权重
          </label>
          {error ? (
            <p className="rounded-sm bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!realName.trim() || !alias.trim() || submitting}
            onClick={() =>
              onSubmit({
                realName: realName.trim(),
                alias: alias.trim(),
                tier: tier.trim() || undefined,
                isClaudeWeight,
              })
            }
          >
            {submitting ? "提交中…" : "提交"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CapabilityDegradedCard({
  status,
}: {
  status: BrainHarnessStatusData;
}) {
  return (
    <SpCard className="border-destructive/40">
      <SpTitle icon={IconAlertOctagon} className="text-destructive">
        能力降级
      </SpTitle>
      <p className="text-[11.5px] leading-relaxed">
        Harness 声明开启(<span className="font-mono">ORCH_BRAIN_HARNESS=1</span>
        )但 {status.degradedReason} —— 正以 raw-spawn 兜底运行。
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        capability.degraded · 累计 {status.eventCount} 次
        {status.lastEvent?.ts
          ? ` · 最近一次 ${relativeAge(status.lastEvent.ts)}`
          : ""}
      </p>
    </SpCard>
  );
}

function ContextGaugeCard({
  usage,
  hasSession,
  sessionId,
}: {
  usage: BrainUsage | undefined;
  hasSession: boolean;
  sessionId: string | null;
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
    <SpCard>
      <SpTitle icon={IconGauge}>上下文</SpTitle>
      <div className="flex items-center gap-3">
        <div className="w-14 shrink-0 text-center">
          <div className="text-lg font-semibold tabular-nums">
            {ctxPct != null ? `${ctxPct}%` : "—"}
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <UsageBar pct={ctxPct ?? 0} severity={ctxSeverity} />
          <div className="mt-1 text-[12px] font-medium tabular-nums">
            {formatTokens(ctx?.used ?? null)} /{" "}
            {ctx?.window === 1_000_000
              ? "1M"
              : formatTokens(ctx?.window ?? null)}
          </div>
          <div className="text-[11px] text-muted-foreground">
            tokens · {hasSession ? "会话可恢复" : "新会话"}
          </div>
          {sessionId ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              session {sessionId.slice(0, 4)}…{sessionId.slice(-2)}
            </div>
          ) : null}
        </div>
      </div>
    </SpCard>
  );
}

function DisciplineMetricsCard({
  workflowRunCount,
  metrics,
}: {
  workflowRunCount: number | null;
  metrics: BrainDisciplineMetricsData | undefined;
}) {
  const deniedFileEdits = metrics?.deniedFileEdits ?? 0;
  return (
    <SpCard>
      <SpTitle
        icon={IconCertificate}
        badge={
          // No dedicated --evidence token exists yet on this branch (see
          // orch-design-system-foundation) — approximated with a literal
          // violet/evidence-ish tone; replace with the shared token once merged.
          <Badge className="h-4 bg-violet-500/10 px-1.5 text-[9px] font-normal text-violet-600 dark:text-violet-400">
            全部变更经 DAG
          </Badge>
        }
      >
        纪律指标
      </SpTitle>
      <MetricRow
        icon={<IconCheck className="h-3.5 w-3.5 text-emerald-500" />}
        label="workflowRun 调用"
        value={workflowRunCount ?? "—"}
      />
      <MetricRow
        icon={<IconCpu className="h-3.5 w-3.5 text-muted-foreground" />}
        label="vLLM 工人 token · 今日"
        value={formatTokens(metrics?.vllmTokensToday ?? null)}
      />
      <MetricRow
        icon={<IconShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />}
        label="直改文件告警"
        value={deniedFileEdits}
        warn={deniedFileEdits > 0}
      />
    </SpCard>
  );
}

function ConcurrencySlotsCard({
  queueStatus,
  threadTaskStatus,
}: {
  queueStatus: BrainQueueStatusData | undefined;
  threadTaskStatus: string | null;
}) {
  const total = queueStatus?.brainConcurrency ?? 0;
  const used = queueStatus?.running ?? 0;
  return (
    <SpCard>
      <SpTitle icon={IconStack2}>并发槽</SpTitle>
      <div className="flex items-center justify-between text-[12.5px]">
        <span className="text-muted-foreground">Brain 并发</span>
        <span className="font-mono">
          <b>{used}</b> / {total || "—"}
        </span>
      </div>
      <SlotBar total={total} used={used} />
      {threadTaskStatus ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          本线程槽位:{statusLabel(threadTaskStatus)}
        </div>
      ) : null}
    </SpCard>
  );
}

function MonitorCadenceCard({
  threadId,
  monitorIntervalSec,
  onSave,
  saving,
}: {
  threadId: string | null;
  monitorIntervalSec: number | null;
  onSave: (sec: number) => void;
  saving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(monitorIntervalSec ?? 120));

  useEffect(() => {
    if (!editing) setDraft(String(monitorIntervalSec ?? 120));
  }, [monitorIntervalSec, editing]);

  function commit() {
    const n = Number(draft);
    setEditing(false);
    if (!threadId || !Number.isFinite(n) || n < 0) return;
    onSave(Math.round(n));
  }

  return (
    <SpCard>
      <SpTitle icon={IconClockBolt}>监控节奏</SpTitle>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="w-14 shrink-0 text-[12px] text-muted-foreground">
          监控间隔
        </span>
        {editing ? (
          <>
            <Input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") setEditing(false);
              }}
              className="h-7 w-16 font-mono text-xs"
              disabled={saving}
            />
            <span className="text-[11px] text-muted-foreground">
              秒 · 0 = 纯事件驱动
            </span>
          </>
        ) : (
          <button
            type="button"
            disabled={!threadId}
            onClick={() => setEditing(true)}
            className="rounded-md border px-2 py-0.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {monitorIntervalSec ?? 120}
            <span className="ml-1 text-muted-foreground">秒</span>
          </button>
        )}
      </div>
      {!threadId ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          选择一个会话后可编辑。
        </p>
      ) : null}
    </SpCard>
  );
}

function SpCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border bg-card p-3 ${className}`}>
      {children}
    </div>
  );
}

function SpTitle({
  icon: Icon,
  children,
  badge,
  className = "",
}: {
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${className}`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
      {badge ? (
        <span className="ml-auto normal-case tracking-normal">{badge}</span>
      ) : null}
    </div>
  );
}

function PropRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-[12.5px]">
      <span className="w-12 shrink-0 text-[12px] text-muted-foreground">
        {label}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
    </div>
  );
}

function MetricRow({
  icon,
  label,
  value,
  warn,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  warn?: boolean;
}) {
  return (
    <div className="flex items-center gap-2 py-1 text-[12.5px]">
      {icon}
      <span className="flex-1 text-muted-foreground">{label}</span>
      <span
        className={`font-mono font-semibold ${warn ? "text-destructive" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function SlotBar({ total, used }: { total: number; used: number }) {
  const n = Math.max(total, 1);
  return (
    <div className="mt-1.5 flex gap-1">
      {Array.from({ length: n }).map((_, i) => (
        <span
          key={i}
          className={`h-1.5 flex-1 rounded-full ${i < used ? "bg-violet-500" : "bg-muted"}`}
        />
      ))}
    </div>
  );
}

function HealthDot({ tone }: { tone: "ok" | "warn" | "down" | "muted" }) {
  const cls =
    tone === "ok"
      ? "bg-emerald-500"
      : tone === "warn"
        ? "bg-amber-500"
        : tone === "down"
          ? "bg-red-500"
          : "bg-zinc-400";
  return (
    <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />
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
