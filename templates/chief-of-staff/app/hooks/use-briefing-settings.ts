import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useActionQuery, useActionMutation } from "@agent-native/core/client";

/**
 * Briefing settings hooks for the settings page.
 *
 * Reads go through `useActionQuery` (GET, readOnly); writes go through
 * `useActionMutation` and invalidate the read query so the page reflects the
 * persisted value immediately. Matches the data-flow contract used by
 * `use-briefings.ts` — named hooks, never hand-written fetch.
 */

/** Shape returned by the `get-briefing-settings` action. */
export interface BriefingSettingsData {
  enabledApps: string[];
  promptOverrides: Record<string, string>;
  availableApps: string[];
}

/** Read the current user's briefing settings (default four-source set + overrides). */
export function useBriefingSettings() {
  return useActionQuery<BriefingSettingsData>("get-briefing-settings", {});
}

/**
 * Patch briefing settings. Only the fields passed change; promptOverrides is
 * merged server-side (empty string clears an app's override). Invalidates the
 * read query on success for instant feedback.
 */
export function useUpdateBriefingSettings() {
  const qc = useQueryClient();
  return useActionMutation("update-briefing-settings", {
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: ["action", "get-briefing-settings"],
      });
    },
    onError: (err: unknown) => {
      const message =
        err instanceof Error && err.message
          ? err.message.replace(
              /^Action update-briefing-settings failed:\s*/,
              "",
            )
          : "Failed to update settings";
      toast.error(message);
    },
  });
}
