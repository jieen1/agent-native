import { IconInfoCircle } from "@tabler/icons-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

// Shared bits for /health and /insights (S10 · docs/sdlc-product-design/04-orchestrator.md §10/§11).
// Both pages mix real action-backed data with sections that have no backing
// action yet — DataSourceNote is the one place that "not real data" gets
// spelled out, so every placeholder reads the same way instead of each
// section inventing its own disclaimer wording.

export function HealthDot({
  tone,
  title,
}: {
  tone: "ok" | "warn" | "off" | "pending";
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        tone === "ok" && "bg-emerald-500",
        tone === "warn" && "bg-amber-500",
        tone === "off" && "bg-muted-foreground/40",
        tone === "pending" && "bg-muted-foreground/40",
      )}
    />
  );
}

/** Inline note marking a value/section as not backed by a real action yet. */
export function DataSourceNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
      <IconInfoCircle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s 前`;
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m 前`;
  const hr = Math.round(min / 60);
  return `${hr}h 前`;
}
