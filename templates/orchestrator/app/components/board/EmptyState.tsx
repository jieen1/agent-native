import type { ReactNode } from "react";
import type { Icon } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

// Shared empty-state (FRONTEND §C3 / §12 — every list has a purposeful empty
// CTA). Build once, compose everywhere.
export interface EmptyStateProps {
  icon?: Icon;
  title: string;
  description?: string;
  /** Optional CTA (a <Button> or trigger). */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon: IconCmp,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-10 text-center",
        className,
      )}
    >
      {IconCmp ? (
        <IconCmp
          className="size-8 text-muted-foreground/60"
          aria-hidden="true"
          stroke={1.5}
        />
      ) : null}
      <div className="grid gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
