import { useEffect, useRef, useState, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { V3Event } from "@/hooks/use-v3-run";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    } as Intl.DateTimeFormatOptions);
  } catch {
    return iso;
  }
}

const KIND_COLORS: Record<string, string> = {
  "run.created": "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  "run.started": "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  "node.ready": "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  "spawn.started": "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  "spawn.completed": "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "node.resolved": "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  "run.completed": "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  "run.failed": "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  patch_applied: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
};

// ── SSE Event Feed ───────────────────────────────────────────────────────────

interface SseEvent {
  id: string;
  kind: string;
  seqNum: number | null;
  ts: string;
  payload: Record<string, unknown>;
  raw: string;
}

function parseSseLine(line: string): Partial<SseEvent> | null {
  if (!line || line.startsWith(":")) return null;
  const [key, ...rest] = line.split(":");
  const value = rest.join(":").trimStart();
  const result: Partial<SseEvent> = {};

  switch (key.trim()) {
    case "id":
      result.id = value;
      break;
    case "seq_num":
      result.seqNum = parseInt(value, 10) ?? null;
      break;
    case "ts":
      result.ts = value;
      break;
    case "event":
      result.kind = value;
      break;
    case "data":
      result.raw = value;
      try {
        result.payload = JSON.parse(value);
      } catch {
        result.payload = { raw: value };
      }
      break;
  }
  return result;
}

export interface EventFeedProps {
  runId: string;
  initialEvents?: V3Event[];
}

export function EventFeed({ runId, initialEvents = [] }: EventFeedProps) {
  const [events, setEvents] = useState<SseEvent[]>(() =>
    initialEvents.map((e) => ({
      id: e.id,
      kind: e.kind,
      seqNum: e.seqNum,
      ts: e.ts ?? "",
      payload: typeof e.payload === "object" && e.payload !== null
        ? (e.payload as Record<string, unknown>)
        : { raw: String(e.payload ?? "") },
      raw: String(e.payload ?? ""),
    })),
  );
  const [connected, setConnected] = useState(false);
  const [lastSeq, setLastSeq] = useState<number | null>(() => {
    const max = Math.max(...initialEvents.map((e) => e.seqNum ?? 0), 0);
    return max || null;
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const bufferRef = useRef<Partial<SseEvent>>({});

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const url = new URL(`/_v3/runs/${runId}/events`, window.location.origin);
    if (lastSeq !== null) {
      url.searchParams.set("since", String(lastSeq));
    }

    const es = new EventSource(url.toString());
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnected(true);
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects, no manual action needed
    };

    // Handle SSE messages — accumulate multi-line data
    es.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data === "") return;

      // SSE messages may contain multiple lines
      const lines = data.split("\n");
      for (const line of lines) {
        const parsed = parseSseLine(line);
        if (!parsed) continue;

        // Merge into buffer
        Object.assign(bufferRef.current, parsed);

        // When we have data, emit the event
        if (parsed.raw) {
          const evt: SseEvent = {
            id: bufferRef.current.id ?? "",
            kind: bufferRef.current.kind ?? "",
            seqNum: bufferRef.current.seqNum ?? null,
            ts: bufferRef.current.ts ?? new Date().toISOString(),
            payload: bufferRef.current.payload ?? {},
            raw: bufferRef.current.raw ?? "",
          };

          setEvents((prev) => [...prev, evt]);
          if (evt.seqNum !== null && evt.seqNum > (lastSeq ?? 0)) {
            setLastSeq(evt.seqNum);
          }
          bufferRef.current = {};
        }
      }
    };
  }, [runId, lastSeq]);

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
    };
  }, [connect]);

  useEffect(() => {
    // Auto-scroll to bottom
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [events]);

  return (
    <div className="flex h-full flex-col">
      {/* Connection status bar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            connected ? "bg-emerald-500" : "bg-red-500",
          )}
        />
        {connected ? "Connected" : "Disconnected"}
        <span className="text-muted-foreground ml-auto">
          {events.length} events
        </span>
      </div>

      {/* Event list */}
      <ScrollArea ref={scrollRef} className="flex-1 p-3">
        {events.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Waiting for events...
          </div>
        ) : (
          <div className="space-y-1">
            {events.map((evt, idx) => (
              <div
                key={`${evt.id}-${idx}`}
                className="flex items-start gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/50"
              >
                {/* Timestamp */}
                <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                  {formatTime(evt.ts)}
                </span>

                {/* Sequence number */}
                {evt.seqNum !== null ? (
                  <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                    #{evt.seqNum}
                  </span>
                ) : null}

                {/* Kind badge */}
                <Badge
                  variant="secondary"
                  className={cn(
                    "shrink-0 font-mono text-[10px]",
                    KIND_COLORS[evt.kind] ??
                      "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
                  )}
                >
                  {evt.kind}
                </Badge>

                {/* Payload preview */}
                <span className="max-w-[200px] truncate font-mono text-muted-foreground sm:max-w-[400px]">
                  {evt.raw.length < 200
                    ? evt.raw
                    : `${evt.raw.slice(0, 200)}…`}
                </span>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
