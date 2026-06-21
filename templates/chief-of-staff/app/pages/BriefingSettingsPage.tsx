import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  IconDeviceFloppy,
  IconRefresh,
  IconSettings,
} from "@tabler/icons-react";
import { buildAppPrompt } from "@shared/app-prompts";
import {
  useBriefingSettings,
  useUpdateBriefingSettings,
} from "@/hooks/use-briefing-settings";
import { useSetPageTitle } from "@/components/layout/HeaderActions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

/** Title-case an app id for display ("mail" -> "Mail"). */
function appLabel(appId: string): string {
  return appId.charAt(0).toUpperCase() + appId.slice(1);
}

interface DraftState {
  enabled: Record<string, boolean>;
  overrides: Record<string, string>;
}

/**
 * Briefing settings: choose which apps feed a briefing and override each app's
 * natural-language question (docs/CHIEF_OF_STAFF_DESIGN.md §7). Reads + writes
 * go through the `get-briefing-settings` / `update-briefing-settings` actions
 * (named hooks, no hand-written fetch). The compile-briefing action reads the
 * same settings, so the chat-driven "Compile now" flow honors these choices.
 */
export function BriefingSettingsPage() {
  useSetPageTitle("Briefing settings");
  const { data, isLoading, error, refetch } = useBriefingSettings();
  const update = useUpdateBriefingSettings();

  const [draft, setDraft] = useState<DraftState | null>(null);

  // Seed the editable draft from the loaded settings once (and whenever a fresh
  // server value arrives after a save).
  useEffect(() => {
    if (!data) return;
    const enabled: Record<string, boolean> = {};
    for (const appId of data.availableApps) {
      enabled[appId] = data.enabledApps.includes(appId);
    }
    setDraft({ enabled, overrides: { ...data.promptOverrides } });
  }, [data]);

  const availableApps = data?.availableApps ?? [];

  const isDirty = useMemo(() => {
    if (!data || !draft) return false;
    const enabledChanged = data.availableApps.some(
      (appId) => draft.enabled[appId] !== data.enabledApps.includes(appId),
    );
    if (enabledChanged) return true;
    const draftKeys = Object.keys(draft.overrides).filter((k) =>
      draft.overrides[k]?.trim(),
    );
    const dataKeys = Object.keys(data.promptOverrides);
    if (draftKeys.length !== dataKeys.length) return true;
    return draftKeys.some(
      (k) => draft.overrides[k].trim() !== data.promptOverrides[k],
    );
  }, [data, draft]);

  function setEnabled(appId: string, value: boolean) {
    setDraft((prev) =>
      prev ? { ...prev, enabled: { ...prev.enabled, [appId]: value } } : prev,
    );
  }

  function setOverride(appId: string, value: string) {
    setDraft((prev) =>
      prev
        ? { ...prev, overrides: { ...prev.overrides, [appId]: value } }
        : prev,
    );
  }

  async function handleSave() {
    if (!draft) return;
    const enabledApps = availableApps.filter((appId) => draft.enabled[appId]);
    if (enabledApps.length === 0) {
      toast.error("Enable at least one app for the briefing.");
      return;
    }
    // Send every available app's override so cleared ones (empty string) are
    // explicitly removed server-side via the merge semantics.
    const promptOverrides: Record<string, string> = {};
    for (const appId of availableApps) {
      promptOverrides[appId] = draft.overrides[appId]?.trim() ?? "";
    }
    try {
      await update.mutateAsync({ enabledApps, promptOverrides });
      toast.success("Briefing settings saved.");
    } catch {
      // useUpdateBriefingSettings already surfaces a toast on error.
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <IconSettings className="size-3.5" />
            Settings
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Briefing sources
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Choose which apps feed your briefing and customize the question the
            Chief of Staff asks each one.
          </p>
        </div>
        <Button
          size="sm"
          className="h-8 gap-1.5"
          onClick={handleSave}
          disabled={!isDirty || update.isPending || !draft}
        >
          <IconDeviceFloppy className="size-3.5" />
          Save changes
        </Button>
      </div>

      {isLoading || !draft ? (
        <div className="space-y-4">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            {error instanceof Error
              ? error.message.replace(/^Action [\w-]+ failed:\s*/, "")
              : "Couldn't load briefing settings."}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => refetch()}
          >
            <IconRefresh className="size-3.5" />
            Retry
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          {availableApps.map((appId) => {
            const enabled = draft.enabled[appId] ?? false;
            const overrideValue = draft.overrides[appId] ?? "";
            const defaultPrompt = buildAppPrompt(appId, "adhoc");
            return (
              <Card key={appId}>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                  <div>
                    <CardTitle className="text-base">
                      {appLabel(appId)}
                    </CardTitle>
                    <CardDescription>
                      {enabled
                        ? "Included in your briefing."
                        : "Excluded from your briefing."}
                    </CardDescription>
                  </div>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(v) => setEnabled(appId, v)}
                    aria-label={`Include ${appLabel(appId)} in the briefing`}
                  />
                </CardHeader>
                <CardContent className="space-y-2">
                  <Label
                    htmlFor={`override-${appId}`}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    Custom question (optional)
                  </Label>
                  <Textarea
                    id={`override-${appId}`}
                    value={overrideValue}
                    onChange={(e) => setOverride(appId, e.target.value)}
                    disabled={!enabled}
                    rows={3}
                    placeholder={defaultPrompt}
                    className="resize-y text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    Leave blank to use the default question.
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
