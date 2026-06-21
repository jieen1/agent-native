import { useState } from "react";
import {
  IconChevronRight,
  IconExternalLink,
  IconApps,
} from "@tabler/icons-react";
import type { BriefingSource } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { sourceStatusDisplay } from "@/lib/briefing-format";

interface BriefingSourceSectionProps {
  source: BriefingSource;
  /** Expanded on first render — the today panel opens the first source. */
  defaultOpen?: boolean;
}

/**
 * One collapsible section per fan-out source app: app name + status badge,
 * the agent's raw reply text, and deep-link buttons. In Phase B1 the source
 * data is populated by manually-inserted briefings; the compile fan-out that
 * fills these arrives in B2. The section renders whatever is present and stays
 * a faithful skeleton when fields are empty.
 */
export function BriefingSourceSection({
  source,
  defaultOpen = false,
}: BriefingSourceSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const status = sourceStatusDisplay(source.status);
  const hasResponse = source.responseText.trim().length > 0;
  const deepLinks = source.deepLinks ?? [];

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border border-border bg-card"
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={open}
        >
          <IconChevronRight
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <IconApps className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium capitalize">
            {source.app}
          </span>
          {deepLinks.length > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">
              {deepLinks.length} {deepLinks.length === 1 ? "link" : "links"}
            </span>
          ) : null}
          <Badge
            variant={status.variant}
            className={cn("shrink-0 text-[10px]", status.className)}
          >
            {status.label}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-t border-border px-4 py-3">
          {source.error ? (
            <p className="mb-3 text-sm text-destructive">{source.error}</p>
          ) : null}

          {hasResponse ? (
            <pre className="mb-3 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
              {source.responseText}
            </pre>
          ) : (
            <p className="mb-3 text-sm text-muted-foreground">
              No content from this source yet.
            </p>
          )}

          {deepLinks.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {deepLinks.map((link, index) => (
                <Button
                  key={`${link}-${index}`}
                  asChild
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                >
                  <a href={link} target="_blank" rel="noopener noreferrer">
                    <IconExternalLink className="size-3.5" />
                    Open in {source.app}
                  </a>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
