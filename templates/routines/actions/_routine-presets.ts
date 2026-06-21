/**
 * Routine template library (Phase A5 §1.5.15) — the preset seeds the Templates
 * page lists and `fork-routine` copies into the current user's owner scope.
 *
 * Why a TypeScript constant module and NOT `jobs/*.md` files on disk:
 *  - The engine only ever reads routines from SQL (`resourceListAllOwners`); it
 *    never seeds from disk `jobs/*.md`. A disk preset would be invisible to the
 *    scheduler/dispatcher — "looks like a routine, never runs". So a preset must
 *    be materialized into the owner's SQL row at fork time, not shipped as a
 *    routine file.
 *  - Shipping seeds as a bundled string constant is bundler-safe: it travels in
 *    the server bundle with the source, with no `import.meta.url` / `readFileSync`
 *    of co-located assets (no other action in this app reads disk assets).
 *
 * A preset carries the trigger metadata as a `Partial<TriggerFrontmatter>` plus
 * the routine body. `fork-routine` fills in `createdBy`/`orgId`/`enabled` and
 * serializes through the engine's own `buildTriggerContent`, so a forked routine
 * round-trips identically to one created via `save-routine` (single serializer,
 * §1.5.8). The underscore prefix keeps this file out of the generated action
 * registry (the scanner skips `_`-prefixed files) — it is a plain data module.
 *
 * The library covers all three trigger classes so the Templates page exercises
 * each path:
 *   - `schedule`          — cron-scheduled, run via A2A from the scheduler tick.
 *   - `event-cross-app`   — fires on a sibling app's event via the cross-process
 *                           bridge (`sourceApp` set).
 *   - `deterministic`     — a single fixed step with no LLM (fenced ```json body).
 */

import type { TriggerFrontmatter } from "@agent-native/core/triggers";

/** The three trigger classes a preset can belong to, for grouping in the UI. */
export type RoutinePresetCategory =
  | "schedule"
  | "event-cross-app"
  | "deterministic";

/**
 * One preset routine in the template library.
 *
 * `frontmatter` is a partial of the engine's `TriggerFrontmatter` carrying only
 * the trigger-defining fields (no owner/org/run-state — those are filled at fork
 * time). `body` is the routine instruction body: natural language for agentic
 * presets, or a fenced ```json deterministic-step block for deterministic ones.
 */
export interface RoutinePreset {
  /** Stable id used by `fork-routine` and as the default slug source. */
  id: string;
  /** Human label shown in the Templates page. */
  displayName: string;
  /** One-line description of what the routine does. */
  description: string;
  /** Trigger class, for grouping/labelling in the UI. */
  category: RoutinePresetCategory;
  /** "schedule" or "event" — mirrors `TriggerFrontmatter.triggerType`. */
  triggerType: TriggerFrontmatter["triggerType"];
  /** "agentic" (full agent loop) or "deterministic" (single fixed step). */
  mode: TriggerFrontmatter["mode"];
  /** Trigger-defining frontmatter (no owner/org/run-state). */
  frontmatter: Partial<TriggerFrontmatter>;
  /** Routine body: NL instructions, or a fenced ```json deterministic step. */
  body: string;
  /**
   * Optional sample event payload for an event preset, surfaced so the "try it
   * once" dry-run has a realistic payload to evaluate the condition against.
   */
  sampleEventPayload?: Record<string, unknown>;
}

/**
 * The deterministic webhook step body. `hooks.example.com` and the
 * `${keys.STATUS_WEBHOOK}` placeholder are deliberately fake: the engine
 * substitutes the real secret + enforces the SSRF allowlist at run time, and the
 * security rules forbid hardcoding a real webhook URL anywhere (CLAUDE.md).
 */
const WEBHOOK_PING_STEP = `\`\`\`json
{
  "kind": "web-request",
  "method": "POST",
  "url": "https://hooks.example.com/\${keys.STATUS_WEBHOOK}",
  "headers": {
    "Content-Type": "application/json"
  },
  "body": "{\\"text\\":\\"daily status ping\\"}"
}
\`\`\``;

/**
 * The built-in routine template library. Covers all three trigger classes:
 *   1. `daily-briefing`        schedule        (agentic, A2A to chief-of-staff)
 *   2. `evening-recap`         schedule        (agentic, A2A to chief-of-staff)
 *   3. `unread-mail-triage`    schedule        (agentic, asks the mail app)
 *   4. `pr-recap-on-plan`      event-cross-app (agentic, sourceApp: plan)
 *   5. `daily-webhook-ping`    deterministic   (single fixed web-request)
 */
export const ROUTINE_PRESETS: readonly RoutinePreset[] = [
  {
    id: "daily-briefing",
    displayName: "Daily briefing",
    description:
      "Every weekday morning, ask the chief-of-staff app to compile your daily briefing and notify you.",
    category: "schedule",
    triggerType: "schedule",
    mode: "agentic",
    frontmatter: { schedule: "30 8 * * 1-5", domain: "briefing" },
    body: `Every weekday morning, ask the chief-of-staff app to compile my daily briefing and send it to me. Use the A2A invoke path to call the "chief-of-staff" agent with a prompt like "Compile today's briefing and notify me", passing my identity through. Summarize what it returned.`,
  },
  {
    id: "evening-recap",
    displayName: "Evening recap",
    description:
      "Every weekday evening, ask the chief-of-staff app to compile your end-of-day recap and notify you.",
    category: "schedule",
    triggerType: "schedule",
    mode: "agentic",
    frontmatter: { schedule: "30 18 * * 1-5", domain: "briefing" },
    body: `Every weekday evening, ask the chief-of-staff app to compile my end-of-day recap and send it to me. Use the A2A invoke path to call the "chief-of-staff" agent with a prompt like "Compile today's evening recap (kind=evening) and notify me", passing my identity through. Summarize what it returned.`,
  },
  {
    id: "unread-mail-triage",
    displayName: "Unread mail triage",
    description:
      "Every two hours, triage your unread mail into urgent / can-wait / ignore and summarize anything urgent.",
    category: "schedule",
    triggerType: "schedule",
    mode: "agentic",
    frontmatter: { schedule: "0 */2 * * *", domain: "mail" },
    body: `Every two hours during the day, ask the mail app for my unread messages from today, triage them into urgent / can-wait / ignore, and send me a short summary of anything urgent.`,
  },
  {
    id: "pr-recap-on-plan",
    displayName: "PR recap on new plan",
    description:
      "When the Plan app creates a new PR recap, summarize the highlights and notify you with a link.",
    category: "event-cross-app",
    triggerType: "event",
    mode: "agentic",
    frontmatter: {
      schedule: "",
      event: "plan.created",
      sourceApp: "plan",
      condition: "the plan is a merged-PR recap",
      domain: "plan",
    },
    body: `A new plan was just created in the Plan app. If it is a PR recap, summarize the recap and notify me with the highlights and a link.`,
    sampleEventPayload: {
      plan: { kind: "recap", title: "Merge PR #1234: Add fork-routine" },
    },
  },
  {
    id: "daily-webhook-ping",
    displayName: "Daily webhook ping",
    description:
      "Every morning, POST a fixed status ping to your webhook. Runs deterministically with no AI in the loop.",
    category: "deterministic",
    triggerType: "schedule",
    mode: "deterministic",
    frontmatter: { schedule: "0 9 * * *", domain: "webhook" },
    body: WEBHOOK_PING_STEP,
  },
];

/** Look up a preset by its id. Returns undefined when no preset matches. */
export function findRoutinePreset(id: string): RoutinePreset | undefined {
  return ROUTINE_PRESETS.find((preset) => preset.id === id);
}

/** Metadata shape returned to the UI/agent by `list-routine-templates`. */
export interface RoutinePresetSummary {
  id: string;
  displayName: string;
  description: string;
  category: RoutinePresetCategory;
  triggerType: TriggerFrontmatter["triggerType"];
  mode: TriggerFrontmatter["mode"];
  /** Cron expression for schedule presets; empty for event presets. */
  schedule: string;
  /** Subscribed event name for event presets; undefined otherwise. */
  event?: string;
  /** Emitting app id for cross-app event presets; undefined otherwise. */
  sourceApp?: string;
  /** Optional grouping tag. */
  domain?: string;
}

/** Project a preset to the metadata summary surfaced to UI + agent. */
export function toPresetSummary(preset: RoutinePreset): RoutinePresetSummary {
  return {
    id: preset.id,
    displayName: preset.displayName,
    description: preset.description,
    category: preset.category,
    triggerType: preset.triggerType,
    mode: preset.mode,
    schedule: preset.frontmatter.schedule ?? "",
    event: preset.frontmatter.event,
    sourceApp: preset.frontmatter.sourceApp,
    domain: preset.frontmatter.domain,
  };
}
