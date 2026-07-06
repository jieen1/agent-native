import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export interface MarkdownPreviewProps {
  markdown: string;
  className?: string;
}

/** Live-rendered read view for the Skills / Runbook split editor's right
 * pane. Reuses `react-markdown` + `remark-gfm` — already a dependency of
 * `@agent-native/core` and the `plan`/`slides` templates — instead of adding
 * a new markdown-rendering library. Styled with Tailwind Typography's
 * `prose` classes (already a devDependency of this template). */
export function MarkdownPreview({ markdown, className }: MarkdownPreviewProps) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none",
        "prose-headings:font-semibold prose-pre:bg-muted prose-pre:text-foreground",
        "prose-code:before:content-none prose-code:after:content-none",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}
