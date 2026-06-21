import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActionQuery, useActionMutation } from "@agent-native/core/client";
import type { BriefingSource, BriefingSummary } from "@shared/types";

/**
 * Briefing data hooks for the Chief-of-Staff today panel and detail page.
 *
 * Reads go through `useActionQuery` (GET, readOnly) — the framework's
 * `useDbSync` poll invalidates `["action", …]` after any mutating action runs,
 * so the panel auto-refetches within one poll interval without a manual reload.
 * Writes go through `useActionMutation`, whose built-in `invalidateQueries`
 * refetches immediately on the writing tab.
 */

/** Shape returned by the `get-briefing` action (full row + parsed sources). */
export interface BriefingDetail extends BriefingSummary {
  sources: BriefingSource[];
  visibility: string;
  role: string;
}

/**
 * List briefings, most recent first. Pass a `date` (YYYY-MM-DD) to scope to a
 * single day — the today panel passes today's local date.
 */
export function useBriefings(date?: string) {
  return useActionQuery<BriefingSummary[]>(
    "list-briefings",
    date ? { date } : {},
  );
}

/** Load one briefing's full detail, including per-source sections. */
export function useBriefing(id: string) {
  return useActionQuery<BriefingDetail>(
    "get-briefing",
    { id },
    { enabled: !!id },
  );
}

/**
 * Update a briefing's polished summary and/or title. Mutating (POST), so the
 * framework emits an `action` change event that refreshes the panel on every
 * connected tab; we also invalidate the read queries locally for instant
 * feedback on the writing tab.
 */
export function useUpdateBriefing() {
  const qc = useQueryClient();
  return useActionMutation("update-briefing", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["action", "list-briefings"] });
      qc.invalidateQueries({ queryKey: ["action", "get-briefing"] });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error && err.message
          ? err.message.replace(/^Action update-briefing failed:\s*/, "")
          : "Failed to update briefing";
      toast.error(message);
    },
  });
}
