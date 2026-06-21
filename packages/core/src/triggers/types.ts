/**
 * Extended frontmatter for triggers (superset of JobFrontmatter).
 *
 * Stored as markdown resources under `jobs/` — reuses the same storage
 * and scheduler infrastructure. Event-triggered jobs are skipped by the
 * cron scheduler and dispatched by the event bus instead.
 */

export interface TriggerFrontmatter {
  schedule: string;
  enabled: boolean;
  /** "schedule" = cron-based (legacy jobs). "event" = fires on bus event. */
  triggerType: "schedule" | "event";
  /** For event triggers: the event name to subscribe to. */
  event?: string;
  /**
   * For cross-app event triggers (Phase A3 §1.5.23): the app id that emits the
   * event (e.g. "plan", "mail"). Empty/undefined = a same-process event
   * dispatched directly by this process's `handleEvent`. When set, the event is
   * delivered by the cross-process event-bridge poller pulling that app's
   * `event_log`.
   */
  sourceApp?: string;
  /** Natural-language condition evaluated by Haiku before dispatch. */
  condition?: string;
  /** "agentic" = full runAgentLoop. "deterministic" = fixed action set. */
  mode: "agentic" | "deterministic";
  /** Domain tag for filtering in per-template UIs. */
  domain?: string;
  createdBy?: string;
  orgId?: string;
  runAs?: "creator" | "shared";
  lastRun?: string;
  lastStatus?: "success" | "error" | "running" | "skipped";
  lastError?: string;
  nextRun?: string;
}

export interface TriggerDispatchContext {
  triggerName: string;
  triggerBody: string;
  meta: TriggerFrontmatter;
  eventPayload?: unknown;
}
