import { useCallback, useMemo, useRef, type UIEvent } from "react";
import { cn } from "@/lib/utils";

/**
 * Split source/preview markdown editor's SOURCE pane — a code-editor-style
 * gutter next to a plain-text editor.
 *
 * The gutter is a flex ROW made of two flex COLUMNS:
 *   - a left column of right-aligned line numbers, `display:flex;
 *     flex-direction:column`, one `<div>` per line, each a FIXED row height
 *     (`ROW_HEIGHT_PX`, `white-space: pre`) — a true vertical stack, never a
 *     wrapped/reflowing row of numbers;
 *   - a right column: a single `<textarea>` sharing the exact same
 *     `font-family` / `font-size` / `line-height` / top padding as the gutter
 *     rows, with `wrap="off"` + `white-space: pre` so a long line scrolls
 *     horizontally instead of wrapping (which would desync line N of the
 *     gutter from line N of the code).
 * Vertical scroll is kept height-synced by mirroring the textarea's
 * `scrollTop` onto the (otherwise non-interactive, `overflow:hidden`) gutter
 * column on every scroll event.
 */
const ROW_HEIGHT_PX = 21;

export interface MarkdownSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
}

export function MarkdownSourceEditor({
  value,
  onChange,
  disabled,
  className,
}: MarkdownSourceEditorProps) {
  const gutterRef = useRef<HTMLDivElement>(null);

  const lineCount = useMemo(
    () => Math.max(value.split("\n").length, 1),
    [value],
  );
  const gutterWidthCh = Math.max(String(lineCount).length + 2, 3);

  const handleScroll = useCallback((event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  }, []);

  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 overflow-hidden bg-background",
        className,
      )}
    >
      {/* Gutter column — one <div> row per source line, stacked vertically. */}
      <div
        ref={gutterRef}
        aria-hidden="true"
        data-testid="md-gutter"
        className="flex shrink-0 select-none flex-col overflow-hidden border-r bg-muted py-3.5"
        style={{ width: `${gutterWidthCh}ch` }}
      >
        {Array.from({ length: lineCount }, (_, index) => (
          <div
            key={index}
            data-testid="md-gutter-row"
            className="shrink-0 whitespace-pre px-3 text-right font-mono text-[12.5px] text-muted-foreground/60"
            style={{ height: ROW_HEIGHT_PX, lineHeight: `${ROW_HEIGHT_PX}px` }}
          >
            {index + 1}
          </div>
        ))}
      </div>

      {/* Code column — a single non-wrapping textarea, scrolled together
          with the gutter via the onScroll mirror above. */}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onScroll={handleScroll}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        wrap="off"
        aria-label="Markdown source"
        className="flex-1 resize-none overflow-auto bg-background px-4 py-3.5 font-mono text-[12.5px] outline-none disabled:cursor-not-allowed disabled:opacity-60"
        style={{ whiteSpace: "pre", lineHeight: `${ROW_HEIGHT_PX}px` }}
      />
    </div>
  );
}
