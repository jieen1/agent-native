// brain-usage — the live usage / model panel for the /brain page.
//
// Four real, official, live-proven data points (never fabricated):
//   1. Model      — the brain thread's captured init `system` event model id.
//   2. Context    — used (latest assistant usage) / window (result.modelUsage
//                   contextWindow), both persisted on the brain thread.
//   3. 5h + weekly — GET https://api.anthropic.com/api/oauth/usage (Bearer the
//                   managed accessToken) → five_hour / seven_day / limits[].
//   4. Plan tier  — GET https://api.anthropic.com/api/oauth/profile (Bearer) →
//                   organization.rate_limit_tier + plan.
//
// The oauth endpoints are themselves rate-limited (429 under rapid polling), so
// both responses are CACHED in-module: usage ~30s TTL, profile ~1h. On a 429 or
// fetch error we return the LAST cached value with `stale: true` — never a
// fabricated number. If nothing was ever fetched we return available:false with
// a clear reason. The page polls this at 30s (NOT the 1.5s transcript poll).

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getV3Db, v3Schema } from "../server/db/v3.js";
import { ensureBrainSchema } from "../server/db/brain-schema.js";
import {
  refreshManagedTokenIfNeeded,
  readManagedAccessToken,
} from "../server/claude-login.js";
import { getBrainModel } from "../server/brain/brain-model.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const USAGE_TTL_MS = 45_000; // 30–60s window; the endpoint 429s under rapid poll
const PROFILE_TTL_MS = 60 * 60 * 1000; // ~1h — tier/plan barely change
const FETCH_TIMEOUT_MS = 12_000;

type Severity = "normal" | "warning" | "critical";

interface WindowUsage {
  utilizationPct: number;
  resetsAt: string | null;
  severity: Severity;
}

interface RawLimit {
  kind: string | null;
  percent: number | null;
  severity: Severity;
  resetsAt: string | null;
  isActive: boolean;
}

interface UsageSnapshot {
  fetchedAt: string;
  fiveHour: WindowUsage | null;
  weekly: WindowUsage | null;
  limits: RawLimit[];
}

interface ProfileSnapshot {
  fetchedAt: string;
  planTier: string | null;
  plan: string | null;
}

// ── in-module caches (process-lifetime; TTL-gated) ──────────────────────────
let usageCache: UsageSnapshot | null = null;
let profileCache: ProfileSnapshot | null = null;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Normalize a severity string (or derive one from a percent) to our enum. */
function toSeverity(v: unknown, pct: number | null): Severity {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "critical" || s === "warning" || s === "normal") return s;
  if (pct != null) {
    if (pct >= 90) return "critical";
    if (pct >= 70) return "warning";
  }
  return "normal";
}

function mapWindow(node: unknown): WindowUsage | null {
  const r = asRecord(node);
  if (!r) return null;
  const pct = numOrNull(r.utilization);
  return {
    utilizationPct: pct ?? 0,
    resetsAt: strOrNull(r.resets_at ?? r.resetsAt),
    severity: toSeverity(r.severity, pct),
  };
}

/** A timed fetch that throws on non-2xx (so the caller falls back to cache). */
async function fetchJson(
  url: string,
  token: string,
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, body };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return the usage snapshot — from cache when fresh, else fetch oauth/usage.
 * On a fetch failure (429/error) return the last cached snapshot (the caller
 * marks it stale); when nothing was ever fetched return null.
 */
async function getUsage(
  token: string,
): Promise<{ snap: UsageSnapshot | null; stale: boolean; cached: boolean }> {
  if (
    usageCache &&
    Date.now() - Date.parse(usageCache.fetchedAt) < USAGE_TTL_MS
  ) {
    return { snap: usageCache, stale: false, cached: true };
  }
  const result = await fetchJson(USAGE_URL, token);
  if (!result.ok) {
    // 429 / network error → serve the last cached value, flagged stale.
    return {
      snap: usageCache,
      stale: usageCache != null,
      cached: usageCache != null,
    };
  }
  const body = result.body;
  const limitsRaw = Array.isArray(body.limits) ? body.limits : [];
  const limits: RawLimit[] = limitsRaw.map((l) => {
    const r = asRecord(l) ?? {};
    const pct = numOrNull(r.percent);
    return {
      kind: strOrNull(r.kind),
      percent: pct,
      severity: toSeverity(r.severity, pct),
      resetsAt: strOrNull(r.resets_at ?? r.resetsAt),
      isActive: r.is_active === true,
    };
  });
  usageCache = {
    fetchedAt: new Date().toISOString(),
    fiveHour: mapWindow(body.five_hour),
    weekly: mapWindow(body.seven_day),
    limits,
  };
  return { snap: usageCache, stale: false, cached: false };
}

/** Profile snapshot — cached ~1h. Same stale-on-failure semantics as usage. */
async function getProfile(
  token: string,
): Promise<{ snap: ProfileSnapshot | null; stale: boolean }> {
  if (
    profileCache &&
    Date.now() - Date.parse(profileCache.fetchedAt) < PROFILE_TTL_MS
  ) {
    return { snap: profileCache, stale: false };
  }
  const result = await fetchJson(PROFILE_URL, token);
  if (!result.ok) {
    return { snap: profileCache, stale: profileCache != null };
  }
  const body = result.body;
  const org = asRecord(body.organization);
  profileCache = {
    fetchedAt: new Date().toISOString(),
    planTier: strOrNull(org?.rate_limit_tier),
    plan: strOrNull(org?.plan ?? body.plan),
  };
  return { snap: profileCache, stale: false };
}

export default defineAction({
  description:
    "Live usage/model panel for the orchestrator brain: the brain's current " +
    "model + context fill (used/window/%), the 5-hour and weekly subscription " +
    "limits (from the official oauth/usage endpoint, cached 45s), and the plan " +
    "tier (oauth/profile, cached ~1h). All numbers are real; on a rate-limit/" +
    "fetch failure the last cached value is returned with stale:true (never " +
    "fabricated). Poll at ~30s. Pass a threadId to read that thread's model/" +
    "context; otherwise the latest thread is used.",
  schema: z.object({
    /** Read this thread's model/context; omit → the owner's latest thread. */
    threadId: z.string().optional(),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail();
    await ensureBrainSchema();
    const db = getV3Db();

    // ── 1) model + context from the brain thread ────────────────────────────
    let threadRow:
      | {
          id: string;
          model: string | null;
          contextWindow: number | null;
          contextUsed: number | null;
        }
      | undefined;
    const select = {
      id: v3Schema.brainThreads.id,
      model: v3Schema.brainThreads.model,
      contextWindow: v3Schema.brainThreads.contextWindow,
      contextUsed: v3Schema.brainThreads.contextUsed,
    };
    if (args.threadId) {
      const rows = await db
        .select(select)
        .from(v3Schema.brainThreads)
        .where(eq(v3Schema.brainThreads.id, args.threadId))
        .limit(1);
      threadRow = rows[0];
    } else if (ownerEmail) {
      // Latest thread that actually has a captured model (so a brand-new empty
      // thread doesn't blank the panel).
      const rows = await db
        .select(select)
        .from(v3Schema.brainThreads)
        .where(eq(v3Schema.brainThreads.ownerEmail, ownerEmail))
        .orderBy(desc(v3Schema.brainThreads.updatedAt))
        .limit(20);
      threadRow = rows.find((r) => r.model) ?? rows[0];
    }

    // The configured override (so the Select reflects a pending switch even
    // before the next turn re-captures the resolved init model).
    const configuredModel = await getBrainModel();
    const model = threadRow?.model ?? configuredModel ?? null;
    const window = threadRow?.contextWindow ?? null;
    const used = threadRow?.contextUsed ?? null;
    const contextPct =
      window && used != null && window > 0
        ? Math.min(100, Math.round((used / window) * 1000) / 10)
        : null;

    // ── 2) get a fresh managed token, then oauth/usage + oauth/profile ──────
    // Refresh first so a near-expiry token is rotated before the Bearer calls.
    await refreshManagedTokenIfNeeded().catch(() => {});
    const token = readManagedAccessToken();

    if (!token) {
      return {
        available: false,
        reason:
          "Managed Claude Code is not connected — connect it in Settings → Claude Code.",
        fetchedAt: null,
        cached: false,
        stale: false,
        model,
        configuredModel,
        context: { used, window, pct: contextPct },
        fiveHour: null,
        weekly: null,
        limits: [],
        planTier: null,
        plan: null,
      };
    }

    const [usage, profile] = await Promise.all([
      getUsage(token),
      getProfile(token),
    ]);

    const haveUsage = usage.snap != null;
    const stale = usage.stale || profile.stale;

    return {
      available: haveUsage,
      reason: haveUsage
        ? null
        : "oauth/usage is temporarily unavailable (likely rate-limited); no cached value yet.",
      fetchedAt: usage.snap?.fetchedAt ?? null,
      // `cached` = served from the in-module cache, not freshly fetched this call.
      cached: usage.cached,
      stale,
      model,
      configuredModel,
      context: { used, window, pct: contextPct },
      fiveHour: usage.snap?.fiveHour ?? null,
      weekly: usage.snap?.weekly ?? null,
      limits: usage.snap?.limits ?? [],
      planTier: profile.snap?.planTier ?? null,
      plan: profile.snap?.plan ?? null,
    };
  },
});
