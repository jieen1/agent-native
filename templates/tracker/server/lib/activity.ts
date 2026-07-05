// Actor attribution for the `tracker_activities` feed (T-C fix).
//
// Every action's `run(args, ctx)` receives an optional second argument — the
// framework's `ActionRunContext` — carrying `ctx.caller`: the surface that
// invoked the call (`"tool"` for the in-app agent loop / sub-agents / A2A,
// or `"frontend"` | `"http"` | `"cli"` | `"mcp"` for a person operating the
// UI, a direct HTTP/CLI call, or an external MCP client). This mirrors the
// framework's own audit-log convention (`deriveActorKind` in
// `@agent-native/core`'s audit subsystem: `caller === "tool"` → agent,
// everything else → human) — see the `audit-log` skill.
//
// Several tracker actions are dual-surface: the agent calls them as tools AND
// the UI calls the very same action directly (e.g. `run-acceptance` and
// `decompose-epic` are both wired to UI buttons via `useActionMutation`, in
// addition to being agent tools). Hardcoding "human" or "agent" at the call
// site only matches whichever surface the author had in mind when the
// action was first written, and mislabels the other one. Deriving from
// `ctx.caller` keeps the activity feed correct no matter which surface
// actually called it.
import type { ActionRunContext } from "@agent-native/core/action";

export type TrackerActorKind = "agent" | "human";

/**
 * Resolve the actor kind for a `tracker_activities` row from the action's
 * run context.
 *
 * - `ctx.caller === "tool"` → `"agent"` — the in-app agent loop, sub-agents /
 *   agent teams, or A2A (all of which drive the same agent tool loop).
 * - Any other caller (`frontend`, `http`, `cli`, `mcp`) → `"human"` — a
 *   person operating the UI, a direct API/CLI call, or an external agent a
 *   person is driving over MCP. This matches the framework audit log's own
 *   convention.
 * - `ctx` is `undefined` when an action invokes another action's `run()`
 *   directly without forwarding its own `ctx` — a purely programmatic call
 *   with no resolvable surface. Default to `"agent"` there: it matches this
 *   column's own schema default (`actor_kind default 'agent'`) and is the
 *   safer assumption for an automated code path calling another action
 *   in-process, absent any evidence of a human surface.
 */
export function resolveActorKind(ctx?: ActionRunContext): TrackerActorKind {
  if (!ctx) return "agent";
  return ctx.caller === "tool" ? "agent" : "human";
}

/**
 * Resolve a human-readable actor name for the activity feed: the caller's
 * authenticated email for human-attributed rows, else the generic agent
 * label already used throughout this app's activity feed.
 */
export function resolveActorName(
  actorKind: TrackerActorKind,
  ownerEmail: string | null | undefined,
): string {
  return actorKind === "agent" ? "智能体" : ownerEmail || "用户";
}
