import { useTranslation } from "react-i18next";
import { IconGitCommit } from "@tabler/icons-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// View-diff sheet (FRONTEND §4(b) "View diff" → a shadcn Sheet). Shows a node's
// committed diff when node-get carries one. Code delivery is P2c, so today the
// diff is null and we render a clear placeholder — never a fabricated diff.

export interface DiffSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeTitle: string | null;
  diff: string | null;
}

/** Color each diff line by its leading +/-/@ marker (read-only unified diff). */
function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return "text-emerald-600 dark:text-emerald-400";
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return "text-red-600 dark:text-red-400";
  }
  if (line.startsWith("@@")) return "text-blue-600 dark:text-blue-400";
  return "text-muted-foreground";
}

export function DiffSheet({
  open,
  onOpenChange,
  nodeTitle,
  diff,
}: DiffSheetProps) {
  const { t } = useTranslation();
  const lines = diff ? diff.split("\n") : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-3 sm:max-w-2xl"
      >
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <IconGitCommit className="size-4" />
            {t("runs.diffTitle")}
          </SheetTitle>
          <SheetDescription>
            {nodeTitle ?? t("runs.diffSubtitle")}
          </SheetDescription>
        </SheetHeader>
        {diff ? (
          <ScrollArea className="min-h-0 flex-1 rounded-md border border-border bg-muted/30">
            <pre className="p-3 font-mono text-xs leading-relaxed">
              {lines.map((line, i) => (
                <div key={i} className={cn(diffLineClass(line))}>
                  {line || " "}
                </div>
              ))}
            </pre>
          </ScrollArea>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border p-8 text-center">
            <IconGitCommit className="size-6 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              {t("runs.diffEmpty")}
            </p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
