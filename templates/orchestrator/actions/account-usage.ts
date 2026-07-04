// account-usage — the SINGLE global account-level subscription usage indicator.
//
// This is the ONLY place the orchestrator reads the managed Claude account's
// subscription usage from Anthropic. It powers ONE global indicator in the left
// sidebar (account-level, shown once — NOT per brain session). It replaces the
// brain page's old per-session 30s /oauth/usage poll.
//
// Fetch policy (deliberately gentle — this used to be ~2000 hits/day):
//   1. SQL-PERSISTED snapshot. The last snapshot is stored owner-scoped in the
//      framework settings store (`u:<email>:account-usage-snapshot`), so every
//      client shares it and it survives a process restart (no re-fetch on boot).
//   2. On a call, if the persisted snapshot is younger than REFRESH_INTERVAL_MS
//      (~12 min) and the caller didn't pass `refresh:true`, it is returned as-is
//      — no token read, no network. This is the on-demand + background path: the
//      sidebar mounts the indicator (on-demand) and refetches at most ~12 min.
//   3. Only when stale (or `refresh:true`) AND the managed account is connected
//      do we touch Anthropic. The `if (!token)` guard means a removed/suspended
//      credential makes ZERO outbound calls — it returns connected:false.
//   4. The token is refreshed (single-flight, only-if-near-expiry) immediately
//      before use, then oauth/usage + oauth/profile are fetched under a shared
//      single-flight promise so concurrent callers reuse one round-trip.
//   5. Stale-on-failure: a 429/network error returns the LAST persisted snapshot
//      flagged stale:true (never a fabricated number).

import { defineAction } from "@agent-native/core";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { getUserSetting, putUserSetting } from "@agent-native/core/settings";
import { z } from "zod";
import {
  refreshManagedTokenIfNeeded,
  readManagedAccessToken,
  oauthApiGet,
} from "../server/claude-login.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** How long a persisted snapshot is served before a background refresh. */
const REFRESH_INTERVAL_MS = 12 * 60 * 1000; // ~12 min (10–15 min window)
const FETCH_TIMEOUT_MS = 12_000;
/** Owner-scoped settings key holding the latest account-usage snapshot. */
const SNAPSHOT_KEY = "account-usage-snapshot";

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

/** The persisted (and returned) account-usage snapshot. */
interface AccountSnapshot {
  fetchedAt: string;
  fiveHour: WindowUsage | null;
  weekly: WindowUsage | null;
  limits: RawLimit[];
  planTier: string | null;
  plan: string | null;
}

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

/**
 * Fetch an oauth endpoint via {@link oauthApiGet}, which sends the CLI
 * User-Agent and routes through the host CONNECT proxy when configured. A bare
 * fetch here previously hit Cloudflare's 403 "Request not allowed" at the edge
 * (the container WAN IP is blocked), so usage was ALWAYS "temporarily
 * unavailable" regardless of token validity. Throws-to-false so the caller
 * falls back to its cached snapshot. Frequency is unchanged (12-min snapshot +
 * single-flight); only the transport is fixed.
 */
async function fetchJson(
  url: string,
  token: string,
): Promise<
  { ok: true; body: Record<string, unknown> } | { ok: false; status: number }
> {
  try {
    const body = (await oauthApiGet(
      url,
      token,
      FETCH_TIMEOUT_MS,
    )) as Record<string, unknown>;
    return { ok: true, body };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Single-flight the oauth round-trip so concurrent action calls (multiple tabs /
// the background refetch landing together) reuse ONE pair of network requests.
let fetchInFlight: Promise<AccountSnapshot | null> | null = null;

/**
 * Fetch oauth/usage + oauth/profile and build a snapshot. Returns null on a
 * usage-fetch failure (429 / network) so the caller serves the last persisted
 * snapshot flagged stale. Profile is secondary — a profile failure just leaves
 * planTier/plan null.
 */
async function doFetchAccount(token: string): Promise<AccountSnapshot | null> {
  const [usageRes, profileRes] = await Promise.all([
    fetchJson(USAGE_URL, token),
    fetchJson(PROFILE_URL, token),
  ]);
  if (!usageRes.ok) return null; // usage is required; let the caller go stale.

  const body = usageRes.body;
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

  let planTier: string | null = null;
  let plan: string | null = null;
  if (profileRes.ok) {
    const org = asRecord(profileRes.body.organization);
    planTier = strOrNull(org?.rate_limit_tier);
    plan = strOrNull(org?.plan ?? profileRes.body.plan);
  }

  return {
    fetchedAt: new Date().toISOString(),
    fiveHour: mapWindow(body.five_hour),
    weekly: mapWindow(body.seven_day),
    limits,
    planTier,
    plan,
  };
}

function fetchAccount(token: string): Promise<AccountSnapshot | null> {
  if (fetchInFlight) return fetchInFlight;
  fetchInFlight = doFetchAccount(token).finally(() => {
    fetchInFlight = null;
  });
  return fetchInFlight;
}

/** Read the owner's persisted snapshot, tolerating a malformed/absent row. */
async function readSnapshot(
  ownerEmail: string,
): Promise<AccountSnapshot | null> {
  let raw: unknown = null;
  try {
    raw = await getUserSetting(ownerEmail, SNAPSHOT_KEY);
  } catch {
    return null;
  }
  const r = asRecord(raw);
  if (!r || typeof r.fetchedAt !== "string") return null;
  return r as unknown as AccountSnapshot;
}

/** Shape a snapshot into the action response. */
function present(
  snap: AccountSnapshot,
  flags: { cached: boolean; stale: boolean },
) {
  return {
    available: true,
    connected: true,
    reason: null as string | null,
    fetchedAt: snap.fetchedAt,
    cached: flags.cached,
    stale: flags.stale,
    fiveHour: snap.fiveHour,
    weekly: snap.weekly,
    limits: snap.limits ?? [],
    planTier: snap.planTier ?? null,
    plan: snap.plan ?? null,
  };
}

export default defineAction({
  description:
    "GLOBAL account-level Claude subscription usage for the sidebar indicator: " +
    "the 5-hour and weekly limits (oauth/usage) and the plan tier (oauth/" +
    "profile). SQL-persisted owner-scoped and served from cache for ~12 min; " +
    "Anthropic is contacted only when the snapshot is stale (or refresh:true) " +
    "AND the managed account is connected. With no credential it makes zero " +
    "network calls and returns connected:false. On a rate-limit/fetch failure " +
    "the last snapshot is returned with stale:true (never fabricated). This is " +
    "account-level — NOT per brain session; pass refresh:true to force a fetch.",
  schema: z.object({
    /** Force a fresh fetch past the ~12-min freshness window (still token-guarded). */
    refresh: z.boolean().default(false),
  }),
  readOnly: true,
  http: { method: "GET" },
  run: async (args) => {
    const ownerEmail = getRequestUserEmail() ?? "local@localhost";
    const persisted = await readSnapshot(ownerEmail);

    // ── 1) Serve the persisted snapshot when it's fresh enough ───────────────
    const fresh =
      persisted != null &&
      Date.now() - Date.parse(persisted.fetchedAt) < REFRESH_INTERVAL_MS;
    if (fresh && !args.refresh) {
      return present(persisted, { cached: true, stale: false });
    }

    // ── 2) Stale (or forced) → may need a fetch. NO-FETCH GUARD FIRST. ───────
    const token = readManagedAccessToken();
    if (!token) {
      // No managed credential (removed / never connected / suspended). Make NO
      // outbound call. Report not-connected honestly (no fabricated numbers).
      return {
        available: false,
        connected: false,
        reason:
          "Managed Claude Code is not connected — connect it in Settings → Claude Code.",
        fetchedAt: persisted?.fetchedAt ?? null,
        cached: false,
        stale: false,
        fiveHour: null,
        weekly: null,
        limits: [],
        planTier: null,
        plan: null,
      };
    }

    // ── 3) About to USE the token → refresh only if near expiry (single-flight)
    await refreshManagedTokenIfNeeded().catch(() => {});
    const useToken = readManagedAccessToken() ?? token;

    // ── 4) Fetch (single-flight). On failure, serve the last snapshot stale. ─
    const fetched = await fetchAccount(useToken);
    if (!fetched) {
      if (persisted) return present(persisted, { cached: true, stale: true });
      return {
        available: false,
        connected: true,
        reason:
          "oauth/usage is temporarily unavailable (likely rate-limited); no cached value yet.",
        fetchedAt: null,
        cached: false,
        stale: false,
        fiveHour: null,
        weekly: null,
        limits: [],
        planTier: null,
        plan: null,
      };
    }

    // ── 5) Persist the fresh snapshot (owner-scoped) and return it. ──────────
    await putUserSetting(
      ownerEmail,
      SNAPSHOT_KEY,
      fetched as unknown as Record<string, unknown>,
    ).catch(() => {});
    return present(fetched, { cached: false, stale: false });
  },
});
