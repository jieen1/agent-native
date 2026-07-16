import { cn } from "@/lib/utils";

/**
 * Producer badge (agent vs. human) for a versioned artifact.
 *
 * Shared between the per-sprint "产物" section (SprintDetailPage) and the
 * per-work-item "产物" panel (ArtifactsPanel) so both surfaces speak the same
 * agent/human visual vocabulary — matches
 * docs/sdlc-product-design/prototypes/s4-work-item.html's `.badge.b-agent`
 * treatment — instead of each screen inventing its own tone.
 */
export function ArtifactBadge({ kind }: { kind: string }) {
  const isHuman = kind === "human";
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold",
        isHuman
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400"
          : "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      )}
    >
      {isHuman ? "人工" : "智能体"}
    </span>
  );
}
