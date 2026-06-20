import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconTerminal2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// xterm.js terminal panel (FRONTEND §4(b)/(c) "Terminal"). It renders a node's
// CAPTURED log lines (from node-get `logs` / run-events for now). The live in-VM
// `execStream` wiring is P2c — until then `logs` is empty and we show a clear
// "no terminal output yet" empty state. We never fake a live stream.
//
// xterm is browser-only and imported DYNAMICALLY inside an effect so it never
// runs during SSR (the run console is a CSR logged-in page, but the import must
// still be guarded). The CSS is imported the same way.

export interface XtermPanelProps {
  /** Stable id so the terminal resets when the focused node changes. */
  nodeRunId: string | null;
  /** Captured log lines for the focused node (node-get `logs`). */
  logs: string[];
  className?: string;
}

interface XtermHandles {
  // Minimal structural types so we don't depend on @xterm types at module load.
  term: { write: (s: string) => void; clear: () => void; dispose: () => void };
  fit: () => void;
}

export function XtermPanel({ nodeRunId, logs, className }: XtermPanelProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<XtermHandles | null>(null);
  const writtenRef = useRef(0);
  const [ready, setReady] = useState(false);

  const hasLogs = logs.length > 0;

  // Boot the terminal once, lazily, on the client.
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    async function boot() {
      if (!containerRef.current) return;
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      // CSS side-effect import (browser only).
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        convertEol: true,
        fontSize: 12,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        cursorBlink: false,
        disableStdin: true,
        theme: { background: "rgba(0,0,0,0)" },
        scrollback: 5000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      try {
        fit.fit();
      } catch {
        // container not measured yet — ignore.
      }
      handlesRef.current = {
        term,
        fit: () => {
          try {
            fit.fit();
          } catch {
            // ignore resize errors
          }
        },
      };
      writtenRef.current = 0;
      setReady(true);

      const onResize = () => handlesRef.current?.fit();
      window.addEventListener("resize", onResize);
      cleanup = () => {
        window.removeEventListener("resize", onResize);
        term.dispose();
      };
    }

    void boot();
    return () => {
      disposed = true;
      cleanup?.();
      handlesRef.current = null;
      setReady(false);
    };
  }, []);

  // Reset the buffer when the focused node changes.
  useEffect(() => {
    const h = handlesRef.current;
    if (!h) return;
    h.term.clear();
    writtenRef.current = 0;
  }, [nodeRunId]);

  // Append only NEW log lines (append-only; never re-write the whole buffer).
  useEffect(() => {
    const h = handlesRef.current;
    if (!h || !ready) return;
    if (logs.length < writtenRef.current) {
      // logs shrank (node switched mid-flight) — reset.
      h.term.clear();
      writtenRef.current = 0;
    }
    for (let i = writtenRef.current; i < logs.length; i += 1) {
      h.term.write(`${logs[i]}\r\n`);
    }
    writtenRef.current = logs.length;
    h.fit();
  }, [logs, ready, nodeRunId]);

  return (
    <div className={cn("relative h-full min-h-[180px] w-full", className)}>
      <div
        ref={containerRef}
        aria-label={t("runs.terminal")}
        className="h-full w-full overflow-hidden rounded-md border border-border bg-[#0b0e14] p-2"
      />
      {!hasLogs ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <IconTerminal2 className="size-6 text-muted-foreground/60" />
          <p className="text-xs text-muted-foreground">
            {nodeRunId ? t("runs.terminalEmpty") : t("runs.terminalSelect")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
