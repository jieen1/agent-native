/**
 * Compile a briefing by fanning out to sibling app agents.
 *
 * This is the fan-out orchestrator (docs/CHIEF_OF_STAFF_DESIGN.md §6.1):
 *   1. discover sibling agents and resolve the wanted targets,
 *   2. insert a `compiling` placeholder row (so the panel can show a skeleton),
 *   3. `runFanout` — ask each sibling agent in parallel "what needs my
 *      attention today" (identity is signed inside runFanout, §1.5.5/§1.5.6),
 *   4. write the final row with the raw `sourcesJson` + a no-LLM
 *      `deterministicDigest` fallback `summaryMd` and a derived status.
 *
 * It does NOT call an LLM. The polished narrative is written separately by the
 * Chief-of-Staff agent via `update-briefing` (§4 D4 / §1.5.3). Because this is a
 * mutating (non-readOnly) action, the framework auto-emits an `action` change
 * event on success, so the today panel refetches within one poll interval —
 * there is no need to call `refresh-screen` here (§1.5.18 "自动刷新").
 *
 * Usage:
 *   pnpm action compile-briefing --kind=morning
 *   pnpm action compile-briefing --apps='["mail","calendar"]' --focus="board prep"
 */

import { randomUUID } from "node:crypto";
import { defineAction } from "@agent-native/core";
import { discoverAgents } from "@agent-native/core/server/agent-discovery";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import { getUserSetting } from "@agent-native/core/settings";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "../server/db/index.js";
import { runFanout, PER_APP_TIMEOUT_MS } from "../shared/fanout.js";
import { buildAppPrompt } from "../shared/app-prompts.js";
import {
  BRIEFING_SETTINGS_KEY,
  parseBriefingSettings,
} from "../shared/briefing-settings.js";
import { routeViaBrain } from "../shared/brain-routing.js";
import {
  defaultTitle,
  deriveStatus,
  deterministicDigest,
  todayLocalDate,
} from "../shared/digest.js";
import { MAX_BRIEFING_BYTES, byteLength } from "../shared/limits.js";
import type { BriefingSource } from "../shared/types.js";

const KIND = z.enum(["morning", "evening", "adhoc"]).default("adhoc");

/**
 * Cap the serialized `sourcesJson` at MAX_BRIEFING_BYTES as a final backstop.
 * Per-source caps already ran in runFanout; if the combined payload is still
 * too big, drop the longest "ok" responses' bodies (keeping their status rows)
 * until it fits. Defensive — normally never triggers.
 */
function capSourcesJson(sources: BriefingSource[]): string {
  let json = JSON.stringify(sources);
  if (byteLength(json) <= MAX_BRIEFING_BYTES) return json;

  // Trim from the longest responseText down, preserving structure + status.
  const trimmed = sources
    .map((s, i) => ({ s, i, len: s.responseText.length }))
    .sort((a, b) => b.len - a.len)
    .map((x) => x.i);

  const working = sources.map((s) => ({ ...s }));
  for (const idx of trimmed) {
    if (byteLength(json) <= MAX_BRIEFING_BYTES) break;
    if (!working[idx].responseText) continue;
    working[idx] = {
      ...working[idx],
      responseText: "[…dropped to fit briefing size limit]",
    };
    json = JSON.stringify(working);
  }
  return json;
}

/**
 * Resolve and run the brain-driven second-level fan-out (§6). Returns the extra
 * `BriefingSource[]` to merge in (empty when brain isn't a target, suggests no
 * new apps, or routing fails). Never throws — brain routing is additive and a
 * failure must not abort the main briefing.
 */
async function routeFromBrain(args: {
  brainIsTarget: boolean;
  focus: string | undefined;
  discovered: Awaited<ReturnType<typeof discoverAgents>>;
  alreadyWanted: string[];
  buildPrompt: (appId: string) => string;
}): Promise<BriefingSource[]> {
  if (!args.brainIsTarget) return [];
  const routed = await routeViaBrain({
    selfAppId: "chief-of-staff",
    focus: args.focus ?? "",
    discovered: args.discovered,
    alreadyWanted: args.alreadyWanted,
  });
  if (routed.targets.length === 0) return [];
  return runFanout({
    selfAppId: "chief-of-staff",
    targets: routed.targets,
    buildPrompt: args.buildPrompt,
    perAppTimeoutMs: PER_APP_TIMEOUT_MS,
  });
}

export default defineAction({
  description:
    "Compile a briefing by fanning out to sibling app agents (mail, calendar, brain, analytics by default) and asking each what needs the user's attention. Inserts a compiling row, gathers per-app replies in parallel, runs brain's second-level routing to pull in any additional downstream apps it owns, then writes the raw sources plus a fallback summary. Returns { briefingId, url, itemCount, status }. After calling this, write the polished narrative with update-briefing.",
  requiresAuth: true,
  schema: z.object({
    kind: KIND,
    apps: z
      .array(z.string())
      .optional()
      .describe(
        'App ids to include (e.g. ["mail","calendar"]). Omit to use the default set.',
      ),
    focus: z
      .string()
      .optional()
      .describe("Optional free-form focus to bias every app's question."),
    date: z
      .string()
      .optional()
      .describe("Briefing date YYYY-MM-DD. Omit for today (server-local)."),
  }),
  run: async ({ kind, apps, focus, date }) => {
    const ownerEmail = getRequestUserEmail();
    if (!ownerEmail) {
      throw new Error("compile-briefing requires an authenticated user.");
    }
    const orgId = getRequestOrgId();

    const briefingDate = date ?? todayLocalDate();
    const id = `brief_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const db = getDb();

    // Per-user settings (§Phase B3): default app set + per-app prompt overrides.
    // An explicit `apps` argument still wins (the agent can override settings),
    // but when omitted we use the user's enabledApps, falling back to the
    // default four-source set inside parseBriefingSettings.
    const settings = parseBriefingSettings(
      await getUserSetting(ownerEmail, BRIEFING_SETTINGS_KEY),
    );
    const buildPrompt = (appId: string): string =>
      settings.promptOverrides[appId] ?? buildAppPrompt(appId, kind, focus);

    // 1) Insert a compiling placeholder row. Ownable columns are set explicitly
    // (they are not auto-filled) so access checks scope this to the caller.
    await db.insert(schema.briefings).values({
      id,
      briefingDate,
      kind,
      title: defaultTitle(kind, briefingDate),
      summaryMd: "",
      sourcesJson: "[]",
      status: "compiling",
      focus: focus ?? null,
      createdAt,
      updatedAt: createdAt,
      ownerEmail,
      orgId: orgId ?? null,
      visibility: "private",
    });

    // 2) Resolve targets: wanted ∩ discovered. Wanted-but-undiscovered apps are
    // recorded as `skipped` sources (§1.5.6), never an error.
    const wanted = apps && apps.length > 0 ? apps : [...settings.enabledApps];
    const discovered = await discoverAgents("chief-of-staff");
    const targets = discovered.filter((a) => wanted.includes(a.id));
    const missing = wanted.filter(
      (appId) => !targets.some((t) => t.id === appId),
    );

    // 3) Fan out in parallel. Self-call protection relies on selfAppId (§1.5.5).
    const fanned = await runFanout({
      selfAppId: "chief-of-staff",
      targets,
      buildPrompt,
      perAppTimeoutMs: PER_APP_TIMEOUT_MS,
    });

    // 3b) Brain-driven second-level fan-out (§6). If brain is a first-level
    // target, ask it (via its search-everything delegation hints) which
    // downstream apps also own relevant data, then fan out to the ones we
    // discovered that aren't already covered. Failures are non-fatal: a brain
    // routing error never aborts the main fan-out (it just adds no sources).
    const secondLevel = await routeFromBrain({
      brainIsTarget: targets.some((t) => t.id === "brain"),
      focus,
      discovered,
      alreadyWanted: wanted,
      buildPrompt,
    });

    const sources: BriefingSource[] = [
      ...fanned,
      ...secondLevel,
      ...missing.map(
        (appId): BriefingSource => ({
          app: appId,
          prompt: "",
          responseText: "",
          deepLinks: [],
          status: "skipped",
          latencyMs: 0,
        }),
      ),
    ];

    // 4) Write the final row. summaryMd is the no-LLM fallback; the agent
    // overwrites it via update-briefing.
    const status = deriveStatus(sources);
    await db
      .update(schema.briefings)
      .set({
        sourcesJson: capSourcesJson(sources),
        summaryMd: deterministicDigest(sources),
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.briefings.id, id));

    return {
      briefingId: id,
      url: `/briefings/${id}`,
      itemCount: sources.filter((s) => s.status === "ok").length,
      status,
    };
  },
});
