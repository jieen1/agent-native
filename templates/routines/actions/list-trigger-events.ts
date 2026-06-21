/**
 * list-trigger-events — surfaces the events an event-kind routine can subscribe
 * to, for the editor's event dropdown.
 *
 * Two sources are merged (Phase A3 §1.5.23, point 8):
 *  1. In-process registry — `listEvents()` from `@agent-native/core/event-bus`
 *     (`registry.ts:42`): the events registered in THIS process (built-ins like
 *     `test.event.fired` / `agent.turn.completed`, plus the routines app's own
 *     plugins). These carry no `sourceApp` (same-process).
 *  2. Cross-app catalogs — each discovered sibling app's
 *     `GET /_agent-native/events/catalog` (`plan.*`, `mail.*`, …). These are
 *     tagged with the emitting app's id as `sourceApp`; selecting one writes
 *     `sourceApp` into the routine frontmatter so the bridge poller delivers it.
 *
 * Aggregation is fan-out + `Promise.allSettled`: an unreachable sibling is
 * skipped, never failing the whole list (graceful degradation, §1.5.6). When
 * names collide, the in-process event wins (same-process dispatch is preferred).
 *
 * The event `payloadSchema` is a Standard Schema object and is NOT
 * JSON-serializable, so it is intentionally omitted. We return `name`,
 * `description`, optional `example`, best-effort `payloadKeys` (in-process
 * only), and `sourceApp` (undefined for in-process events).
 *
 * Usage:
 *   pnpm action list-trigger-events
 */

import { defineAction } from "@agent-native/core/action";
import { listEvents } from "@agent-native/core/event-bus";
import { discoverAgents } from "@agent-native/core/server/agent-discovery";
import { resolveA2ACallerAuth } from "@agent-native/core/a2a";
import { z } from "zod";

const APP_ID = "routines";

interface TriggerEventOption {
  /** Dotted event name, e.g. "agent.turn.completed". */
  name: string;
  /** Human-readable description for the dropdown / agent. */
  description: string;
  /** Example payload for the dry-run sample, when the event declares one. */
  example?: Record<string, unknown>;
  /** Advisory top-level payload field names (best-effort from a Zod shape). */
  payloadKeys?: string[];
  /**
   * Emitting app id for cross-app events (e.g. "plan", "mail"). Undefined for
   * same-process events. Selecting a cross-app event writes this into the
   * routine's `sourceApp` frontmatter.
   */
  sourceApp?: string;
}

/**
 * Best-effort extraction of top-level field names from a Standard Schema.
 * Only handles a plain Zod object (the shape used by the built-in events);
 * returns undefined for anything else. Never throws.
 */
function payloadKeysOf(schema: unknown): string[] | undefined {
  try {
    const def = (schema as { _def?: { shape?: unknown } } | undefined)?._def;
    const shape = def?.shape;
    const resolved = typeof shape === "function" ? shape() : shape;
    if (resolved && typeof resolved === "object") {
      const keys = Object.keys(resolved as Record<string, unknown>);
      return keys.length > 0 ? keys : undefined;
    }
  } catch {
    // Not a plain Zod object — payload keys are advisory only.
  }
  return undefined;
}

/**
 * Fetch one sibling app's event catalog. Returns [] on any failure (network,
 * non-2xx, malformed body) so the caller can `allSettled` over all apps
 * without one bad app failing the list.
 */
async function fetchSiblingCatalog(
  app: { id: string; url: string },
  token: string | undefined,
): Promise<TriggerEventOption[]> {
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(
      `${app.url.replace(/\/+$/, "")}/_agent-native/events/catalog`,
      { headers },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      events?: Array<{ name?: unknown; description?: unknown }>;
    };
    const events = Array.isArray(body.events) ? body.events : [];
    return events
      .filter(
        (e): e is { name: string; description: string } =>
          typeof e?.name === "string" && e.name.length > 0,
      )
      .map((e) => ({
        name: e.name,
        description:
          typeof e.description === "string" && e.description.length > 0
            ? `${e.description} (${app.id})`
            : `(${app.id})`,
        sourceApp: app.id,
      }));
  } catch {
    return [];
  }
}

export default defineAction({
  description:
    "List the framework bus events that an event-triggered routine can subscribe to — both this app's in-process events and the events emitted by sibling apps (cross-app, tagged with their source app id). Returns each event's name, description, an optional example payload, best-effort payload field names, and the optional sourceApp. Call this before creating an event routine to discover valid event names and sources.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    // 1. In-process events (same-process; no sourceApp).
    const inProcess: TriggerEventOption[] = listEvents().map((def) => ({
      name: def.name,
      description: def.description,
      example: def.example,
      payloadKeys: payloadKeysOf(def.payloadSchema),
    }));

    // 2. Cross-app catalogs from each discovered sibling app.
    const crossApp: TriggerEventOption[] = [];
    try {
      const agents = await discoverAgents(APP_ID);
      if (agents.length > 0) {
        let token: string | undefined;
        try {
          token = (await resolveA2ACallerAuth()).apiKey;
        } catch {
          token = undefined;
        }
        const settled = await Promise.allSettled(
          agents.map((agent) =>
            fetchSiblingCatalog({ id: agent.id, url: agent.url }, token),
          ),
        );
        for (const r of settled) {
          if (r.status === "fulfilled") crossApp.push(...r.value);
        }
      }
    } catch {
      // Discovery unavailable — in-process events still list.
    }

    // 3. Merge, in-process wins on name collision, then sort by name.
    const byName = new Map<string, TriggerEventOption>();
    for (const e of crossApp) byName.set(e.name, e);
    for (const e of inProcess) byName.set(e.name, e);
    const events = [...byName.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return { events };
  },
});
