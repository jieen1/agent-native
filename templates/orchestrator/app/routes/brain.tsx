import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { useActionQuery, useActionMutation } from "@agent-native/core/client";
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
  IconClock,
  IconCalendarTime,
  IconCpu,
  IconCrown,
} from "@tabler/icons-react";

export function meta() {
  return [{ title: `${APP_TITLE} — Brain` }];
}

const POLL_MS = 1500;
// The usage panel polls on a slower cadence than the 1.5s transcript poll — the
// oauth/usage endpoint is rate-limited and the action caches it ~45s anyway.
const USAGE_POLL_MS = 30000;

// Accepted model ids/aliases for the switch Select (kept in sync with
// server/brain/brain-model.ts). Radix Select forbids an empty-string item value,
// so "CLI default" uses a sentinel mapped back to "" at the action boundary.
const DEFAULT_MODEL_VALUE = "__default__";
const MODEL_OPTIONS: { value: string; label: string }[] = [
  { value: DEFAULT_MODEL_VALUE, label: "CLI default" },
  { value: "claude-opus-4-8", label: "Opus 4.8 (1M)" },
  { value: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)" },
  { value: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M)" },
  { value: "claude-opus-4-5", label: "Opus 4.5" },
  { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { value: "claude-sonnet-4-5[1m]", label: "Sonnet 4.5 (1M)" },
  { value: "claude-haiku-4-5", label: "Haiku 4.5" },
];

type Severity = "normal" | "warning" | "critical";

interface UsageWindow {
  utilizationPct: number;
  resetsAt: string | null;
  severity: Severity;
}

interface BrainUsage {
  available: boolean;
  reason: string | null;
  fetchedAt: string | null;
  cached: boolean;
  stale: boolean;
  model: string | null;
  configuredModel: string | null;
  context: { used: number | null; window: number | null; pct: number | null };
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  planTier: string | null;
  plan: string | null;
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

/** "resets in 2h 14m" from an ISO timestamp; "" when null/past. */
function relativeReset(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Short calendar date for the weekly reset (e.g. "Jul 1"). */
function shortDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Pretty plan tier: default_claude_max_20x → "Claude Max 20x". */
function prettyTier(tier: string | null, plan: string | null): string | null {
  if (!tier && !plan) return null;
  const raw = tier ?? plan ?? "";
  const m = raw.match(/max[_-]?(\d+x)/i);
  if (m) return `Claude Max ${m[1]}`;
  if (/pro/i.test(raw)) return "Claude Pro";
  if (/team/i.test(raw)) return "Claude Team";
  // Fallback: humanize the raw token.
  return (
    raw
      .replace(/^default[_-]/, "")
      .replace(/_/g, " ")
      .replace(/\bclaude\b/i, "Claude")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || raw
  );
}

/** Display label for a model id, stripping the [1m] suffix for readability. */
function modelLabel(model: string | null): string {
  if (!model) return "default";
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
  workspaceId: string | null;
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

  const { data: threads = [], refetch: refetchThreads } = useActionQuery(
    "brain-threads" as any,
    {},
    { refetchInterval: POLL_MS },
  ) as { data?: BrainThreadSummary[]; refetch: () => void };

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

  // Live usage panel — polls the brain-usage action at 30s (NOT the 1.5s
  // transcript poll). Reads the active thread's model/context when one is open.
  const { data: usage, refetch: refetchUsage } = useActionQuery(
    "brain-usage" as any,
    activeThreadId ? { threadId: activeThreadId } : {},
    { refetchInterval: USAGE_POLL_MS },
  ) as { data?: BrainUsage; refetch: () => void };

  const setModel = useActionMutation("set-brain-model" as any, {});

  const events = detail?.events ?? [];
  const threadStatus = detail?.thread?.status;
  const running = isThreadRunning(threadStatus) || send.isPending;
  const hasSession = !!detail?.thread?.sessionId;

  // Auto-scroll the transcript to the bottom as events stream in.
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, threadStatus]);

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
      ? "Continue in this session — resumes the same Claude Code session…"
      : "Send a follow-up to this thread…"
    : "Describe a task for the orchestrator brain (it decides how — DAG, spawnOnce, or direct work)…";

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full">
      {/* Left rail: thread list + new session */}
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-muted/20 md:flex">
        <div className="flex items-center justify-between border-b px-3 py-3">
          <div className="flex items-center gap-2">
            <IconBrain className="h-4 w-4 text-violet-500" />
            <span className="text-sm font-semibold">Brain</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            onClick={startNewSession}
          >
            <IconPlus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {threads.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              No sessions yet. Send a task to start one.
            </p>
          ) : (
            <ul className="space-y-1">
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => setActiveThreadId(t.id)}
                    className={`flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left transition-colors ${
                      t.id === activeThreadId
                        ? "bg-accent"
                        : "hover:bg-accent/50"
                    }`}
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
                      {t.hasSession ? (
                        <span className="text-[10px] text-muted-foreground">
                          resumable
                        </span>
                      ) : null}
                      <span className="text-[10px] capitalize text-muted-foreground">
                        {t.status}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
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
                {detail?.thread?.title ?? "Orchestrator Brain"}
              </h1>
              <p className="truncate text-xs text-muted-foreground">
                {activeThreadId
                  ? hasSession
                    ? `Session ${detail?.thread?.sessionId?.slice(0, 8)} — resumes across tasks`
                    : "New thread — a Claude Code session will be created"
                  : "A persistent, resumable Claude Code session with the orchestrator actions as MCP tools."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {running ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400"
                >
                  <IconLoader2 className="h-3 w-3 animate-spin" />
                  running
                </Badge>
              ) : threadStatus === "error" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
                >
                  <IconAlertTriangle className="h-3 w-3" />
                  error
                </Badge>
              ) : threadStatus === "done" ? (
                <Badge
                  variant="secondary"
                  className="gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                >
                  <IconCheck className="h-3 w-3" />
                  done
                </Badge>
              ) : null}
            </div>
          </div>
          <UsagePanel
            usage={usage}
            selectModelValue={selectModelValue}
            onModelChange={handleModelChange}
            switching={setModel.isPending}
          />
        </header>

        {/* Transcript */}
        <div ref={transcriptRef} className="flex-1 overflow-y-auto px-4 py-4">
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {events.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <IconBrain className="h-10 w-10 text-violet-500/60" />
                <div>
                  <p className="text-sm font-medium">The orchestrator brain</p>
                  <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
                    Give it a task. It autonomously decides how — author and run
                    a DAG, spawn a one-shot agent, or work directly — monitors
                    by polling, and reports back with run / workspace / PR
                    links.
                  </p>
                </div>
              </div>
            ) : (
              events.map((ev) => <EventRow key={ev.id} event={ev} />)
            )}
            {running ? (
              <div className="flex items-center gap-2 pl-1 text-xs text-muted-foreground">
                <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                Brain is working…
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
                  placeholder="Repo URL (optional) — clones a workspace first"
                  className="h-8 flex-1 text-xs"
                />
                <Input
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  placeholder="base branch (main)"
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
                {activeThreadId && hasSession ? "Continue" : "Send"}
              </Button>
            </div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] text-muted-foreground">
                {activeThreadId && hasSession
                  ? "Resumes the same Claude Code session."
                  : "Cmd/Ctrl + Enter to send."}
              </div>
              {!activeThreadId ? (
                <button
                  type="button"
                  onClick={() => setShowRepo((v) => !v)}
                  className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                >
                  {showRepo ? "Hide repo" : "Attach a repo"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function EventRow({ event }: { event: BrainEvent }) {
  if (event.type === "user") {
    return (
      <div className="flex justify-end">
        <div className="flex max-w-[85%] items-start gap-2 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
          <span className="whitespace-pre-wrap break-words">{event.text}</span>
          <IconUser className="mt-0.5 h-3.5 w-3.5 shrink-0 opacity-70" />
        </div>
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
        <div
          className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg border px-3 py-2 text-sm ${
            isResult ? "border-emerald-500/30 bg-emerald-500/5" : "bg-muted/40"
          }`}
        >
          {event.text}
        </div>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="flex items-start gap-2">
        <IconAlertTriangle className="mt-1 h-4 w-4 shrink-0 text-red-500" />
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-sm text-red-700 dark:text-red-400">
          {event.text}
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
            tool result
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
}: {
  usage: BrainUsage | undefined;
  selectModelValue: string;
  onModelChange: (value: string) => void;
  switching: boolean;
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
            {MODEL_OPTIONS.map((o) => (
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

      {/* Context gauge */}
      <div className="flex min-w-[170px] flex-col gap-1">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-muted-foreground">Context</span>
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

      {/* 5-hour limit */}
      <UsageWindowBar
        icon={
          <IconClock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        }
        label="5-hour"
        window={usage?.fiveHour ?? null}
        resetText={
          usage?.fiveHour?.resetsAt
            ? `resets in ${relativeReset(usage.fiveHour.resetsAt)}`
            : ""
        }
      />

      {/* Weekly limit */}
      <UsageWindowBar
        icon={
          <IconCalendarTime className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        }
        label="Weekly"
        window={usage?.weekly ?? null}
        resetText={
          usage?.weekly?.resetsAt
            ? `resets ${shortDate(usage.weekly.resetsAt)}`
            : ""
        }
      />

      {/* Plan tier */}
      {prettyTier(usage?.planTier ?? null, usage?.plan ?? null) ? (
        <div className="flex items-center gap-1.5">
          <IconCrown className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <Badge
            variant="secondary"
            className="h-5 px-1.5 text-[11px] font-medium"
          >
            {prettyTier(usage?.planTier ?? null, usage?.plan ?? null)}
          </Badge>
        </div>
      ) : null}

      {/* As-of / stale / unavailable indicator */}
      <div className="ml-auto text-[10px] text-muted-foreground">
        {usage && !usage.available && usage.reason ? (
          <span className="text-amber-600 dark:text-amber-500">
            {usage.reason}
          </span>
        ) : usage?.fetchedAt ? (
          <span>
            as of{" "}
            {new Date(usage.fetchedAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            })}
            {usage.stale ? (
              <span className="ml-1 text-amber-600 dark:text-amber-500">
                · stale
              </span>
            ) : usage.cached ? (
              <span className="ml-1">· cached</span>
            ) : null}
          </span>
        ) : (
          <span>loading usage…</span>
        )}
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

function UsageWindowBar({
  icon,
  label,
  window: w,
  resetText,
}: {
  icon: ReactNode;
  label: string;
  window: UsageWindow | null;
  resetText: string;
}) {
  const pct = w?.utilizationPct ?? null;
  return (
    <div className="flex min-w-[150px] flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          {icon}
          {label}
        </span>
        <span className="font-medium tabular-nums">
          {pct != null ? `${Math.round(pct)}%` : "—"}
        </span>
      </div>
      <UsageBar pct={pct ?? 0} severity={w?.severity ?? "normal"} />
      {resetText ? (
        <span className="text-[10px] text-muted-foreground">{resetText}</span>
      ) : null}
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
