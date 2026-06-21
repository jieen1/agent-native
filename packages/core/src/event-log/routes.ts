/**
 * H3 event handlers for the cross-process event bridge (Phase A3 §1.5.23).
 *
 * Mounted under `/_agent-native/*` by `core-routes-plugin`:
 *
 *   GET /_agent-native/event-log?since=<seq>&names=<csv>
 *       — owner-scoped pull of durable event_log rows for the bridge poller.
 *       Returns { events:[{seq,name,payload,emittedAt}], cursor:<maxSeq> }.
 *
 *   GET /_agent-native/events/catalog
 *       — in-process event registry (name + description) for the editor's
 *       cross-app event dropdown.
 *
 * Identity is resolved by `resolveRequestIdentity` (session cookie first, then
 * an A2A Bearer JWT). The poller from a sibling app authenticates with the JWT
 * signed by `resolveA2ACallerAuth`; an interactive browser uses the session.
 */

import {
  defineEventHandler,
  getMethod,
  getQuery,
  getHeader,
  setResponseStatus,
  createError,
  type H3Event,
} from "h3";
import { getSession } from "../server/auth.js";
import { listEvents } from "../event-bus/index.js";
import { readEventLog } from "./store.js";

/**
 * Resolve the caller's email from either an authenticated session cookie or an
 * inbound A2A Bearer JWT (signed with the shared A2A_SECRET). Returns null when
 * neither path yields an identity.
 */
async function resolveRequestIdentity(event: H3Event): Promise<string | null> {
  const session = await getSession(event).catch(() => null);
  if (session?.email) return session.email;

  const authHeader = getHeader(event, "authorization");
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (token) {
      try {
        const { verifyA2AToken } = await import("../a2a/server.js");
        const { email } = await verifyA2AToken(token, event);
        if (email) return email;
      } catch {
        // Malformed token / verification error → unauthenticated.
      }
    }
  }
  return null;
}

function requireIdentity(email: string | null): string {
  if (!email) {
    throw createError({ statusCode: 401, statusMessage: "Unauthenticated" });
  }
  return email;
}

function parseSince(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function parseNames(value: unknown): string[] | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const names = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length > 0 ? names : undefined;
}

function parseLimit(value: unknown, fallback = 200): number {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 500);
}

/** GET /_agent-native/event-log — owner-scoped durable event pull. */
export function createEventLogHandler() {
  return defineEventHandler(async (event: H3Event) => {
    const rawMethod = getMethod(event);
    if (rawMethod === "OPTIONS") {
      setResponseStatus(event, 204);
      return "";
    }
    const method = rawMethod === "HEAD" ? "GET" : rawMethod;
    if (method !== "GET") {
      setResponseStatus(event, 405);
      return { error: "Method not allowed" };
    }

    const owner = requireIdentity(await resolveRequestIdentity(event));
    const q = getQuery(event);
    return readEventLog(owner, {
      since: parseSince(q.since),
      names: parseNames(q.names),
      limit: parseLimit(q.limit),
    });
  });
}

/** GET /_agent-native/events/catalog — in-process event registry. */
export function createEventsCatalogHandler() {
  return defineEventHandler(async (event: H3Event) => {
    const rawMethod = getMethod(event);
    if (rawMethod === "OPTIONS") {
      setResponseStatus(event, 204);
      return "";
    }
    const method = rawMethod === "HEAD" ? "GET" : rawMethod;
    if (method !== "GET") {
      setResponseStatus(event, 405);
      return { error: "Method not allowed" };
    }

    // Same identity gate as event-log: the sibling-app poller / aggregator
    // reaches this with an A2A JWT, so keep auth consistent (no anonymous
    // catalog reads across the bridge).
    requireIdentity(await resolveRequestIdentity(event));

    const events = listEvents().map((def) => ({
      name: def.name,
      description: def.description,
    }));
    return { events };
  });
}
