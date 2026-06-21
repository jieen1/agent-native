import { useCallback } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  navigateWithAgentChatViewTransition,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client";

/** A routine is either cron-scheduled or fires on a bus event. */
export type RoutineKind = "schedule" | "event";

/**
 * Client view-model for a routine. Mirrors the server `RoutineSummary`
 * (actions/_routines-lib.ts) — the frontend can't import the server module, so
 * the shape is declared here and kept in sync with the action's return type.
 *
 * Phase A2 adds the `event` kind: schedule routines carry cron-derived fields
 * (`schedule`, `describeCron`, `nextRun`); event routines carry `event` and an
 * optional NL `condition` and leave the cron fields empty. `mode` is always
 * `"agentic"` in A2 (deterministic is A4 and not surfaced in the UI).
 */
export interface RoutineSummary {
  name: string;
  kind: RoutineKind;
  schedule: string;
  enabled: boolean;
  describeCron: string;
  /** Event name the routine subscribes to. Only set for event routines. */
  event?: string;
  /**
   * Emitting app id for a cross-app event routine (e.g. "plan", "mail"). Only
   * set for event routines whose event comes from a sibling app; undefined for
   * same-process events.
   */
  sourceApp?: string;
  /** Natural-language condition gating dispatch. Only set for event routines. */
  condition?: string;
  /** Execution mode. Always "agentic" in A2 (deterministic is A4). */
  mode?: "agentic" | "deterministic";
  domain?: string;
  lastStatus?: "success" | "error" | "running" | "skipped";
  lastRun?: string;
  lastError?: string;
  nextRun?: string;
  updatedAt?: string;
}

export interface ListRoutinesResult {
  routines: RoutineSummary[];
}

export interface GetRoutineResult {
  routine?: RoutineSummary;
  instructions?: string;
  notFound?: boolean;
  name?: string;
}

/** One subscribable bus event surfaced by `list-trigger-events`. */
export interface TriggerEventOption {
  name: string;
  description: string;
  example?: Record<string, unknown>;
  payloadKeys?: string[];
  /**
   * Emitting app id for a cross-app event (e.g. "plan", "mail"); undefined for
   * a same-process event. Selecting a cross-app event writes this into the
   * routine's `sourceApp` so the bridge poller delivers it.
   */
  sourceApp?: string;
}

export interface ListTriggerEventsResult {
  events: TriggerEventOption[];
}

/** A single row of a routine's run history (mirrors `list-routine-runs`). */
export interface RoutineRunView {
  id: string;
  routineName: string;
  kind: RoutineKind;
  trigger: string | null;
  status: "running" | "success" | "error" | "skipped";
  threadId: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

export interface ListRoutineRunsResult {
  runs: RoutineRunView[];
}

/** Result of a manual `run-routine` (shape differs by routine kind). */
export type RunRoutineResult =
  | { notFound: true; name: string }
  | {
      kind: "schedule";
      name: string;
      threadId: string;
      status: "success" | "error";
      error?: string;
    }
  | {
      kind: "event";
      name: string;
      event?: string;
      conditionMatched: boolean;
      dispatched: boolean;
      reason?: string;
    };

/** Trigger class of a routine template, used for grouping in the Templates UI. */
export type RoutinePresetCategory =
  | "schedule"
  | "event-cross-app"
  | "deterministic";

/**
 * One built-in routine template (mirrors the server `RoutinePresetSummary`).
 * Listed by `list-routine-templates`; forked into the user's routines by
 * `fork-routine`.
 */
export interface RoutineTemplate {
  id: string;
  displayName: string;
  description: string;
  category: RoutinePresetCategory;
  triggerType: RoutineKind;
  mode: "agentic" | "deterministic";
  schedule: string;
  event?: string;
  sourceApp?: string;
  domain?: string;
}

export interface ListRoutineTemplatesResult {
  templates: RoutineTemplate[];
}

/** Result of a successful `fork-routine`. */
export interface ForkRoutineResult {
  forked: true;
  presetId: string;
  routine: RoutineSummary;
}

export const LIST_ROUTINES_KEY = ["action", "list-routines"] as const;
export const LIST_ROUTINE_RUNS_KEY = ["action", "list-routine-runs"] as const;
export const LIST_ROUTINE_TEMPLATES_KEY = [
  "action",
  "list-routine-templates",
] as const;

/** List the current user's routines (both schedule and event kinds). */
export function useRoutines() {
  return useActionQuery<ListRoutinesResult>("list-routines", {});
}

/**
 * List the bus events an event routine can subscribe to. Static for the life of
 * the process, so cached long and never auto-refetched.
 */
export function useTriggerEvents() {
  return useActionQuery<ListTriggerEventsResult>(
    "list-trigger-events",
    {},
    { staleTime: 5 * 60_000 },
  );
}

/**
 * Run history for one routine (or all when `name` is omitted). Polls so a row
 * that starts as `running` flips to its terminal status without a manual
 * reload (§1.5.18 "auto refresh"); the interval is a named constant the UI and
 * tests can reference.
 */
export const RUNS_POLL_INTERVAL_MS = 5_000;

export function useRoutineRuns(name?: string) {
  return useActionQuery<ListRoutineRunsResult>(
    "list-routine-runs",
    name ? { name } : {},
    { refetchInterval: RUNS_POLL_INTERVAL_MS },
  );
}

/**
 * Manually run a routine once ("try it" / run-now). Invalidates the run history
 * so the new row (or the dispatched event's row) appears, and the routine list
 * so a schedule routine's `lastStatus` refreshes. Never advances `nextRun`
 * (enforced server-side in run-routine).
 */
export function useRunRoutine() {
  const qc = useQueryClient();
  return useActionMutation<
    RunRoutineResult,
    { name: string; samplePayload?: Record<string, unknown> }
  >("run-routine", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_ROUTINE_RUNS_KEY });
      qc.invalidateQueries({ queryKey: LIST_ROUTINES_KEY });
    },
    onError: (err: unknown) => {
      toast.error(extractActionError(err, "Failed to run routine"));
    },
  });
}

/**
 * Deep-link to the chat thread a run created. Navigates to the chat surface and
 * dispatches `agent-chat:open-thread`, which the multi-tab chat consumes to open
 * (and switch to) that thread — even one not currently in the sidebar list,
 * because background runs create threads outside the visible recents. Mirrors
 * the Sidebar's own thread-open path so behaviour is identical.
 */
export function useOpenChatThread() {
  const navigate = useNavigate();
  return useCallback(
    (threadId: string) => {
      if (!threadId) return;
      navigateWithAgentChatViewTransition(navigate, "/");
      window.requestAnimationFrame(() => {
        window.dispatchEvent(
          new CustomEvent("agent-chat:open-thread", {
            detail: { threadId },
          }),
        );
      });
    },
    [navigate],
  );
}

/**
 * List the built-in routine templates the user can fork. Static for the life of
 * the process (a bundled catalog), so cached long and never auto-refetched.
 */
export function useRoutineTemplates() {
  return useActionQuery<ListRoutineTemplatesResult>(
    "list-routine-templates",
    {},
    { staleTime: 5 * 60_000 },
  );
}

/**
 * Fork a built-in template into the user's own routines. Invalidates the routine
 * list so the new routine appears immediately. Returns the created routine so
 * the caller can navigate straight to its edit page.
 */
export function useForkRoutine() {
  const qc = useQueryClient();
  return useActionMutation<
    ForkRoutineResult,
    { presetId: string; name?: string }
  >("fork-routine", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_ROUTINES_KEY });
    },
    onError: (err: unknown) => {
      toast.error(extractActionError(err, "Failed to fork template"));
    },
  });
}

/** Load a single routine (summary + instructions) for the edit form. */
export function useRoutine(name: string) {
  return useActionQuery<GetRoutineResult>(
    "get-routine",
    { name },
    { enabled: !!name },
  );
}

/** Create or update a routine. Invalidates the list + the edited routine. */
export function useSaveRoutine() {
  const qc = useQueryClient();
  return useActionMutation("save-routine", {
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_ROUTINES_KEY });
      qc.invalidateQueries({ queryKey: ["action", "get-routine"] });
    },
    onError: (err: unknown) => {
      toast.error(extractActionError(err, "Failed to save routine"));
    },
  });
}

/** Delete a routine. The action is exposed as DELETE. */
export function useDeleteRoutine() {
  const qc = useQueryClient();
  return useActionMutation("delete-routine", {
    method: "DELETE",
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: LIST_ROUTINES_KEY });
    },
    onError: (err: unknown) => {
      toast.error(extractActionError(err, "Failed to delete routine"));
    },
  });
}

interface SetEnabledVariables {
  name: string;
  enabled: boolean;
}

interface SetEnabledContext {
  previous: [readonly unknown[], unknown][];
}

/**
 * Toggle a routine's enabled flag optimistically: flip the cached list entry
 * immediately, roll back on error, and re-sync on settle. This is the §A1
 * "enabled 开关(乐观,失败回滚)" requirement.
 */
export function useSetRoutineEnabled() {
  const qc = useQueryClient();
  return useActionMutation<unknown, SetEnabledVariables>(
    "set-routine-enabled",
    {
      onMutate: async ({ name, enabled }): Promise<SetEnabledContext> => {
        await qc.cancelQueries({ queryKey: LIST_ROUTINES_KEY });
        const previous = qc.getQueriesData({ queryKey: LIST_ROUTINES_KEY });
        qc.setQueriesData<ListRoutinesResult>(
          { queryKey: LIST_ROUTINES_KEY },
          (old) => {
            if (!old?.routines) return old;
            return {
              ...old,
              routines: old.routines.map((routine) =>
                routine.name === name ? { ...routine, enabled } : routine,
              ),
            };
          },
        );
        return { previous };
      },
      onError: (err, _vars, context) => {
        const ctx = context as SetEnabledContext | undefined;
        if (ctx?.previous) {
          for (const [key, data] of ctx.previous) {
            qc.setQueryData(key, data);
          }
        }
        toast.error(extractActionError(err, "Failed to update routine"));
      },
      onSettled: () => {
        qc.invalidateQueries({ queryKey: LIST_ROUTINES_KEY });
      },
    },
  );
}

/** Strip the framework's "Action <name> failed:" prefix for a clean toast. */
function extractActionError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    return err.message.replace(/^Action [\w-]+ failed:\s*/, "");
  }
  return fallback;
}
