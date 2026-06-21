/**
 * Shared helpers for the Routines CRUD actions (Phase A1, schedule kind only).
 *
 * Single source of truth for:
 *  - the `name` slug rule (§1.5.15: file name slugged to `[a-z0-9-]+`),
 *  - the owner-scope resource read/list helpers (越权防护 = owner-scope reads;
 *    `authorizeJobMutation` is private/unexported in core, so A1 relies on
 *    owner-scoped `resourceGetByPath` / filtered `resourceListAllOwners`),
 *  - the `RoutineSummary` view-model returned to UI + agent,
 *  - frontmatter (de)serialization, which goes exclusively through
 *    `buildTriggerContent` / `parseTriggerFrontmatter` with an explicit
 *    `triggerType: "schedule"` (§1.5.8 — never `buildJobContent`).
 *
 * The underscore prefix keeps this file out of the generated action registry
 * (the scanner skips `_`-prefixed files), so it is a plain helper module rather
 * than an action.
 */

import {
  parseTriggerFrontmatter,
  type TriggerFrontmatter,
} from "@agent-native/core/triggers";
import {
  describeCron,
  isValidCron,
  nextOccurrence,
} from "@agent-native/core/jobs";
import {
  resourceGetByPath,
  resourceListAllOwners,
  type Resource,
} from "@agent-native/core/resources/store";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";

/** Prefix under which all routine/job resources live. */
export const JOBS_PREFIX = "jobs/";

/** Status the engine writes back to frontmatter after a run. */
export type RoutineRunStatus = "success" | "error" | "running" | "skipped";

/** A routine is either cron-scheduled or fires on a bus event. */
export type RoutineKind = "schedule" | "event";

/**
 * The view-model a Routine presents to the UI and the agent.
 *
 * Phase A2 adds the `event` kind: schedule routines carry cron-derived fields
 * (`schedule`, `describeCron`, `nextRun`); event routines carry `event` and an
 * optional NL `condition` and leave the cron fields empty. `mode` is always
 * `"agentic"` in A2 (deterministic lands in A4 and is not surfaced in the UI).
 */
export interface RoutineSummary {
  /** Slugged file name (`jobs/{name}.md` without prefix/extension). */
  name: string;
  /** `"schedule"` (cron) or `"event"` (bus event). */
  kind: RoutineKind;
  /** Raw 5-field cron expression. Empty string for event routines. */
  schedule: string;
  enabled: boolean;
  /** Human-readable cron, e.g. "Every weekday at 8:30 AM". Empty for events. */
  describeCron: string;
  /** Event name the routine subscribes to. Only set for event routines. */
  event?: string;
  /**
   * Emitting app id for a cross-app event routine (e.g. "plan", "mail").
   * Only set for event routines whose event comes from a sibling app; undefined
   * for same-process events. The cross-process bridge poller delivers events for
   * routines that carry this.
   */
  sourceApp?: string;
  /** Natural-language condition gating dispatch. Only set for event routines. */
  condition?: string;
  /** Execution mode. Always "agentic" in A2 (deterministic is A4). */
  mode: "agentic" | "deterministic";
  /** Optional grouping tag. */
  domain?: string;
  /** Engine-written last-run status, if the routine has ever run. */
  lastStatus?: RoutineRunStatus;
  /** ISO timestamp of the last run, if any. */
  lastRun?: string;
  /** Last error message, if the last run failed. */
  lastError?: string;
  /**
   * ISO timestamp of the next scheduled run. Prefers the engine-written
   * `nextRun`; falls back to a computed `nextOccurrence` for enabled schedule
   * routines. Always undefined for event routines.
   */
  nextRun?: string;
  updatedAt?: string;
}

/**
 * Resolve the current request's owner email, throwing a clear error when the
 * request is unauthenticated. All routine reads/writes are owner-scoped.
 */
export function requireOwnerEmail(): string {
  const owner = getRequestUserEmail();
  if (!owner) {
    throw new Error("No authenticated user — cannot access routines.");
  }
  return owner;
}

/**
 * Slug a display name into a safe routine file name: lowercase, `[a-z0-9-]+`,
 * collapsed/ trimmed dashes (§1.5.15). Returns "" when nothing usable remains.
 */
export function slugifyRoutineName(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

/** Build the resource path for a routine name. */
export function routinePath(name: string): string {
  return `${JOBS_PREFIX}${name}.md`;
}

/**
 * Resolve a free routine slug for `owner`, appending `-2`, `-3`, … to `base`
 * when the bare slug (or a lower suffix) is already taken (§1.5.15 同名避让).
 *
 * `base` is assumed to be a slug already (from `slugifyRoutineName`); each
 * candidate is re-slugged so the suffix can never produce an invalid name.
 * `getOwnerRoutineResource` returning `null` marks a free slot, and the read is
 * owner-scoped, so collisions are detected only against *this* user's routines.
 */
export async function uniqueRoutineName(
  owner: string,
  base: string,
): Promise<string> {
  if (!base) {
    throw new Error("Cannot derive a routine name from an empty base.");
  }
  if (!(await getOwnerRoutineResource(owner, base))) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const candidate = slugifyRoutineName(`${base}-${suffix}`);
    if (candidate && !(await getOwnerRoutineResource(owner, candidate))) {
      return candidate;
    }
  }
  throw new Error(`Could not find a free name for "${base}".`);
}

/** Extract the routine name from a `jobs/{name}.md` resource path. */
export function routineNameFromPath(path: string): string {
  return path.replace(/^jobs\//, "").replace(/\.md$/, "");
}

/** A schedule-kind routine is anything whose triggerType is not "event". */
export function isScheduleKind(meta: TriggerFrontmatter): boolean {
  return meta.triggerType !== "event";
}

/** An event-kind routine has triggerType "event" and a target event name. */
export function isEventKind(meta: TriggerFrontmatter): boolean {
  return meta.triggerType === "event";
}

/** Normalize the parsed triggerType to the app's RoutineKind. */
export function routineKind(meta: TriggerFrontmatter): RoutineKind {
  return meta.triggerType === "event" ? "event" : "schedule";
}

/**
 * Compute the next-run ISO timestamp for display: prefer the engine-written
 * value, otherwise derive it from the cron expression for enabled routines.
 */
function computeNextRun(meta: TriggerFrontmatter): string | undefined {
  // Event routines fire on a bus event, not a clock — they have no next run.
  if (isEventKind(meta)) return undefined;
  if (meta.nextRun) return meta.nextRun;
  if (!meta.enabled) return undefined;
  if (!meta.schedule || !isValidCron(meta.schedule)) return undefined;
  try {
    return nextOccurrence(meta.schedule).toISOString();
  } catch {
    return undefined;
  }
}

/** Map a parsed trigger frontmatter to the UI/agent view-model. */
export function toRoutineSummary(
  name: string,
  meta: TriggerFrontmatter,
  updatedAt?: string,
): RoutineSummary {
  const kind = routineKind(meta);
  return {
    name,
    kind,
    schedule: meta.schedule,
    enabled: meta.enabled,
    describeCron:
      kind === "schedule" && meta.schedule ? describeCron(meta.schedule) : "",
    event: kind === "event" ? meta.event : undefined,
    sourceApp: kind === "event" ? meta.sourceApp : undefined,
    condition: kind === "event" ? meta.condition : undefined,
    mode: meta.mode ?? "agentic",
    domain: meta.domain,
    lastStatus: meta.lastStatus,
    lastRun: meta.lastRun,
    lastError: meta.lastError,
    nextRun: computeNextRun(meta),
    updatedAt,
  };
}

/**
 * List the current owner's routines as view-models, sorted by name. Filters
 * `resourceListAllOwners("jobs/")` down to this owner and `.md` files.
 *
 * Phase A2: both schedule- and event-kind routines are returned. Pass
 * `{ kind }` to narrow to one kind (the schedule-only path is preserved for
 * callers that still want cron-only routines).
 */
export async function listOwnerRoutines(
  owner: string,
  options?: { kind?: RoutineKind },
): Promise<RoutineSummary[]> {
  const all = await resourceListAllOwners(JOBS_PREFIX);
  const summaries: RoutineSummary[] = [];
  for (const resource of all) {
    if (resource.owner !== owner) continue;
    if (!resource.path.endsWith(".md")) continue;
    const { meta } = parseTriggerFrontmatter(resource.content);
    if (options?.kind && routineKind(meta) !== options.kind) continue;
    summaries.push(
      toRoutineSummary(
        routineNameFromPath(resource.path),
        meta,
        new Date(resource.updatedAt).toISOString(),
      ),
    );
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/**
 * Back-compat alias for the schedule-only listing used by A1 callers/tests.
 * Prefer `listOwnerRoutines(owner)` for the full (both-kind) list.
 */
export async function listOwnerScheduleRoutines(
  owner: string,
): Promise<RoutineSummary[]> {
  return listOwnerRoutines(owner, { kind: "schedule" });
}

/**
 * Owner-scoped read of a single routine resource. Returns `null` when the
 * routine does not exist for this owner (which is also how cross-user access is
 * denied — another user's routine simply is not found under this owner).
 */
export async function getOwnerRoutineResource(
  owner: string,
  name: string,
): Promise<Resource | null> {
  return resourceGetByPath(owner, routinePath(name));
}
