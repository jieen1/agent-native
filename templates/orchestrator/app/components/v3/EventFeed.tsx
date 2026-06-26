import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import {
  IconPlayerPlay,
  IconSend,
  IconCircleCheck,
  IconCircleX,
  IconGitBranch,
  IconActivity,
} from "@tabler/icons-react";
import { appPath } from "@agent-native/core/client/api-path";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { V3Event } from "@/hooks/use-v3-run";
import { fmtTime } from "./v3-format";

// ── Event kind presentation ──────────────────────────────────────────────────

interface KindStyle {
  icon: typeof IconActivity;
  dot: string;
  label: string;
}

function kindStyle(kind: string): KindStyle {
  switch (kind) {
    case "run.started":
      return { icon: IconPlayerPlay, dot: "bg-blue-500", label: "运行开始" };
    case "node.dispatched":
    case "node.ready":
      return { icon: IconSend, dot: "bg-sky-500", label: "节点已派发" };
    case "spawn.started":
      return { icon: IconActivity, dot: "bg-amber-500", label: "任务开始" };
    case "spawn.done":
    case "spawn.completed":
    case "node.resolved":
      return {
        icon: IconCircleCheck,
        dot: "bg-emerald-500",
        label: "任务完成",
      };
    case "run.completed":
      return {
        icon: IconCircleCheck,
        dot: "bg-emerald-500",
        label: "运行完成",
      };
    case "run.failed":
      return { icon: IconCircleX, dot: "bg-red-500", label: "运行失败" };
    case "patch_applied":
      return { icon: IconGitBranch, dot: "bg-purple-500", label: "已应用补丁" };
    default:
      return { icon: IconActivity, dot: "bg-zinc-500", label: kind };
  }
}

// ── SSE parsing (live tail) ──────────────────────────────────────────────────

interface FeedEvent {
  id: string;
  kind: string;
  seqNum: number | null;
  ts: string;
  payload: Record<string, unknown>;
}

function parseSseLine(line: string): Partial<FeedEvent> & { raw?: string } | null {
  if (!line || line.startsWith(":")) return null;
  const [key, ...rest] = line.split(":");
  const value = rest.join(":").trimStart();
  switch (key.trim()) {
    case "id":
      return { id: value };
    case "seq_num":
      return { seqNum: parseInt(value, 10) };
    case "ts":
      return { ts: value };
    case "event":
      return { kind: value };
    case "data": {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(value);
      } catch {
        payload = { raw: value };
      }
      return { payload, raw: value };
    }
    default:
      return null;
  }
}

function payloadSummary(p: Record<string, unknown>): string {
  if (!p || typeof p !== "object") return "";
  const parts: string[] = [];
  if (typeof p.nodeId === "string") parts.push(p.nodeId);
  if (typeof p.spawnId === "string") parts.push(p.spawnId.slice(0, 8));
  if (parts.length) return parts.join(" · ");
  const keys = Object.keys(p);
  if (keys.length === 0) return "";
  if (keys.length === 1 && typeof p.raw === "string") return p.raw.slice(0, 80);
  return keys.slice(0, 3).join(", ");
}

export interface EventFeedProps {
  runId: string;
  initialEvents?: V3Event[];
  /**
   * Whether the run is still live. Terminal runs already carry their full event
   * history, so we skip the SSE tail entirely (no socket, no reconnect noise).
   */
  live?: boolean;
}

export function EventFeed({
  runId,
  initialEvents = [],
  live = false,
}: EventFeedProps) {
  const [events, setEvents] = useState<FeedEvent[]>(() =>
    initialEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      seqNum: e.seqNum,
      ts: e.ts ?? "",
      payload:
        typeof e.payload === "object" && e.payload !== null
          ? (e.payload as Record<string, unknown>)
          : { raw: String(e.payload ?? "") },
    })),
  );
  const [connected, setConnected] = useState(false);
  const [lastSeq, setLastSeq] = useState<number | null>(() => {
    const max = Math.max(...initialEvents.map((e) => e.seqNum ?? 0), 0);
    return max || null;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);
  const bufRef = useRef<Partial<FeedEvent>>({});

  const connect = useCallback(() => {
    esRef.current?.close();
    // Respect the app base path (e.g. `/orchestrator`) — the SSE route is
    // mounted under it, so a bare `/_v3/...` would 404.
    const url = new URL(
      appPath(`/_v3/runs/${runId}/events`),
      window.location.origin,
    );
    if (lastSeq !== null) url.searchParams.set("since", String(lastSeq));
    const es = new EventSource(url.toString());
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data) return;
      for (const line of data.split("\n")) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;
        Object.assign(bufRef.current, parsed);
        if ("raw" in parsed) {
          const evt: FeedEvent = {
            id: bufRef.current.id ?? crypto.randomUUID(),
            kind: bufRef.current.kind ?? "",
            seqNum: bufRef.current.seqNum ?? null,
            ts: bufRef.current.ts ?? new Date().toISOString(),
            payload: bufRef.current.payload ?? {},
          };
          setEvents((prev) => [...prev, evt]);
          if (evt.seqNum !== null && evt.seqNum > (lastSeq ?? 0)) {
            setLastSeq(evt.seqNum);
          }
          bufRef.current = {};
        }
      }
    };
  }, [runId, lastSeq]);

  useEffect(() => {
    // Only tail live runs; terminal runs already have their complete history.
    if (!live) return;
    connect();
    return () => esRef.current?.close();
  }, [connect, live]);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events]);

  const sorted = useMemo(
    () =>
      [...events].sort((a, b) => (a.seqNum ?? 0) - (b.seqNum ?? 0)),
    [events],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            live && connected
              ? "bg-emerald-500 animate-pulse"
              : live
                ? "bg-amber-500"
                : "bg-zinc-400",
          )}
        />
        <span className="text-muted-foreground">
          {live ? (connected ? "实时" : "连接中…") : "已完成"}
        </span>
        <span className="ml-auto text-muted-foreground">
          {sorted.length} 个事件
        </span>
      </div>

      {/* Timeline */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {sorted.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            本次运行没有记录任何事件。
          </div>
        ) : (
          <ol className="relative">
            {sorted.map((evt, idx) => {
              const style = kindStyle(evt.kind);
              const Icon = style.icon;
              const detail = payloadSummary(evt.payload);
              const isLast = idx === sorted.length - 1;
              return (
                <li key={`${evt.id}-${idx}`} className="relative flex gap-3 pb-4">
                  {/* Rail + dot */}
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        "z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-4 ring-background",
                        style.dot,
                      )}
                    >
                      <Icon className="size-3.5 text-white" />
                    </span>
                    {!isLast ? (
                      <span className="w-px flex-1 bg-border" />
                    ) : null}
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {style.label}
                      </span>
                      {evt.seqNum !== null ? (
                        <Badge
                          variant="secondary"
                          className="h-4 px-1 font-mono text-[10px]"
                        >
                          #{evt.seqNum}
                        </Badge>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {fmtTime(evt.ts)}
                      </span>
                    </div>
                    {detail ? (
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {detail}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
