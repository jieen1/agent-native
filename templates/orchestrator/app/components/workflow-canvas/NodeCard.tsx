import { useTranslation } from "react-i18next";
import { IconLock } from "@tabler/icons-react";
import type { Node } from "../../../shared/types";
import { NODE_TYPE_META } from "@/lib/node-meta";
import { nodeStatusDot } from "@/lib/status-colors";
import { cn } from "@/lib/utils";

// The ONE node card (FRONTEND §C3 — "<NodeCard> used by BOTH editor and run
// overlay"). Every React-Flow node type renders THIS: a type icon, the title, and
// an engine/model badge. In `run` mode the same card is tinted by NodeRun status
// via the C2 color map (the `runStatus` prop) — one renderer, two modes.

export interface NodeCardProps {
  node: Node;
  selected?: boolean;
  /** run-mode tint: a NodeRun status key (pending/running/done/failed/…). */
  runStatus?: string;
  /** run-mode counters surfaced on the card. */
  iteration?: number;
  dynamic?: boolean;
  /** container header variant (smaller, sits atop a group frame). */
  asHeader?: boolean;
  className?: string;
}

export function NodeCard({
  node,
  selected,
  runStatus,
  iteration,
  dynamic,
  asHeader,
  className,
}: NodeCardProps) {
  const { t } = useTranslation();
  const meta = NODE_TYPE_META[node.type];
  const Icon = meta?.icon;
  const typeLabel = t(`flow.nodeType.${meta?.labelKey ?? node.type}`, {
    defaultValue: node.type,
  });
  const engineModel = [node.engine, node.model].filter(Boolean).join(" · ");
  const locked = Boolean(node.nodeDefKey);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card text-card-foreground shadow-sm transition-colors",
        asHeader ? "px-2.5 py-1.5" : "min-w-[180px] max-w-[240px] px-3 py-2",
        selected
          ? "border-primary ring-1 ring-primary"
          : "border-border hover:border-foreground/20",
        className,
      )}
    >
      <div className="flex items-center gap-2">
        {runStatus ? (
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              nodeStatusDot(runStatus),
              runStatus === "running" && "animate-pulse",
            )}
            aria-hidden
          />
        ) : Icon ? (
          <Icon className="size-4 shrink-0 text-muted-foreground" />
        ) : null}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {node.title || node.id}
        </span>
        {locked ? (
          <IconLock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={t("flow.libraryLocked")}
          />
        ) : null}
      </div>

      {!asHeader ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {typeLabel}
          </span>
          {engineModel ? (
            <span className="truncate rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-secondary-foreground">
              {engineModel}
            </span>
          ) : null}
          {node.runtime ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {node.runtime.kind}
            </span>
          ) : null}
          {typeof iteration === "number" && iteration > 0 ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t("runs.iteration")} {iteration}
            </span>
          ) : null}
          {dynamic ? (
            <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
              {t("runs.dynamic")}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
